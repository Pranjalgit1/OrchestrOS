# OrchestrOS Actual Execution Flow

This document describes code that currently executes. The current implementation is **Phase 1: Database and Job Management**.

## Flow: Docker Compose startup and database setup

Entry Point:
`docker compose up --build`

Sequence:

1. `compose.yaml` starts PostgreSQL and waits for `pg_isready`.
2. Compose runs the one-shot `database-setup` service from `backend/Dockerfile`.
3. `npm run db:setup --workspace backend` executes `prisma migrate deploy`.
4. Prisma applies unapplied SQL under `backend/prisma/migrations`.
5. `backend/prisma/seed.ts` upserts `worker-1`, `worker-2`, and `worker-3` without changing existing records.
6. Only after setup exits successfully does Compose start `backend`.
7. `backend/src/server.ts` validates configuration and starts Express on container port 4000.
8. Backend health calls Phase 1 tables through Prisma. Compose starts `frontend` only after health succeeds.
9. Vite serves the built frontend and proxies `/api` to the backend.
10. All published ports are bound to host loopback.

## Flow: Direct development startup

Entry Points:

- `docker compose up -d postgres`
- `npm run db:setup`
- `npm run dev:backend`
- `npm run dev:frontend`

Sequence:

1. PostgreSQL starts locally.
2. The developer applies migrations and the idempotent seed with `npm run db:setup`.
3. `tsx watch` executes `backend/src/server.ts`; `env.ts` loads and validates root `.env`.
4. Express listens at `http://127.0.0.1:4000` by default.
5. Vite listens at `http://127.0.0.1:5173` and proxies `/api` to Express.

## Flow: Frontend entry and health

Entry Point:
`frontend/src/main.tsx`

1. `index.html` loads `main.tsx`, which mounts `App.tsx` in React strict mode.
2. `App.tsx` calls `frontend/src/api.ts` once for `/api/health`.
3. Express forwards to `health.routes.ts`, then `health.service.ts`.
4. The service uses the shared Prisma client to count `Job`, `Worker`, `ResourceAllocation`, and `JobExecution` in one database transaction.
5. Existing tables and a reachable database return HTTP 200 with `database: "up"`.
6. Missing tables or an unavailable database return structured HTTP 503 with `database: "down"`.
7. The frontend preserves expected 503 payloads and renders a degraded state.

## Flow: API metadata

Entry Point:
`GET /api`

`backend/src/app.ts` returns the API name, `phase: 1`, and `status: "data-layer-ready"` without accessing PostgreSQL.

## Flow: Create job

Entry Point:
`POST /api/jobs`

Sequence:

1. `backend/src/modules/jobs/job.routes.ts`
2. `createJobSchema` in `job.schemas.ts`
3. `JobService.create()` in `job.service.ts`
4. `prismaJobRepository.create()` in `job.repository.ts`
5. Prisma `Job.create`
6. PostgreSQL `jobs`

Detailed Flow:

1. Express parses a JSON body limited to 16 KB.
2. The strict Zod schema accepts only name, predefined workload type, CPU millicores, memory MiB, estimated seconds, and priority.
3. Unknown fields such as status, command, image, assignment, and result are rejected with HTTP 400.
4. The service trims the name and forces status to `QUEUED`.
5. Prisma inserts the job; the route returns HTTP 201, a `Location` header, and the persisted job.

## Flow: List jobs

Entry Point:
`GET /api/jobs?status=<optional>&limit=<optional>`

1. The route validates optional required-state filtering and a limit from 1–100 (default 50).
2. The service calls the repository.
3. Prisma reads PostgreSQL in deterministic `createdAt`, then `id`, ascending order.
4. The route returns the job array. This is persistence order, not an implemented scheduling policy.

## Flow: Get job

Entry Point:
`GET /api/jobs/:id`

1. The route requires a UUID.
2. `JobService.getById()` calls the repository and Prisma unique lookup.
3. Existing jobs return HTTP 200; missing jobs return structured HTTP 404.

## Flow: Cancel queued job

Entry Point:
`POST /api/jobs/:id/cancel`

1. The route validates the UUID and calls `JobService.cancel()`.
2. The repository executes one conditional `updateMany` matching both ID and `QUEUED` status.
3. A match atomically sets `CANCELLED` and `cancelledAt`, then returns the updated job.
4. If no row changed, the service reads current state to distinguish outcomes.
5. Missing job returns HTTP 404.
6. Already-cancelled job returns HTTP 200 unchanged, making retries idempotent.
7. Terminal invalid transitions return HTTP 409 `INVALID_JOB_TRANSITION`.
8. Future-valid states that require runtime cleanup return HTTP 409 `JOB_NOT_CANCELLABLE`; Phase 1 does not pretend to stop containers or release resources.

## Flow: Create logical worker

Entry Point:
`POST /api/workers`

1. `worker.routes.ts` validates name, CPU capacity in millicores, and memory capacity in MiB.
2. Managed status and allocation counters are rejected.
3. `WorkerService.create()` forces `IDLE` and zero allocation.
4. The Prisma repository inserts the worker.
5. Duplicate names return HTTP 409 `WORKER_NAME_EXISTS`.
6. Success returns HTTP 201, a `Location` header, and the worker.

This creates a logical capacity record only; it does not provision a computer or run a container.

## Flow: List/get workers

Entry Points:

- `GET /api/workers`
- `GET /api/workers/:id`

The list repository reads workers ordered by name. ID lookup requires a UUID and returns HTTP 404 when absent. Neither endpoint changes capacity, status, heartbeat, or allocation.

## Flow: Error handling

1. Malformed JSON becomes HTTP 400 `MALFORMED_JSON`.
2. Bodies over 16 KB become HTTP 413 `PAYLOAD_TOO_LARGE`.
3. Strict Zod request failures become HTTP 400 `VALIDATION_ERROR` with field paths and messages.
4. Typed application errors become their defined 404/409 response.
5. Unknown routes become HTTP 404 `ROUTE_NOT_FOUND`.
6. Unexpected errors are logged server-side and become generic HTTP 500 `INTERNAL_ERROR` without internal details.

## Flow: Backend shutdown

On `SIGINT` or `SIGTERM`, `server.ts` prevents duplicate shutdown, drains the HTTP server, disconnects Prisma, and exits with a status reflecting close success.

## Not implemented in Phase 1

| Required flow | Planned phase |
| --- | --- |
| Automated seeded workload generation and patterns | Phase 2 |
| Concurrent queue claim and FCFS/SJF/Priority/Round Robin scheduling | Phase 3 |
| First Fit, Least Loaded, and Resource-Aware placement | Phase 4 |
| Transactional reservation, row locking, rollback, and release | Phase 5 |
| Controlled Docker workload execution and cleanup | Phase 6 |
| Runtime metric collection and dashboard data | Phase 7 |
| Reactive autoscaling control loop | Phase 8 |
| Heartbeat failure detection and recovery/requeue | Phase 9 |
| Historical feature generation and ML prediction | Phase 10 |
| ML-assisted proactive autoscaling | Phase 11 |
| Reproducible experiment execution and comparison | Phase 12 |

The schema contains allocation and execution tables, but no Phase 1 code writes to them.
