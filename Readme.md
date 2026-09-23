# OrchestrOS

**Intelligent Container Orchestration with Resource-Aware Scheduling & Autoscaling**

OrchestrOS is a Kubernetes-inspired local container orchestration prototype for controlled computational workloads. It runs on one physical development machine with logical workers, PostgreSQL-backed state, and a modular TypeScript backend.

> **Current implementation:** deterministic workload batches, persistent jobs/workers, controlled lifecycle management, exact batch reuse, policy-based scheduling (FCFS, SJF, Priority, Round Robin), resource-aware placement decisions (First Fit, Least Loaded, Resource-Aware), transaction-safe reservation and release with row-level locking, controlled Docker execution of the five predefined workloads with recorded results, live operational monitoring with recorded utilization history, and a browser-first control interface that drives the full backend pipeline. Autoscaling, recovery, runtime cancellation, experiments, and ML do not run yet.

## System boundary

Logical workers are resource-capacity records on one machine—not physical nodes, VMs, cloud hosts, or separate computers. OrchestrOS is not Kubernetes, a cloud platform, an ML-only project, or a basic scheduling simulator.

## Current flow

```text
Generate or reuse controlled workload
              |
              v
WorkloadBatch + QUEUED Jobs  ->  PostgreSQL
              |
              v
Scheduler (FCFS / SJF / Priority / Round Robin)
              |
              v
      SCHEDULED Jobs
              |
              v
Placement (First Fit / Least Loaded / Resource-Aware)
              |
              v
   Job assigned to a logical worker
              |
              v
Transactional reservation (row lock + recheck)
              |
              v
     Capacity committed to the job
              |
              v
Controlled container (limits = reservation, no network)
              |
              v
Recorded result + capacity released in one transaction
              |
              v
   Metrics derived from those same records
```

Target orchestration remains:

```text
Generator -> Queue -> Scheduler -> Placement -> Transactional Reservation
  -> Docker Execution -> Monitoring -> Resource Release
```

Every stage above now runs. Autoscaling is the remaining link.

## Implemented capabilities

- React/Vite status dashboard and modular Express API
- PostgreSQL/Prisma migrations and startup migration gate
- Job and logical-worker create/read APIs
- All required job states and controlled queued cancellation
- Three idempotently seeded logical workers
- Deterministic generator version `v1` with no random-number dependency
- Exact counts: 10, 25, 50, or 100 jobs
- Patterns: `LIGHT`, `MEDIUM`, `HEAVY`, `CONSTANT`, `BURST`, `INCREASING`, `DECREASING`, `PERIODIC`, and `CUSTOM`
- `SUDDEN_BURST` input alias normalized to `BURST`
- Controlled CPU, matrix, sorting, data-processing, and sleep workloads
- Atomic batch/job persistence and exact persisted-batch reuse
- Planned arrival offsets/timestamps that gate scheduling eligibility
- FCFS, SJF, Priority (with aging), and Round Robin scheduling
- Concurrency-safe job claiming that cannot double-schedule
- Persisted scheduling decisions: policy, timestamp, quantum, and round count
- First Fit, Least Loaded, and Resource-Aware placement with CPU/memory accounting
- Eligibility that blocks placement when resources are insufficient
- One controlled workload image with no configurable image, command, or environment
- Containers limited to exactly the CPU and memory the job reserved
- Recorded exit codes, captured output, and reproducible result checksums
- Outcome recording and capacity release in one transaction
- Live metrics derived from the authoritative records, so they cannot drift
- Job lifecycle timings with p95, throughput, and success rate
- Sampled utilization history with retention pruning
- A live dashboard with cluster meters, worker table, and utilization sparkline
- Browser controls for generating workloads and running the whole pipeline
- Live job queue, selected-job pipeline trace, reservation evidence, Docker status, and activity log
- Structured validation/errors and readiness across the five authoritative models
- Unit, HTTP-boundary, PostgreSQL integration, and real-container tests

Scheduling selects **which job runs next** and moves it from `QUEUED` to `SCHEDULED`. It does not choose a worker, reserve resources, or start a container. The browser's orchestrator control endpoint composes the existing scheduler, placement, reservation, and execution services; it does not move these decisions into React.

## Browser-first demonstration

The React dashboard is the normal way to operate OrchestrOS. Open <http://localhost:5173>; no PowerShell or API knowledge is required for a mentor demonstration.

1. In **Control Panel**, choose the number of jobs, a seed, scheduler policy, and placement strategy.
2. For a concise demo, choose **Immediate — all jobs eligible at once (Custom)** and **Sleep — 4–10s each**.
3. Click **Demo Mode — generate 10 and run**, or click **Generate Workload** followed by **Run Orchestrator (auto)**.
4. The UI calls the backend facade, which drives `Scheduler -> Placement -> PostgreSQL Reservation -> Docker Execution` for each job.
5. Watch the pipeline counts, worker cards, live queue, selected-job facts, and activity log. Workers become `BUSY`, then return to `IDLE` when the backend releases their resources after completion.
6. Select a job to see its exact worker, reserved CPU/memory, transaction/row-lock explanation, container status, elapsed time, exit code, and checksum result. Use **Clear finished jobs** when the demonstration ends.

The control panel also exposes **Run Next Job**, **Run N Now**, pause/resume for auto mode, and per-stage controls under a selected job for teaching/debugging. They call existing backend APIs; React never performs scheduling, placement, transactions, or Docker work itself.

### The browser control API

| Browser action | Backend call | Backend owns |
| --- | --- | --- |
| Generate Workload | `POST /api/workloads/generate` | Deterministic generator + batch transaction |
| Run Next / Run N / Auto | `POST /api/orchestrator/run` | Scheduler, placement, reservation, Docker execution |
| Live queue/workers/pipeline | `GET /api/orchestrator/state` | Persisted state and derived pipeline stage |
| Clear finished jobs | `POST /api/orchestrator/clear-finished` | Safe terminal-only cleanup transaction |

The original individual APIs remain available for testing and debugging, but they are implementation details rather than the normal UI workflow.

## Scheduling policies

| Policy | Ordering |
| --- | --- |
| `FCFS` | Planned arrival order |
| `SJF` | Shortest estimated duration first |
| `PRIORITY` | Highest priority first, with aging to prevent starvation |
| `ROUND_ROBIN` | Fewest scheduling rounds first, with a recorded time quantum |

Priority uses higher numbers as more urgent (1–10). A queued job gains one effective priority level per full 60 seconds waited, capped at 10. Round Robin defaults to a 10-second quantum and accepts 1–3600.

Only jobs that are `QUEUED` with a planned arrival in the past are eligible.

## Placement strategies

Placement chooses **which worker** runs an already-scheduled job.

| Strategy | Selection |
| --- | --- |
| `FIRST_FIT` | First eligible worker in stable name order |
| `LEAST_LOADED` | Lowest current peak utilization |
| `RESOURCE_AWARE` | Best post-placement fit: `0.7 × peak + 0.3 × imbalance` |

A worker is eligible only when its status is `IDLE`, `ACTIVE`, or `BUSY` **and** it has enough free CPU and memory. Availability is capacity minus persisted reservations minus the requirements of jobs already placed there. When nothing fits, placement is refused with `INSUFFICIENT_RESOURCES` and the job stays unplaced.

Placement is **advisory**: it records the chosen worker on the job but does not reserve capacity or create allocation records. Reservation re-verifies availability under a row lock and may refuse a stale plan.

## Transaction-safe reservation

Reservation turns an advisory placement into a committed claim on capacity:

```text
BEGIN
  SELECT ... FROM workers WHERE id = $1 FOR UPDATE   -- row lock
  IF job already holds a RESERVED allocation THEN refuse (ALREADY_RESERVED)
  re-read capacity and allocated counters
  IF enough capacity THEN
      INSERT allocation (RESERVED)
      UPDATE worker counters, status = BUSY
  ELSE refuse without writing
COMMIT
```

The recheck happens **inside** the transaction while the lock is held, so the earlier placement decision is never trusted. Competing reservations for one worker serialise: the first commits and the second is refused with `INSUFFICIENT_RESOURCES`. The duplicate check runs before the capacity check, because a job's own reservation counts toward the worker's usage and would otherwise look like a shortfall.

Release reverses this under the same lock, marks the allocation `RELEASED`, and returns the worker to `IDLE` once nothing is reserved. Release is idempotent, so retries are safe.

Three layers prevent over-allocation:

1. Row lock plus in-transaction recheck
2. A partial unique index allowing one `RESERVED` allocation per job
3. A SQL `CHECK` constraint keeping allocated within capacity

### Resource APIs

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `POST` | `/api/resources/reserve` | Commit the job's CPU and memory under a row lock |
| `POST` | `/api/resources/release` | Free the job's reservation (idempotent) |
| `GET` | `/api/resources/allocations?jobId=&status=RESERVED` | Allocation audit history |

Reserve capacity for a placed job:

```json
{ "jobId": "00000000-0000-0000-0000-000000000000" }
```

The amount reserved is always the job's own requirement. Clients cannot choose the amount or the worker. Reservation does not start a container and leaves the job `SCHEDULED`; the allocation record proves capacity is held.

## Controlled Docker execution

A reserved job runs as exactly one container built from one image, `orchestros/workload-runner:v1`, whose entrypoint is a single fixed program. The image name is a constant in the code, not configuration. The container receives four environment variables and nothing else:

```text
ORCHESTROS_WORKLOAD_TYPE     one of the five workload types
ORCHESTROS_WORKLOAD_SIZE     the job's persisted size
ORCHESTROS_SEED              derived from the job name
ORCHESTROS_MEMORY_LIMIT_MIB  the container's memory limit
```

No command, script, image, formula, or extra variable can be supplied by a request. The runner validates its inputs and exits `64` before doing any work if they are wrong.

Each container runs with CPU and memory limits equal to the reservation, no network, a read-only root filesystem, no bind mounts, no privileges, all capabilities dropped, no privilege escalation, and a PID ceiling.

### Work ceilings

A workload size is an experiment input, not a runtime promise, so the runner bounds its own work and reports what it actually used as `effectiveSize`:

| Type | Ceiling | Size means |
| --- | ---: | --- |
| `CPU_INTENSIVE` | 50,000,000 | mixing iterations |
| `SORTING` | 2,000,000 | elements sorted |
| `DATA_PROCESSING` | 2,000,000 | records aggregated |
| `MATRIX_MULTIPLICATION` | 320 | matrix dimension |
| `SLEEP` | 120 | **seconds** |

Allocations are also sized from the container's memory limit, so a small reservation runs a smaller workload instead of being killed.

### Reproducibility

The seed is a hash of the job name, and generated names encode the batch seed and sequence. Reusing a batch therefore reproduces identical result checksums, which is the point of storing them.

### Lifecycle

```text
POST /api/executions/start
  -> lock the job row, verify SCHEDULED + placed + RESERVED
  -> SCHEDULED to RUNNING, insert the execution, commit
  -> create and start the container, return 202
  -> await exit (bounded by EXECUTION_TIMEOUT_SECONDS)
  -> record status, exit code, output, result AND release capacity in one transaction
  -> remove the container
```

| Container result | Execution and job |
| --- | --- |
| Exit 0 with a valid result line | `COMPLETED` |
| Exit 0 without one | `FAILED` |
| Non-zero exit, including an OOM kill | `FAILED` |
| Stopped for exceeding the timeout | `INTERRUPTED` |

Capacity is released on every path. A timeout is an interruption rather than a failure, because the orchestrator stopped the work.

### Execution APIs

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/executions/runtime` | Daemon version, allowed image, and whether it is built |
| `POST` | `/api/executions/start` | Run a reserved job and return before it finishes |
| `POST` | `/api/executions/:id/settle` | Record an exited container that was never settled |
| `GET` | `/api/executions?jobId=&status=&limit=` | Execution history with captured output |
| `GET` | `/api/executions/:id` | One execution |

Start an execution:

```json
{ "jobId": "00000000-0000-0000-0000-000000000000" }
```

Build the workload image before the first execution:

```powershell
npm run docker:images
```

> **Security note:** the backend container mounts the host Docker socket, which it needs to create workload containers. That is root-equivalent access to the host Docker daemon, accepted deliberately for a local single-machine prototype and recorded in [`docs/decision.md`](docs/decision.md). The frontend never receives it.

If the backend process dies mid-execution, the execution stays `RUNNING` and keeps its reservation; `POST /api/executions/:id/settle` is the recovery path until automatic reconciliation exists.

## Monitoring

Monitoring observes the orchestrator without participating in it. Almost every metric is **derived from the authoritative records at read time** rather than accumulated in counters, so a metric cannot drift out of step with the state it describes.

The one exception is utilization over time. Worker counters record only the present, so a history of them cannot be reconstructed later. `worker_samples` stores that history and nothing else.

### Measured stages

Five durations come from a job's own timestamps, each reported with count, average, minimum, maximum, and p95:

| Metric | Measured as |
| --- | --- |
| `queueWait` | `scheduledAt - arrivalAt` |
| `placementDelay` | `placedAt - scheduledAt` |
| `startDelay` | `startedAt - placedAt` |
| `execution` | `completedAt - startedAt` |
| `turnaround` | `completedAt - arrivalAt` |

A stage nothing has reached yet reports a zero count rather than being absent, and success rate is `null` before anything finishes rather than a misleading 0%.

### Sampling

One pass writes one row per worker sharing a single timestamp, so grouping on it reconstructs the cluster at that instant. A unique index makes a repeated pass a no-op. Pruning runs inside each pass, so history stays bounded.

```text
MONITORING_SAMPLE_INTERVAL_SECONDS=15   # 0 disables periodic sampling
MONITORING_SAMPLE_RETENTION_HOURS=24    # 0 keeps history forever
```

The sampler is the project's only background loop. It is started by `server.ts` rather than `app.ts`, so importing the app never starts a timer, and it writes only `worker_samples`.

### Monitoring APIs

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/monitoring/overview` | Cluster, workers, queue, reservations, and running containers |
| `GET` | `/api/monitoring/jobs?windowMinutes=60` | Lifecycle timings, throughput, and success rate |
| `GET` | `/api/monitoring/samples?windowMinutes=60` | Recorded utilization as cluster points over time |
| `GET` | `/api/monitoring/config` | Sampling interval and retention |
| `POST` | `/api/monitoring/sample` | Record one sampling pass immediately |

Windows accept 1 minute to 7 days and unknown query keys are rejected, so a read cannot ask the database to scan without limit.

### Dashboard

The **monitoring panel** reads metrics only; the separate orchestrator panel above it drives work through backend APIs. `Refresh` repeats the read on demand and `Capture sample` forces a data point, which is useful when demonstrating.

### Placement APIs

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/placement/capacity` | Per-worker capacity, load, and availability |
| `GET` | `/api/placement/preview?jobId=<uuid>&strategy=LEAST_LOADED` | Candidates, rejection reasons, and the selection |
| `POST` | `/api/placement/assign` | Persist the placement decision |

Assign a worker:

```json
{
  "jobId": "00000000-0000-0000-0000-000000000000",
  "strategy": "RESOURCE_AWARE"
}
```

### Scheduler APIs

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/scheduler/preview?policy=SJF&limit=20` | Show policy ordering without changing state |
| `POST` | `/api/scheduler/dispatch` | Schedule up to `count` jobs by policy |

Dispatch a batch under Round Robin:

```json
{
  "policy": "ROUND_ROBIN",
  "count": 5,
  "timeQuantumSeconds": 15
}
```

A `timeQuantumSeconds` value is rejected for any policy other than `ROUND_ROBIN`.

## Deterministic pattern contract

| Pattern | Behavior |
| --- | --- |
| `LIGHT` | Low resources; seeded 20–40 second gaps |
| `MEDIUM` | Medium resources; seeded 8–16 second gaps |
| `HEAVY` | High local resources; seeded 2–6 second gaps |
| `CONSTANT` | Varied medium resources; fixed 10 second gaps |
| `BURST` | Five jobs per shared offset; groups 30 seconds apart |
| `INCREASING` | Light→heavy resources and decreasing gaps |
| `DECREASING` | Heavy→light resources and increasing gaps |
| `PERIODIC` | Repeating profiles and `[2,2,2,20]` gaps |
| `CUSTOM` | Bounded ranges/types plus exact nondecreasing offsets |

For the same generator version, seed, count, canonical pattern, and custom configuration, ordered job specifications and offsets are identical. IDs and default start times are not deterministic. Golden-vector tests pin `v1` output, so changing the algorithm or pools requires a new generator version.

Each job samples its own type, CPU, memory, duration, and priority. For predefined patterns, `workloadSize` is derived from duration and CPU so the recorded size matches the estimated work; `SLEEP` size equals its duration.

## Workload APIs

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `POST` | `/api/workloads/generate` | Generate and atomically persist a batch |
| `GET` | `/api/workloads/:id` | Retrieve batch and jobs in sequence order |
| `POST` | `/api/workloads/:id/reuse` | Clone exact persisted specs into new queued jobs |

Generate a burst:

```json
{
  "seed": 12345,
  "count": 50,
  "pattern": "BURST",
  "startAt": "2026-09-21T12:00:00.000Z"
}
```

`startAt` is optional. Omit it to use the request time.

Custom generation additionally requires:

```json
{
  "seed": 42,
  "count": 10,
  "pattern": "CUSTOM",
  "custom": {
    "workloadTypes": ["SORTING", "DATA_PROCESSING"],
    "workloadSize": { "min": 1000, "max": 5000 },
    "cpuRequiredMillicores": { "min": 500, "max": 2000 },
    "memoryRequiredMiB": { "min": 256, "max": 1024 },
    "estimatedDurationSeconds": { "min": 5, "max": 30 },
    "priority": { "min": 1, "max": 10 },
    "arrivalOffsetsSeconds": [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]
  }
}
```

No command, script, arbitrary image, formula, or unbounded resource value is accepted.

## Other APIs

```text
GET  /api
GET  /api/health
POST /api/jobs
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/cancel
POST /api/workers
GET  /api/workers
GET  /api/workers/:id
```

Manual job creation accepts an optional `workloadSize` (default `1`) alongside controlled type, CPU, memory, estimated duration, and priority.

## Resource units and initial workers

CPU uses millicores (`1000` = one logical core); memory uses MiB (`1024` = one GiB).

| Worker | CPU | Memory | State |
| --- | ---: | ---: | --- |
| `worker-1` | 2000 | 2048 MiB | `IDLE` |
| `worker-2` | 4000 | 4096 MiB | `IDLE` |
| `worker-3` | 6000 | 8192 MiB | `IDLE` |

## Run locally

Prerequisites: Node.js 22.12+, npm 10+, and Docker Desktop with Compose.

```powershell
Copy-Item .env.example .env
npm install
npm run docker:up
```

`docker:up` builds the workload runner image first, so executions work immediately.

Open:

- Dashboard: <http://localhost:5173>
- API: <http://localhost:4000/api>
- Health: <http://localhost:4000/api/health>
- Container runtime: <http://localhost:4000/api/executions/runtime>

Stop without deleting database data:

```powershell
npm run docker:down
```

For direct development:

```powershell
docker compose up -d postgres
npm run db:setup
npm run docker:images
npm run dev:backend
```

Run `npm run dev:frontend` in a second terminal.

## Validation

```powershell
npm test

# Include real PostgreSQL integration tests after db:setup
$env:RUN_DATABASE_TESTS = "true"
npm test

# Also run tests that launch real containers, after npm run docker:images
$env:RUN_DOCKER_TESTS = "true"
npm test

npm run prisma:validate
npm run typecheck
npm run build
npm audit
docker compose config
```

## Safety and consistency

- PostgreSQL is authoritative; no Redis or Kafka is used.
- Batch metadata and all jobs commit or roll back together.
- Stored batch reuse copies exact specifications into independent lifecycle records.
- Job/resource/batch bounds are enforced by Zod and SQL constraints.
- One active reservation per job and execution/allocation identity remain database-enforced.
- Reservation locks the worker row and rechecks capacity inside the transaction, so concurrent jobs cannot over-allocate.
- A `CHECK` constraint keeps allocated resources within capacity even if application logic fails.
- Execution claims the job under a row lock, so concurrent starts cannot both launch a container.
- A job cannot execute without a committed reservation, and a container is limited to exactly that reservation.
- Recording a run's outcome and releasing its capacity happen in one transaction, on success and on failure alike.
- Settling a run is idempotent, so automatic and manual paths cannot double-release.
- Captured output, exit codes, and container ids are bounded by `CHECK` constraints.
- Only the backend reaches the Docker daemon; the frontend never receives that access.
- Monitoring never writes orchestration state; metrics are derived so they cannot contradict it.
- Sampled rows carry the same `CHECK` constraints as real accounting.
- Published ports bind to `127.0.0.1`.

## Remaining work

1. Reactive autoscaling
2. Heartbeat failure recovery, including reconciling executions orphaned by a backend restart
3. Quantum-based preemption and runtime job cancellation
4. Historical ML data and proactive scaling
5. Reproducible policy experiments and graphs

## Engineering memory

- [`docs/architecture.md`](docs/architecture.md): stable intended architecture
- [`docs/flow.md`](docs/flow.md): actual execution paths
- [`docs/decision.md`](docs/decision.md): decisions and trade-offs

Academic proposal assets remain under `docs/07a74a187970d58871c4261b7922ca06/`.
