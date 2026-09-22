# OrchestrOS Architecture

## 1. Purpose and boundary

OrchestrOS is a Kubernetes-inspired local container orchestration prototype. It runs on one physical development machine and will schedule controlled workloads, place them across logical workers, execute them in Docker, protect resource accounting with PostgreSQL transactions, recover interrupted work, and use forecasting to assist scaling.

Logical workers are database-backed capacity records, not physical computers, VMs, cloud nodes, or Docker hosts. Kubernetes, cloud provisioning, arbitrary commands/images, Redis, Kafka, GPU orchestration, complex service discovery, and production multi-tenancy are outside scope.

## 2. Architectural style and current implementation

The system is an npm-workspace monorepo with a React/Vite frontend, modular Express backend, Prisma persistence adapter, and local PostgreSQL supplied by Compose. Backend features use route, service, repository, and pure-domain boundaries inside one process.

The current implementation includes foundation startup, job/worker management, deterministic workload generation, scheduling, placement, transactional resource reservation, controlled Docker execution, and operational monitoring. Autoscaling, failure recovery, experiments, and ML remain future increments unless `docs/flow.md` says otherwise.

## 3. Components

| Component | Responsibility | Status |
| --- | --- | --- |
| Frontend | Show service state and implemented/planned capabilities | Status shell implemented |
| Backend API | Validate requests and expose modular operations | Implemented |
| Job manager/queue | Persist controlled jobs and enforce the create/read/cancel lifecycle | Implemented; claiming is done by the scheduler and by execution |
| Worker manager | Persist logical capacity and initial workers | Implemented management |
| Workload generator | Produce and persist deterministic controlled workload batches | Implemented |
| Scheduler | Select FCFS, SJF, Priority, or Round Robin job | Implemented |
| Placement | Select First Fit, Least Loaded, or Resource-Aware worker | Implemented (advisory) |
| Resource manager | Transactional CPU/memory reservation and release | Implemented |
| Container manager | Run predefined workloads under Docker limits | Implemented |
| Workload runner image | Execute one of five fixed programs and print a checksum | Implemented |
| Monitoring | Derive operational metrics and sample utilization over time | Implemented |
| Autoscaling/failure recovery/ML/experiments | Control and evaluation loops | Pending |

## 4. Job lifecycle and queue

Required job states are `CREATED`, `QUEUED`, `WAITING`, `SCHEDULED`, `RUNNING`, `COMPLETED`, `FAILED`, `INTERRUPTED`, and `CANCELLED`. Valid edges are centralized in `job.transitions.ts`. Manual and generated jobs enter PostgreSQL as `QUEUED`. Execution drives `SCHEDULED -> RUNNING` and then `RUNNING -> COMPLETED`, `FAILED`, or `INTERRUPTED`. Only queued cancellation is active; cancelling a running job waits for a later increment.

PostgreSQL is the only queue source of truth. There is no in-memory queue or Redis. `arrivalAt` and `arrivalOffsetSeconds` gate eligibility: the scheduler only considers queued jobs whose planned arrival has passed. No timer releases jobs on its own; every stage of the chain is driven by an explicit request.

## 5. Deterministic workload generation

`workload.generator.ts` is pure: it does not call Prisma, clocks, UUIDs, `Math.random`, or external services. Generator version `v1` uses a local Mulberry32 PRNG. Determinism covers the ordered workload specifications and arrival offsets for the same version, seed, count, canonical pattern, and custom configuration. Database IDs and default batch start times are intentionally not deterministic.

Allowed batch sizes are exactly 10, 25, 50, and 100. Each job independently samples its workload type, CPU, memory, estimated duration, and priority from the pattern's pools, so batches vary without short repeating cycles. Batches of 25 or more cover all five controlled workload types; a 10-job batch may omit one. The five controlled types are:

- CPU-intensive calculation
- Matrix multiplication
- Sorting
- Data processing
- Controlled sleep

Generated fields include workload type/size, CPU millicores, memory MiB, estimated duration, priority, sequence, and arrival offset. No command or Docker image can be generated or submitted.

For predefined patterns, `workloadSize` is **derived** from the sampled estimated duration and CPU request so the stored size reflects the work the estimate represents. `SLEEP` size equals its duration in seconds; other types scale by documented per-type factors. Custom batches keep the caller's explicit size range instead. This keeps future SJF scheduling and later container execution consistent with each other.

### Pattern contract (`v1`)

| Pattern | Arrival/resource behavior |
| --- | --- |
| `LIGHT` | Low resource pools; deterministic seeded 20–40 second gaps |
| `MEDIUM` | Medium pools; seeded 8–16 second gaps |
| `HEAVY` | High but locally bounded pools; seeded 2–6 second gaps |
| `CONSTANT` | Medium varied resources; fixed 10 second gaps |
| `BURST` | Groups of five jobs share an offset; groups are 30 seconds apart |
| `INCREASING` | Light→medium→heavy resources; gaps decrease toward 2 seconds |
| `DECREASING` | Heavy→medium→light resources; gaps increase toward 20 seconds |
| `PERIODIC` | Repeating resource profile and gap cycle `[2,2,2,20]` |
| `CUSTOM` | Caller supplies bounded ranges/types and exact nondecreasing offsets |

`SUDDEN_BURST` is accepted as an input alias and stored as canonical `BURST`.

A `WorkloadBatch` stores seed, count, pattern, generator version, normalized parameters, start time, and optional source-batch lineage. Batch and jobs are created in one Prisma transaction. Batch sequence is unique. Reuse clones persisted job specifications into new queued jobs rather than rerunning the current generator, so future generator changes cannot alter an experiment input.

## 6. Logical workers and resource units

CPU uses integer millicores (`1000` = one logical core) and memory uses MiB (`1024` = one GiB). The idempotent seed creates:

| Worker | CPU | Memory |
| --- | ---: | ---: |
| `worker-1` | 2000 | 2048 MiB |
| `worker-2` | 4000 | 4096 MiB |
| `worker-3` | 6000 | 8192 MiB |

Worker states are `STARTING`, `ACTIVE`, `IDLE`, `BUSY`, `STOPPING`, and `FAILED`. Current create/seed behavior uses `IDLE` and zero allocation.

## 7. Database and consistency

PostgreSQL contains `WorkloadBatch`, `Job`, `Worker`, `ResourceAllocation`, `JobExecution`, and `WorkerSample`. All six are written by running code. The first five are authoritative; `WorkerSample` is observational and is the only table monitoring writes. SQL constraints enforce resource bounds, valid batch sizes/offsets, complete batch identity, unique sequence, one active reservation per job, matching execution/allocation job-worker identity, one execution per allocation, one execution per job attempt, bounded captured output, byte-range exit codes, hex container ids, and the rule that a terminal execution records when it completed.

Compose runs deployment migrations and the worker seed before backend startup. Readiness queries the five authoritative models; it deliberately excludes `WorkerSample`, because losing observational history is not a reason to call the orchestrator unhealthy. Published ports are loopback-only.

Resource reservation is implemented and detailed in section 10: it begins a transaction, locks the worker row, rechecks CPU and memory inside the transaction, updates the allocation and worker counters atomically, and commits before any container could start.

## 8. Scheduler and placement separation

The scheduler answers only **which job runs next**. It never chooses a worker, reserves resources, or starts containers. Placement, reservation, and execution are separate components with their own endpoints, described in sections 9, 10, and 11.

`scheduler.policies.ts` is pure: it takes candidate jobs, a policy, and the current time, and returns an ordering. Persistence and claiming live in the repository and service.

### Eligibility

A job is a candidate only when its status is `QUEUED` and its planned `arrivalAt` has passed. Generated arrival metadata therefore gates scheduling rather than being decorative.

### Policies

| Policy | Ordering |
| --- | --- |
| `FCFS` | Planned arrival, then creation time, batch sequence, and ID |
| `SJF` | Shortest `estimatedDurationSeconds` first, then arrival order |
| `PRIORITY` | Highest effective priority first, then arrival order |
| `ROUND_ROBIN` | Fewest completed scheduling rounds first, then arrival order |

Priority uses **higher numbers as more urgent** (1 lowest, 10 highest). Starvation prevention is implemented as aging: a queued job gains one effective priority level for each full 60 seconds it has waited since arrival, capped at 10. Aging is computed from the passed-in time, so it stays a pure function.

Round Robin records a configurable time quantum (default 10 seconds, range 1–3600) on the scheduled job and increments `schedulingRounds`. Because a job that later returns to `QUEUED` carries a higher round count, it rotates behind fresher work instead of monopolising the scheduler. With no preemption yet, a first pass over never-scheduled jobs follows arrival order.

### Concurrency safety

Claiming uses a single conditional update that matches the job ID **and** `QUEUED` status. Two parallel dispatches therefore cannot schedule the same job: the loser observes zero updated rows, does not increment the round counter, and skips to the next candidate. Every transition is validated through the shared job transition policy.

Policy is supplied per request rather than stored as global state, so the same workload can be replayed under different policies for comparison.

## 9. Resource-aware placement

Placement answers only **which worker runs an already-scheduled job**. It never selects the job, changes job lifecycle state, or starts a container.

`placement.accounting.ts` is pure: it turns workers and their current load into capacity snapshots, evaluates eligibility, scores candidates, and selects one.

### Advisory decisions

Placement persists `assignedWorkerId`, `placementStrategy`, and `placedAt` on the job. It deliberately does **not** mutate worker allocation counters or create `ResourceAllocation` rows, because all real reservation is transaction-safe and owned by the resource manager. A placement decision is therefore a plan that reservation re-verifies while holding a row lock, and it may be refused if capacity was taken in the meantime.

### Resource accounting

For each worker:

```text
used      = persistedReserved + advisoryAssigned
available = capacity - used
```

`persistedReserved` comes from the worker's allocation counters, written only by transactional reservation. `advisoryAssigned` sums the CPU and memory requirements of jobs already placed on that worker in `SCHEDULED` or `RUNNING` state. Including the advisory part stops repeated placements from overcommitting the same worker in the plan and keeps load-sensitive strategies meaningful before reservation exists.

### Eligibility

A worker is eligible only when both hold:

- its status is `IDLE`, `ACTIVE`, or `BUSY` (`STARTING`, `STOPPING`, and `FAILED` cannot accept work)
- `availableCpu >= job.cpuRequiredMillicores` **and** `availableMemory >= job.memoryRequiredMiB`

Ineligible candidates are returned with explicit reasons. When no worker is eligible, placement is refused with `INSUFFICIENT_RESOURCES` and the job stays unplaced. A job that exactly fits is eligible.

### Strategies

Lower scores win; ties break on worker name for determinism.

| Strategy | Selection |
| --- | --- |
| `FIRST_FIT` | First eligible worker in stable name order |
| `LEAST_LOADED` | Lowest current peak utilization, `max(cpuUtil, memUtil)` |
| `RESOURCE_AWARE` | Lowest `0.7 × peakUtilAfter + 0.3 × |cpuUtilAfter − memUtilAfter|` |

`RESOURCE_AWARE` scores the worker **after** hypothetically placing the job, so it prefers placements that stay far from saturation and keep CPU and memory balanced. This can differ from `LEAST_LOADED`: a currently idle but small worker may be a worse fit than a busier worker with room to absorb the job evenly. The formula is intentionally small and explainable rather than an opaque model.

### Concurrency safety

Assignment uses one conditional update matching the job ID, `SCHEDULED` status, and a null worker. Parallel placements of the same job therefore assign it exactly once; losers receive `PLACEMENT_CONFLICT`.

## 10. Transaction-safe resource management

Reservation is the point where an advisory plan becomes a committed claim on capacity. It is the project's core DBMS demonstration.

### Reservation sequence

```text
BEGIN
  SELECT ... FROM workers WHERE id = $1 FOR UPDATE   -- row-level lock
  IF the job already holds a RESERVED allocation THEN
      refuse with ALREADY_RESERVED
  re-read capacity and allocated counters
  IF capacity - allocated >= request THEN
      INSERT resource_allocations (status = RESERVED)
      UPDATE workers SET allocated = allocated + request, status = BUSY
  ELSE
      refuse without writing
COMMIT
```

The recheck happens **inside** the transaction while the lock is held. A placement decision made earlier is advisory and may be stale, so reservation never trusts it. Concurrent reservations for the same worker serialise on the lock: the first commits, the second re-reads the updated counters and is refused with `INSUFFICIENT_RESOURCES`.

The duplicate check deliberately precedes the capacity check. A job that already holds a reservation is itself counted in the worker's allocated total, so checking capacity first would report a shortfall that does not exist and hide the real cause. The partial unique index still guards the insert, so a concurrent duplicate that passes the check is mapped to the same `ALREADY_RESERVED` outcome.

The amount reserved is always the job's own `cpuRequiredMillicores` and `memoryRequiredMiB`. Clients cannot choose an amount or a worker.

### Release sequence

```text
BEGIN
  find the RESERVED allocation for the job
  SELECT ... FROM workers WHERE id = $1 FOR UPDATE
  UPDATE resource_allocations SET status = RELEASED, releasedAt = now()
  UPDATE workers SET allocated = allocated - reserved
  IF allocated is now zero THEN status = IDLE
COMMIT
```

Release is idempotent: releasing an already released job returns the existing record without decrementing again. A job that never reserved returns `NO_ACTIVE_ALLOCATION`.

### Layered safety

Three independent mechanisms prevent over-allocation:

1. **Row lock plus in-transaction recheck** serialises competing reservations.
2. **A partial unique index** allows only one `RESERVED` allocation per job.
3. **A SQL `CHECK` constraint** (`allocated <= capacity`) is the last line of defence if application logic is ever wrong.

Atomicity means a failure at any step rolls back the allocation row, the counter update, and the worker status together, so no capacity is ever half-claimed.

Because reservations legitimately block on a row lock, the transaction uses a widened `maxWait` of 15s and `timeout` of 20s rather than Prisma's tighter defaults. `lockWaitMs` is measured and returned to make contention observable.

### Boundary

Reservation does not start a container and does not move the job to `RUNNING`; execution owns that transition. The allocation row is the authoritative record that capacity is held. Worker status becomes `BUSY` while any reservation exists and returns to `IDLE` when the last one is released.

## 11. Controlled Docker execution

Execution is the only component that talks to Docker. It runs a reserved job as one container, records what happened, and returns the reservation.

### The controlled workload image

`workload-runner/` builds a single image, `orchestros/workload-runner:v1`, whose entrypoint is one fixed program. The image name is a constant in `execution.contract.ts`, not configuration, so there is no code path that can run any other image. The program accepts no command, script, or formula; its entire input is four environment variables the backend constructs itself:

| Variable | Meaning |
| --- | --- |
| `ORCHESTROS_WORKLOAD_TYPE` | One of the five `WorkloadType` values |
| `ORCHESTROS_WORKLOAD_SIZE` | The job's persisted nominal size |
| `ORCHESTROS_SEED` | Derived from the job name |
| `ORCHESTROS_MEMORY_LIMIT_MIB` | The container's memory limit |

The runner validates all four before doing any work and exits `64` if any is missing, malformed, or out of range. On success it prints exactly one JSON line and exits `0`; a workload that throws exits `70`.

### Work ceilings and honest sizing

A nominal workload size is an experiment input, not a promise about runtime, so the runner bounds itself two ways: a per-type ceiling on work, and an allocation budget derived from the container's memory limit. It reports the size it actually used as `effectiveSize`, so a recorded result never overstates what ran.

| Type | Ceiling | Size means |
| --- | ---: | --- |
| `CPU_INTENSIVE` | 50,000,000 | mixing iterations |
| `SORTING` | 2,000,000 | elements sorted |
| `DATA_PROCESSING` | 2,000,000 | records aggregated |
| `MATRIX_MULTIPLICATION` | 320 | matrix dimension |
| `SLEEP` | 120 | **seconds** |

`SLEEP` is the one type whose size is a duration. Generated batches derive `workloadSize` from the estimate, so that is consistent, but a `CUSTOM` batch samples size independently and can therefore ask for a long sleep.

### Reproducibility

The seed is a 32-bit hash of the job name. Generated names encode the batch seed and sequence, so reusing a batch reproduces the same names, the same seeds, and therefore the same checksums, without storing an extra column. The runner uses the same Mulberry32 generator as the backend and excludes its measured duration from the checksum.

### Container restrictions

Every container is created with the same locked-down specification, all of it decided by `execution.runtime.ts`:

- CPU and memory limits set to exactly what the job reserved, with swap equal to memory
- `NetworkMode: none` and networking disabled
- Read-only root filesystem, no bind mounts, no privileges, `CapDrop: ALL`, `no-new-privileges`
- A PID ceiling, no restart policy, and the image entrypoint never overridden
- Labels carrying the job, execution, worker, and allocation ids

### Execution sequence

```text
claim   BEGIN; lock the job row; verify SCHEDULED + placed + RESERVED;
        SCHEDULED -> RUNNING; insert JobExecution(PENDING, attempt N); COMMIT
start   create and start the container; record its id; PENDING -> RUNNING
await   wait for exit, bounded by EXECUTION_TIMEOUT_SECONDS
settle  BEGIN; record status, exit code, captured output, result;
        set the job's terminal state; release the reservation; COMMIT
clean   remove the container
```

Claiming locks the job row so concurrent starts serialise: exactly one launches a container and the other is told the job was already started. Settling is idempotent, so the automatic path and a manual recovery call cannot both release capacity.

### Outcomes

| Container result | Execution | Job |
| --- | --- | --- |
| Exit 0 with a valid result line | `COMPLETED` | `COMPLETED` |
| Exit 0 with no valid result line | `FAILED` | `FAILED` |
| Non-zero exit, including an OOM kill | `FAILED` | `FAILED` |
| Stopped for exceeding the timeout | `INTERRUPTED` | `INTERRUPTED` |
| Container missing before it was settled | `FAILED` | `FAILED` |

A timeout is an interruption rather than a failure: the workload did not misbehave, the orchestrator stopped it, and `INTERRUPTED` keeps the job eligible for a later requeue. Capacity is released on every one of these paths.

### Known boundary

The container is awaited in the backend process. If that process dies mid-execution, the execution stays `RUNNING` and its reservation stays held; `POST /api/executions/:id/settle` is the recovery path today, and automatic reconciliation belongs to the failure-recovery increment. Cancelling a running job is not implemented yet.

## 12. Monitoring

Monitoring observes the orchestrator without participating in it. It never changes a job, a reservation, or a container.

### Derived, not accumulated

Almost every metric is computed from the authoritative records at read time rather than stored as it happens. Queue depth, cluster utilization, lifecycle timings, throughput, and per-worker activity are all questions the existing tables can already answer, so a counter that drifts out of step with reality cannot exist.

The one exception is utilization over time. Worker counters record only the present, so a history of them cannot be reconstructed after the fact. `WorkerSample` stores that history and nothing else.

### What is measured

Five stage durations come from a job's own timestamps:

| Metric | Measured as |
| --- | --- |
| `queueWait` | `scheduledAt - arrivalAt` |
| `placementDelay` | `placedAt - scheduledAt` |
| `startDelay` | `startedAt - placedAt` |
| `execution` | `completedAt - startedAt` |
| `turnaround` | `completedAt - arrivalAt` |

Each reports count, average, minimum, maximum, and p95. Prisma cannot aggregate the difference between two columns, so the durations are normalised into `(metric, seconds)` pairs in SQL and aggregated once, letting PostgreSQL compute the percentile instead of loading every row into the process. A stage nothing has reached yet reports a zero count rather than being absent, so a caller never has to distinguish "missing" from "nothing measured".

Timings cover jobs created inside the window; completion counts are anchored on when a job finished, which is what a rate should measure. The window start is echoed in the response so the denominator is never ambiguous.

### Sampling

One pass writes one row per worker, all sharing a `capturedAt`, so grouping on that timestamp reconstructs the cluster as it stood at that instant. The write is a single `INSERT ... SELECT`, and a unique index on `(workerId, capturedAt)` makes a repeated pass a no-op rather than a double count. Sample rows carry the same bounds as real accounting: capacity positive, allocated within capacity, counts non-negative.

Samples are observational, so they cascade with their worker instead of blocking its deletion the way authoritative records do.

### The only background loop

The sampler is the project's single timer. Everything else in OrchestrOS is driven by an explicit request. It is deliberately confined to observation, and it is started by `server.ts` rather than `app.ts`, so importing the Express app — as every test does — never starts a timer. Its interval is configurable and zero disables it, in which case history becomes opt-in through `POST /api/monitoring/sample`.

A pass already in flight blocks the next one, so a slow database cannot cause passes to pile up. A failed pass is logged and skipped: a missed observation must never take the orchestrator down. Pruning runs inside each pass, so history cannot grow without bound whether sampling is periodic or on demand.

### Dashboard

The frontend polls the overview, job metrics, and sample history every five seconds and renders cluster meters, a worker table, queue depth, throughput, lifecycle timings, running containers, and a utilization sparkline drawn without a charting dependency. It reads metrics only; it cannot start, stop, or modify work.

## 13. Scaling, failure recovery, and ML

Reactive scaling will precede ML-assisted forecasting. Heartbeat failure handling will reconcile resources and requeue recoverable work, including executions orphaned by a backend restart. These flows are not implemented yet.

## 14. API boundary

Express enforces a 16 KB body limit, strict Zod schemas, structured errors, one configured CORS origin, and generic internal errors. Implemented workload endpoints are:

- `POST /api/workloads/generate`
- `GET /api/workloads/:id`
- `POST /api/workloads/:id/reuse`

Implemented scheduler endpoints are:

- `GET /api/scheduler/preview`
- `POST /api/scheduler/dispatch`

Implemented placement endpoints are:

- `GET /api/placement/capacity`
- `GET /api/placement/preview`
- `POST /api/placement/assign`

Implemented resource endpoints are:

- `POST /api/resources/reserve`
- `POST /api/resources/release`
- `GET /api/resources/allocations`

Implemented execution endpoints are:

- `GET /api/executions/runtime`
- `POST /api/executions/start`
- `POST /api/executions/:id/settle`
- `GET /api/executions`
- `GET /api/executions/:id`

Implemented monitoring endpoints are:

- `GET /api/monitoring/overview`
- `GET /api/monitoring/jobs`
- `GET /api/monitoring/samples`
- `GET /api/monitoring/config`
- `POST /api/monitoring/sample`

Job and worker management endpoints remain available. A start request carries only a job id: the image, command, environment, limits, and timeout are all backend decisions, and a request containing any of them is rejected as an unrecognized key. The browser and clients never receive Docker daemon access.

## 15. Target data flow

```text
Workload Generator -> PostgreSQL-backed Queue -> Scheduler -> Placement
  -> Transactional Reservation -> Docker Execution -> Monitoring -> Release
```

Every stage above is implemented. Monitoring observes the chain rather than sitting inside it: release happens in the same transaction that records an execution's outcome.

Future supporting loops:

```text
Monitoring -> Reactive/ML-assisted Autoscaler -> Logical capacity
Heartbeat -> Failure Detector -> Reconciliation -> Requeue
Historical metrics -> ML Predictor -> Forecast -> Bounded scaling decision
```

The retained proposal visual is [`docs/image.png`](image.png); actual code paths are in [`docs/flow.md`](flow.md).
