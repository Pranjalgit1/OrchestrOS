# OrchestrOS Actual Execution Flow

This document describes code that currently executes. The current implementation includes deterministic workload generation, persistent batch reuse, and policy-based scheduling; worker placement and workload execution do not run.

## Flow: Startup and readiness

1. `compose.yaml` starts PostgreSQL and waits for `pg_isready`.
2. The one-shot `database-setup` service runs all committed Prisma migrations and idempotently seeds three workers.
3. Backend starts only after setup succeeds; frontend starts only after backend health succeeds.
4. `health.service.ts` queries `WorkloadBatch`, `Job`, `Worker`, `ResourceAllocation`, and `JobExecution` in one Prisma transaction.
5. A reachable complete schema returns HTTP 200; a database/schema failure returns structured HTTP 503.

Direct development remains: start PostgreSQL, run `npm run db:setup`, then run backend and frontend in separate terminals.

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
| First Fit, Least Loaded, and Resource-Aware placement | Later |
| Transactional reservation, row locking, rollback, and release | Later |
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
