# OrchestrOS Actual Execution Flow

This document describes code that currently executes. The current implementation includes deterministic workload generation, persistent batch reuse, policy-based scheduling, resource-aware placement decisions, transaction-safe resource reservation and release, and controlled Docker execution of the five predefined workloads. Monitoring, autoscaling, failure recovery, and runtime cancellation do not run.

## Flow: Startup and readiness

1. `compose.yaml` starts PostgreSQL and waits for `pg_isready`.
2. The one-shot `database-setup` service runs all committed Prisma migrations and idempotently seeds three workers.
3. Backend starts only after setup succeeds; frontend starts only after backend health succeeds.
4. `health.service.ts` queries `WorkloadBatch`, `Job`, `Worker`, `ResourceAllocation`, and `JobExecution` in one Prisma transaction.
5. A reachable complete schema returns HTTP 200; a database/schema failure returns structured HTTP 503.
6. Health checks the database only. Docker reachability is reported separately by `GET /api/executions/runtime`, so an absent daemon does not make the stack look unhealthy.

The backend container mounts the host Docker socket, which it needs to run workload containers. Building the workload image is a separate step: `npm run docker:images`, which `npm run docker:up` runs first.

Direct development remains: start PostgreSQL, run `npm run db:setup`, then run backend and frontend in separate terminals. On the host the backend reaches Docker through the platform default socket path (a named pipe on Windows).

## Flow: Generate workload batch

Entry Point:
`POST /api/workloads/generate`

Sequence:

1. `backend/src/modules/workloads/workload.routes.ts`
2. `generateWorkloadSchema` in `workload.schemas.ts`
3. `WorkloadService.generate()` in `workload.service.ts`
4. `generateWorkloadSpecs()` in `workload.generator.ts`
5. `prismaWorkloadRepository.createBatch()` in `workload.repository.ts`
6. Prisma interactive transaction
7. PostgreSQL `workload_batches` and `jobs`

Detailed Flow:

1. Express parses a body limited to 16 KB.
2. Strict Zod validation accepts seed, one of 10/25/50/100 counts, an approved pattern, optional ISO start time, and custom configuration only for `CUSTOM`.
3. `SUDDEN_BURST` normalizes to persisted `BURST`.
4. The service captures one start time and invokes pure generator version `v1`.
5. Mulberry32 samples each job's controlled type, CPU, memory, duration, and priority; predefined sizes are derived from duration and CPU, and sequence plus arrival offset come from the pattern.
6. The repository begins one Prisma transaction, creates batch metadata, bulk-creates every job as `QUEUED`, and reads the batch back in sequence order.
7. Each `arrivalAt` equals batch `startsAt` plus its offset. It is metadata only; no scheduler/timer acts on it.
8. Any insert/read failure rolls back both batch and all jobs.
9. Success returns HTTP 201, a `Location` header, and the batch with ordered jobs.

## Flow: Custom generation

The same generation route requires custom workload types, bounded integer ranges for size/CPU/memory/duration/priority, and exactly `count` nonnegative, nondecreasing offsets no greater than 86,400 seconds. Unknown fields, commands, images, unsupported counts, mismatched offsets, and unsafe ranges return HTTP 400.

## Flow: Read workload batch

Entry Point:
`GET /api/workloads/:id`

1. Route validates a UUID.
2. Service calls `findBatchById()`.
3. Prisma reads batch and jobs ordered by `batchSequence`.
4. Existing batch returns HTTP 200; missing batch returns HTTP 404.

## Flow: Reuse workload batch

Entry Point:
`POST /api/workloads/:id/reuse`

1. Route validates source UUID and optional new ISO start time.
2. Service loads the persisted source batch and ordered jobs.
3. It copies controlled request fields, sequence, and arrival offsets without calling the generator.
4. Repository atomically creates a new batch with `sourceBatchId` and new `QUEUED` jobs.
5. New `arrivalAt` values use the requested/new start time; specification and offsets remain identical.
6. Success returns HTTP 201 and a `Location` header. Missing source returns HTTP 404.

## Flow: Manual job management

`POST /api/jobs` strictly validates name, workload type, workload size, CPU, memory, duration, and priority, then persists `QUEUED`. `GET /api/jobs` lists by planned arrival and stable tie-breakers; this is not scheduler policy order. `GET /api/jobs/:id` reads one. `POST /api/jobs/:id/cancel` atomically changes only `QUEUED` to `CANCELLED`, is idempotent for retries, and rejects states needing future runtime cleanup.

## Flow: Worker management

`POST /api/workers` validates name and capacity and forces `IDLE` with zero allocation. `GET /api/workers` orders by name. `GET /api/workers/:id` reads one. These endpoints do not provision machines or alter heartbeat/allocation state.

## Flow: Error handling

Malformed JSON returns 400, bodies over 16 KB return 413, Zod failures return 400, typed domain failures return 404/409, unknown routes return 404, and unexpected errors are logged and returned as generic 500 responses.

## Flow: Shutdown

On `SIGINT` or `SIGTERM`, the backend prevents duplicate shutdown, drains HTTP connections, disconnects Prisma, and exits according to close success.

## Not implemented

| Required flow | Planned increment |
| --- | --- |
| Preemption that returns a running job to the queue after its quantum | Later |
| Worker counter updates and allocation records from a placement decision | Later |
| Transition of a reserved job to `RUNNING` when its container starts | Later |
| Controlled Docker workload execution and cleanup | Later |
| Runtime metric collection and dashboard data | Later |
| Reactive autoscaling | Later |
| Heartbeat failure detection and recovery | Later |
| ML dataset, prediction, and proactive scaling | Later |
| Experiment execution/comparison | Later |

The allocation/execution tables exist, but production code does not write them. Generated arrival metadata does not make jobs run or change state automatically.

## Flow: Preview scheduling order

Entry Point:
`GET /api/scheduler/preview?policy=<policy>&limit=<optional>`

Sequence:

1. `backend/src/modules/scheduler/scheduler.routes.ts`
2. `previewQuerySchema` in `scheduler.schemas.ts`
3. `SchedulerService.preview()` in `scheduler.service.ts`
4. `prismaSchedulerRepository.findEligible()` in `scheduler.repository.ts`
5. `orderByPolicy()` in `scheduler.policies.ts`

Detailed Flow:

1. The route requires one of `FCFS`, `SJF`, `PRIORITY`, or `ROUND_ROBIN`, plus an optional limit from 1–100 (default 20).
2. The service captures the current time once.
3. The repository reads up to 500 jobs that are `QUEUED` with `arrivalAt <= now`.
4. The pure policy function orders those candidates.
5. The route returns the policy, eligible count, and the limited ordered jobs.
6. No job state changes. This endpoint exists to demonstrate and compare policy ordering.

## Flow: Dispatch jobs by policy

Entry Point:
`POST /api/scheduler/dispatch`

Sequence:

1. `scheduler.routes.ts`
2. `dispatchSchema` in `scheduler.schemas.ts`
3. `SchedulerService.dispatch()`
4. `orderByPolicy()`
5. `assertJobTransition()` in `../jobs/job.transitions.ts`
6. `prismaSchedulerRepository.claim()`
7. PostgreSQL `jobs`

Detailed Flow:

1. Strict validation accepts a policy, an optional count from 1–100 (default 1), and an optional time quantum from 1–3600 seconds.
2. A time quantum is rejected with HTTP 400 for any policy other than `ROUND_ROBIN`; `ROUND_ROBIN` defaults to 10 seconds.
3. The service captures one timestamp, loads eligible candidates, and orders them by policy.
4. For each candidate up to the requested count, the shared transition policy validates `QUEUED -> SCHEDULED`.
5. The repository runs one conditional `updateMany` matching the job ID and `QUEUED` status, setting `SCHEDULED`, the policy, `scheduledAt`, the quantum, and incrementing `schedulingRounds`.
6. If the update matched zero rows, another dispatch already claimed that job; the service skips it and continues. The round counter is not incremented for a lost claim.
7. The route returns the policy, quantum, requested count, eligible count, scheduled count, and the scheduled jobs.
8. Scheduling assigns no worker, reserves no resources, and starts no container.

## Flow: Read worker capacity

Entry Point:
`GET /api/placement/capacity`

Sequence:

1. `backend/src/modules/placement/placement.routes.ts`
2. `PlacementService.capacity()` in `placement.service.ts`
3. `prismaPlacementRepository.listWorkers()` and `assignedLoadByWorker()`
4. `buildSnapshot()` in `placement.accounting.ts`

Detailed Flow:

1. The repository reads all workers ordered by name.
2. A Prisma `groupBy` sums CPU and memory requirements of jobs whose `assignedWorkerId` is set and whose status is `SCHEDULED` or `RUNNING`.
3. Each snapshot reports capacity, persisted reservations, advisory assigned load, remaining availability, CPU and memory utilization, and whether the worker can accept work.
4. No state changes.

## Flow: Preview placement

Entry Point:
`GET /api/placement/preview?jobId=<uuid>&strategy=<strategy>`

1. The route requires a UUID and one of `FIRST_FIT`, `LEAST_LOADED`, or `RESOURCE_AWARE`.
2. The service loads the job, returning HTTP 404 when it does not exist.
3. It builds capacity snapshots and calls the pure `evaluatePlacement()`.
4. The response lists every candidate with eligibility, human-readable reasons for rejection, and a score, plus the selected worker.
5. `selected` is `null` when no worker has enough free CPU and memory.
6. No state changes, so this endpoint can be used to compare strategies.

## Flow: Assign placement

Entry Point:
`POST /api/placement/assign`

Sequence:

1. `placement.routes.ts`
2. `assignPlacementSchema` in `placement.schemas.ts`
3. `PlacementService.assign()`
4. `evaluatePlacement()`
5. `prismaPlacementRepository.assign()`
6. PostgreSQL `jobs`

Detailed Flow:

1. Strict validation accepts only a job UUID and a strategy.
2. A job that does not exist returns HTTP 404.
3. A job that is not `SCHEDULED` returns HTTP 409 `JOB_NOT_PLACEABLE`; an already placed job returns HTTP 409 `JOB_ALREADY_PLACED`.
4. The service builds capacity snapshots and evaluates the strategy.
5. When no worker is eligible it returns HTTP 409 `INSUFFICIENT_RESOURCES` and the job remains unplaced.
6. Otherwise one conditional `updateMany` matching the job ID, `SCHEDULED` status, and a null worker sets `assignedWorkerId`, `placementStrategy`, and `placedAt`.
7. A zero-row update means a concurrent placement won, returning HTTP 409 `PLACEMENT_CONFLICT`.
8. The response returns the full evaluation plus the updated job.
9. Job status stays `SCHEDULED`: placement is not a lifecycle transition. Worker counters are untouched and no allocation row is created, so the decision is advisory until reservation re-verifies it under a row lock.

## Flow: Reserve resources

Entry Point:
`POST /api/resources/reserve`

Sequence:

1. `backend/src/modules/resources/resource.routes.ts`
2. `reserveResourcesSchema` in `resource.schemas.ts`
3. `ResourceService.reserve()` in `resource.service.ts`
4. `prismaResourceRepository.reserve()` in `resource.repository.ts`
5. PostgreSQL transaction with `SELECT ... FOR UPDATE`
6. `resource_allocations` and `workers`

Detailed Flow:

1. Strict validation accepts only a job UUID. The reserved amount and worker are never client-supplied.
2. A missing job returns HTTP 404.
3. A job whose status is not `SCHEDULED` returns HTTP 409 `JOB_NOT_RESERVABLE`.
4. A job with no `assignedWorkerId` returns HTTP 409 `JOB_NOT_PLACED`, so reservation cannot run before placement.
5. The repository opens an interactive transaction with a 15s start window and 20s timeout, because waiting on a row lock is expected.
6. A parameterized `SELECT ... FOR UPDATE` locks the worker row and `lockWaitMs` is recorded.
7. Still holding the lock, the transaction first checks whether the job already has a `RESERVED` allocation and returns HTTP 409 `ALREADY_RESERVED` if so. This precedes the capacity check because the job's own reservation is counted in the worker's usage, which would otherwise be reported as a false shortfall.
8. Capacity and allocated counters are re-read inside the transaction; the earlier placement decision is not trusted.
9. If `capacity - allocated` is short on CPU or memory, the transaction returns without writing and the route responds HTTP 409 `INSUFFICIENT_RESOURCES` with the observed free capacity.
10. Otherwise a `RESERVED` allocation row is inserted, the worker counters are incremented, and the worker is set `BUSY`.
11. A concurrent duplicate that slips past step 7 violates the partial unique index and is mapped to the same HTTP 409 `ALREADY_RESERVED`, leaving counters unchanged.
12. On commit the route returns HTTP 201 with the allocation, the updated worker, and `lockWaitMs`.
13. Any failure before commit rolls back the allocation row, the counter update, and the worker status together.
14. Job status stays `SCHEDULED`; no container is started.

## Flow: Release resources

Entry Point:
`POST /api/resources/release`

1. Validation accepts only a job UUID; a missing job returns HTTP 404.
2. A transaction looks for the job's `RESERVED` allocation.
3. When found, the worker row is locked, the allocation becomes `RELEASED` with `releasedAt`, and the worker counters are decremented.
4. When the worker holds no further reservations its status returns to `IDLE`.
5. When the job was already released, the existing record is returned with `alreadyReleased: true` and nothing is decremented again, so retries are safe.
6. When the job never reserved, the route responds HTTP 409 `NO_ACTIVE_ALLOCATION`.

## Flow: List allocations

Entry Point:
`GET /api/resources/allocations?jobId=&workerId=&status=&limit=`

The route validates optional job UUID, worker UUID, allocation status, and a limit from 1–100 (default 50), then returns matching allocation records newest first. This is the audit view of reservation history and changes no state.

## Flow: Inspect the container runtime

Entry Point:
`GET /api/executions/runtime`

1. `DockerContainerRuntime.describe()` calls the daemon's unversioned `/version`.
2. The reported API version is negotiated against what the adapter supports: never newer than `1.44`, never older than the daemon's minimum. A daemon that dropped every version the adapter knows fails loudly instead of sending unsupported requests.
3. The negotiated version is cached and used as the path prefix for every later call.
4. The route reports the server version, API version, the one allowed image, whether that image is present, and the socket path.
5. An unreachable socket returns HTTP 503 `DOCKER_UNAVAILABLE`. Nothing is created or changed.

## Flow: Execute a reserved job

Entry Point:
`POST /api/executions/start`

Sequence:

1. `backend/src/modules/executions/execution.routes.ts`
2. `startExecutionSchema` in `execution.schemas.ts`
3. `ExecutionService.start()` in `execution.service.ts`
4. `prismaExecutionRepository.claim()` in `execution.repository.ts`
5. `DockerContainerRuntime.start()` in `execution.runtime.ts`
6. `DockerEngineClient` in `docker.client.ts`, over the daemon socket
7. `job_executions`, `jobs`, `resource_allocations`, and `workers`

Detailed Flow:

1. Strict validation accepts only a job UUID. An `image`, `command`, `env`, or `timeoutSeconds` field is rejected with HTTP 400 `VALIDATION_ERROR` as an unrecognized key.
2. The workload image is verified once per process. A missing image returns HTTP 503 `WORKLOAD_IMAGE_MISSING` and names the build command; an unreachable daemon returns HTTP 503 `DOCKER_UNAVAILABLE`. Neither claims the job.
3. The claim transaction locks the job row with `SELECT ... FOR UPDATE`, so concurrent starts serialise instead of racing.
4. A missing job returns HTTP 404.
5. A job that is `RUNNING` and already owns a `PENDING` or `RUNNING` execution returns HTTP 409 `EXECUTION_ALREADY_STARTED`. A job that is `RUNNING` with no live execution is an orphan from an interrupted process and returns HTTP 409 `JOB_NOT_EXECUTABLE`, which is also the answer for any other non-`SCHEDULED` state or an unplaced job.
6. A job with no `RESERVED` allocation returns HTTP 409 `NO_ACTIVE_ALLOCATION`, so execution cannot run on uncommitted capacity.
7. Still inside the transaction, the job moves `SCHEDULED -> RUNNING` with `startedAt`, and a `JobExecution` row is inserted as `PENDING` with `attempt` one higher than the job's previous executions, bound to the live allocation. A unique-index collision is reported as `EXECUTION_ALREADY_STARTED`. The transaction commits before any container exists.
8. Outside the transaction, the container is created from `orchestros/workload-runner:v1` under the restrictions in `architecture.md` section 11, named `orchestros-exec-<executionId>`, with CPU and memory limits equal to the allocation and the four controlled environment variables. The seed is a hash of the job name.
9. If creation or start fails, the container is removed and the execution is finalised as `FAILED` with the daemon's message, which also releases the reservation. The route then returns the failure rather than leaving the job stuck `RUNNING`.
10. On success the container id is stored on both the execution and the job, the execution becomes `RUNNING`, and the route returns HTTP 202 with the execution, the container description, and the effective timeout. It does not wait for the workload.
11. A background task awaits the container's exit and then settles it through the same path as a manual settle.

## Flow: Settle a finished container

Entry Points:
The background task started by `POST /api/executions/start`, or `POST /api/executions/:executionId/settle`

Detailed Flow:

1. An unknown execution returns HTTP 404.
2. An execution that already reached a terminal state is answered from the database alone, with `alreadySettled: true` and `released: false`. Docker is not contacted, because the container has normally been removed by then.
3. An execution that never reached a container is recorded as `FAILED`.
4. If the daemon no longer knows the container while the execution is still open, the outcome is unrecoverable: the execution is recorded as `FAILED` with an explicit reason and a null exit code rather than a guessed one, and the reservation is released.
5. A container that is still running returns HTTP 409 `EXECUTION_STILL_RUNNING` from the manual endpoint; the background task instead waits for it.
6. The background task's wait is bounded by `EXECUTION_TIMEOUT_SECONDS`. On expiry OrchestrOS stops the container with a five second grace period and marks the run timed out.
7. The final state and both output streams are read. Each stream is demultiplexed from Docker's framed log format and capped at `EXECUTION_LOG_LIMIT_BYTES`, with a `[truncated]` marker when it was cut.
8. The outcome is classified: a timeout is `INTERRUPTED`; a non-zero exit is `FAILED` with a specific cause, including a distinct message for an OOM kill; a zero exit whose stdout does not match the runner contract is `FAILED`, not a success; a zero exit with a valid result line is `COMPLETED`.
9. One transaction then writes the execution's status, exit code, captured output, and failure reason, sets the job's terminal state and `completedAt`, stores the parsed result on the job when there is one, and releases the reservation by the shared `releaseAllocationWithin` path. Worker counters drop and the worker returns to `IDLE` when it holds nothing.
10. Finalisation is guarded by the execution's current status, so the automatic and manual paths cannot both release capacity.
11. The container is removed. A removal failure is logged but does not affect the committed outcome.

## Flow: Read executions

Entry Points:
`GET /api/executions?jobId=&workerId=&status=&limit=` and `GET /api/executions/:executionId`

The list route validates optional job UUID, worker UUID, execution status, and a limit from 1–100 (default 50), returning matching executions newest first. The detail route returns one execution or HTTP 404. Both are read-only and include the captured output, so a run's evidence is inspectable after the container is gone.

## Flow: Shutdown with work in flight

1. `SIGINT` or `SIGTERM` stops accepting connections.
2. `executionService.awaitPendingSettlements()` waits for containers already being awaited, so their outcomes are committed and their reservations released.
3. Prisma disconnects and the process exits.

If the process dies without this path, an execution stays `RUNNING` and keeps holding its reservation. `POST /api/executions/:id/settle` is the recovery path; automatic reconciliation is not implemented.
