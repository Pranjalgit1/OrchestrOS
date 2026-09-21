# OrchestrOS Architecture

## 1. Purpose and boundary

OrchestrOS is a Kubernetes-inspired local container orchestration prototype. It runs on one physical development machine and will schedule controlled workloads, place them across logical workers, execute them in Docker, protect resource accounting with PostgreSQL transactions, recover interrupted work, and use forecasting to assist scaling.

Logical workers are database-backed capacity records, not physical computers, VMs, cloud nodes, or Docker hosts. Kubernetes, cloud provisioning, arbitrary commands/images, Redis, Kafka, GPU orchestration, complex service discovery, and production multi-tenancy are outside scope.

## 2. Architectural style and current implementation

The system is an npm-workspace monorepo with a React/Vite frontend, modular Express backend, Prisma persistence adapter, and local PostgreSQL supplied by Compose. Backend features use route, service, repository, and pure-domain boundaries inside one process.

The current implementation includes foundation startup, job/worker management, and deterministic workload generation. Scheduling, placement, resource reservation, controlled Docker workloads, monitoring, autoscaling, failure recovery, experiments, and ML remain future increments unless `docs/flow.md` says otherwise.

## 3. Components

| Component | Responsibility | Status |
| --- | --- | --- |
| Frontend | Show service state and implemented/planned capabilities | Status shell implemented |
| Backend API | Validate requests and expose modular operations | Implemented |
| Job manager/queue | Persist controlled jobs and enforce create/read/cancel lifecycle | Implemented management; claiming pending |
| Worker manager | Persist logical capacity and initial workers | Implemented management |
| Workload generator | Produce and persist deterministic controlled workload batches | Implemented |
| Scheduler | Select FCFS, SJF, Priority, or Round Robin job | Pending |
| Placement | Select First Fit, Least Loaded, or Balanced worker | Pending |
| Resource manager | Transactional CPU/memory reservation and release | Pending |
| Container manager | Run predefined workloads under Docker limits | Pending |
| Monitoring/autoscaling/failure/ML/experiments | Control and evaluation loops | Pending |

## 4. Job lifecycle and queue

Required job states are `CREATED`, `QUEUED`, `WAITING`, `SCHEDULED`, `RUNNING`, `COMPLETED`, `FAILED`, `INTERRUPTED`, and `CANCELLED`. Valid edges are centralized in `job.transitions.ts`. Manual and generated jobs enter PostgreSQL as `QUEUED`. Only queued cancellation is active; runtime cancellation waits for container and resource cleanup.

PostgreSQL is the only queue source of truth. There is no in-memory queue or Redis. `arrivalAt` and `arrivalOffsetSeconds` are planned eligibility metadata; no timer releases jobs and no scheduler claims them yet.

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

PostgreSQL contains `WorkloadBatch`, `Job`, `Worker`, `ResourceAllocation`, and `JobExecution`. SQL constraints enforce resource bounds, valid batch sizes/offsets, complete batch identity, unique sequence, one active reservation per job, and matching execution/allocation job-worker identity. Allocation and execution records remain future runtime foundations.

Compose runs deployment migrations and the worker seed before backend startup. Readiness queries all five models. Published ports are loopback-only.

Future resource reservation must begin a transaction, lock the worker row, recheck CPU/memory inside the transaction, update allocation/worker/job atomically, and commit before container startup.

## 8. Scheduler and placement separation

The future scheduler answers **which job runs next** using FCFS, SJF, Priority, or Round Robin. It must consider only jobs whose `arrivalAt <= now`. Placement separately answers **which eligible worker runs it** using First Fit, Least Loaded, or explainable Balanced scoring. Neither responsibility is implemented by workload generation.

## 9. Docker, monitoring, scaling, failure, and ML

Only a future backend container manager may access Docker, and it will run predefined workloads with CPU/memory limits. Monitoring will collect only required operational/experiment metrics. Reactive scaling will precede ML-assisted forecasting. Heartbeat failure handling will reconcile resources and requeue recoverable work. These flows are not implemented yet.

## 10. API boundary

Express enforces a 16 KB body limit, strict Zod schemas, structured errors, one configured CORS origin, and generic internal errors. Implemented workload endpoints are:

- `POST /api/workloads/generate`
- `GET /api/workloads/:id`
- `POST /api/workloads/:id/reuse`

Job and worker management endpoints remain available. The browser and clients never receive Docker daemon access.

## 11. Target data flow

```text
Workload Generator -> PostgreSQL-backed Queue -> Scheduler -> Placement
  -> Transactional Reservation -> Docker Execution -> Monitoring -> Release
```

Future supporting loops:

```text
Monitoring -> Reactive/ML-assisted Autoscaler -> Logical capacity
Heartbeat -> Failure Detector -> Reconciliation -> Requeue
Historical metrics -> ML Predictor -> Forecast -> Bounded scaling decision
```

The retained proposal visual is [`docs/image.png`](image.png); actual code paths are in [`docs/flow.md`](flow.md).
