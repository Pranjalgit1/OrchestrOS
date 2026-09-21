# OrchestrOS Technical Decisions

This log records meaningful decisions made during implementation. The master specification is authoritative for mandated project behavior; those requirements are not rewritten here as invented historical choices.

## Decision: Use an npm-workspace modular monolith

Date:
2026-09-21

Status:
Accepted

Context:
Phase 0 needed separate frontend and backend boundaries while the approved architecture requires backend responsibilities to begin as modules in one process rather than independently deployed microservices.

Decision:
Use one private npm-workspace repository with `frontend` and `backend` packages. Keep Express assembly in `app.ts`, process lifecycle in `server.ts`, and feature code under `backend/src/modules`. Future scheduler, placement, resource, worker, container, monitoring, autoscaling, failure, workload, and experiment responsibilities will become modules in this backend before any independent deployment is considered.

Alternatives Considered:
- Multiple independently deployed backend microservices
- One unstructured package containing frontend and backend code
- Separate repositories

Reasoning:
Workspaces provide reproducible shared installation and independent package scripts. A modular monolith preserves component boundaries while avoiding service networking, deployment, and consistency complexity that is unnecessary on one development machine.

Consequences:
Local installation and cross-package validation are simple. Domain boundaries must be maintained through code structure and interfaces rather than network boundaries. Splitting a module into a service later would require a new decision and evidence that the added complexity is useful.

Affected Components:
- `package.json`
- `backend/`
- `frontend/`

## Decision: Prove Phase 0 with a database-backed health vertical slice

Date:
2026-09-21

Status:
Accepted

Context:
The repository had no executable code. Phase 0 required proof that the frontend, backend, Prisma, PostgreSQL, environment, and Docker foundation work without claiming future orchestration behavior exists.

Decision:
Implement `GET /api/health`. Express calls a health service, the service executes `SELECT 1` through Prisma, and the React foundation screen calls the endpoint through a Vite proxy. A missing database produces HTTP 503 and a degraded status rather than a false healthy response.

Alternatives Considered:
- Static health response that checks only Express
- Premature placeholder job and worker APIs
- Implementing Phase 1 database models during foundation work

Reasoning:
The chosen slice crosses every Phase 0 runtime layer and can be smoke-tested. It is real functionality but does not invent or mock later-phase features.

Consequences:
Database readiness is visible immediately and Compose can gate dependent services on it. The Prisma schema intentionally has no domain models or migration until Phase 1.

Affected Components:
- `backend/src/modules/health/`
- `backend/src/app.ts`
- `frontend/src/App.tsx`
- `frontend/src/api.ts`
- `compose.yaml`

## Decision: Use Docker Compose for the local application topology

Date:
2026-09-21

Status:
Accepted

Context:
The MVP is local-first and requires PostgreSQL plus repeatable application startup. It must not require Kubernetes, cloud infrastructure, or multiple machines.

Decision:
Define three Phase 0 services in `compose.yaml`: PostgreSQL, backend, and frontend. PostgreSQL uses a named volume and health check; the backend waits for database health; the frontend waits for backend health. The frontend uses Vite preview for the local prototype rather than adding a separate web server dependency. Direct host development remains supported.

Alternatives Considered:
- Require developers to install PostgreSQL directly
- Add Kubernetes manifests
- Add Nginx solely to serve the Phase 0 frontend

Reasoning:
Compose gives a reproducible local topology using the already-required Docker tooling. It adds no remote infrastructure and keeps host development available for fast iteration. Nginx would not add project value at this phase.

Consequences:
Docker Desktop must be running for one-command full-stack startup. Vite preview is suitable for the local prototype but is not presented as a production deployment architecture. The database persists until its named volume is explicitly removed.

Affected Components:
- `compose.yaml`
- `backend/Dockerfile`
- `frontend/Dockerfile`
- `.dockerignore`

## Decision: Pin a conservative compatible TypeScript dependency baseline

Date:
2026-09-21

Status:
Accepted

Context:
Phase 0 needed deterministic installs. Registry inspection showed newer major/prerelease lines, including a Prisma 8 release candidate and TypeScript 7, while the project had no compatibility reason to adopt them immediately.

Decision:
Pin exact package versions in each package manifest. Use React 19.2.0, Vite 8.3.0, TypeScript 5.9.3, Express 5.2.1, Prisma 6.12.0, and the exact supporting versions declared in the manifests. Require Node.js 22.12 or newer; container images use Node.js 24.13.0. Prisma scripts load the repository environment through pinned `dotenv-cli` 11.0.0.

Alternatives Considered:
- Open semver ranges
- Automatically select every current registry `latest` tag
- Adopt prerelease major versions

Reasoning:
Exact versions and a lockfile make college demonstrations reproducible. Initial validation found published high-severity advisories in Vite 7.2.2 and Prisma 6.19.0 transitive dependencies. Vite 8.3.0 fixes the reported development-server issues, while the registry audit recommends Prisma 6.12.0 as the non-vulnerable stable line. This avoids knowingly retaining vulnerable packages or adopting the Prisma 8 release candidate.

Consequences:
Updates are deliberate rather than automatic. Security or compatibility updates require editing manifests, validating the application, and recording a new decision when the change is major or architectural.

Affected Components:
- `package.json`
- `backend/package.json`
- `frontend/package.json`
- `package-lock.json`

## Decision: Defer domain tables and migrations to Phase 1

Date:
2026-09-21

Status:
Accepted

Context:
Phase 0 requires PostgreSQL and Prisma setup, while Phase 1 explicitly owns jobs, workers, allocations, executions, and their migrations. Adding speculative tables now would blur phase acceptance and risk schema churn.

Decision:
Keep the Phase 0 Prisma schema limited to the PostgreSQL datasource and client generator. Use a raw, constant `SELECT 1` only for readiness. Introduce reviewed domain models and the initial migration in Phase 1.

Alternatives Considered:
- Add placeholder tables with incomplete fields
- Implement the full suggested schema in Phase 0
- Omit Prisma until Phase 1

Reasoning:
This establishes and verifies the selected database adapter without inventing a schema before job lifecycle and consistency rules are implemented.

Consequences:
Phase 0 creates no application tables and runs no migrations. The API supports readiness only; job and worker persistence cannot exist until Phase 1.

Affected Components:
- `backend/prisma/schema.prisma`
- `backend/src/lib/prisma.ts`
- `backend/src/modules/health/health.service.ts`
## Decision: Bind published services to loopback by default

Date:
2026-09-21

Status:
Accepted

Context:
The project is local-first, has no Phase 0 authentication, and uses documented development credentials. Publishing PostgreSQL and application ports on every host interface would expose them to the local network unnecessarily. Compose also cannot safely percent-encode arbitrary interpolated credentials while constructing a URL.

Decision:
Bind every Compose-published port to `127.0.0.1`. Bind direct backend and Vite development servers to `127.0.0.1` by default, while their containers explicitly bind to `0.0.0.0` inside Docker's isolated network. Supply a separate `DATABASE_URL_DOCKER` value whose credentials must be URL-encoded instead of constructing it from raw Compose password variables.

Alternatives Considered:
- Publish all services on every host interface
- Remove host PostgreSQL publishing entirely
- Construct the Prisma URL from raw username/password interpolation

Reasoning:
Loopback binding matches the one-machine boundary and reduces exposure without preventing host development. Keeping the PostgreSQL host port loopback-accessible supports Prisma migration commands. A complete encoded URL handles reserved password characters predictably.

Consequences:
LAN clients cannot access OrchestrOS by default. If PostgreSQL credentials change, both PostgreSQL variables and the host/container database URLs must be updated consistently, with reserved characters percent-encoded in URLs.

Affected Components:
- `compose.yaml`
- `.env.example`
- `backend/src/config/env.ts`
- `backend/src/server.ts`
- `frontend/vite.config.ts`
- `Readme.md`
## Decision: Model Phase 1 with four constrained domain tables

Date:
2026-09-21

Status:
Accepted

Context:
Phase 1 requires jobs, workers, resource allocations, and execution records while later phases own scheduling, locking, containers, metrics, failure recovery, and experiments.

Decision:
Create exactly `jobs`, `workers`, `resource_allocations`, and `job_executions` plus focused enums. Use UUID identifiers, integer CPU millicores, integer memory MiB, restrictive audit-record foreign keys, queue/relationship indexes, and SQL `CHECK` constraints for positive/bounded resource values and no worker over-allocation. Allocation and execution tables remain unwritten foundations until their owning phases.

Alternatives Considered:
- Add all suggested future metrics, heartbeat, scaling, and experiment tables immediately
- Store CPU and memory as floating-point values
- Cascade-delete allocation/execution history

Reasoning:
Four tables meet Phase 1 without speculative schema growth. Integer units make arithmetic and constraints deterministic. Restrictive history relations support later failure and concurrency demonstrations.

Consequences:
Later phases may add migrations but must preserve these invariants and records. Availability is derived from capacity minus allocated counters rather than stored redundantly.

Affected Components:
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260921144000_phase_1_domain/migration.sql`

## Decision: Create queued jobs and expose only safe Phase 1 cancellation

Date:
2026-09-21

Status:
Accepted

Context:
The complete lifecycle has nine required states, but Phase 1 has no scheduler, container termination, or transactional resource release.

Decision:
Centralize all valid lifecycle edges in `job.transitions.ts`. `POST /api/jobs` always persists `QUEUED`; clients cannot set managed fields. `POST /api/jobs/:id/cancel` conditionally updates only queued rows, is idempotent for already-cancelled jobs, rejects invalid terminal transitions, and returns `JOB_NOT_CANCELLABLE` for states whose safe cancellation requires later runtime cleanup.

Alternatives Considered:
- Generic status update endpoint
- Allow clients to create jobs in any state
- Treat cancellation as row deletion
- Pretend Phase 1 can cancel running containers

Reasoning:
A narrow command endpoint protects lifecycle invariants and preserves job history. Conditional update prevents concurrent cancellation requests from both performing a transition.

Consequences:
Phase 1 supports only queued cancellation. Later scheduler/executor services must use the same transition policy and implement cleanup before enabling runtime cancellation.

Affected Components:
- `backend/src/modules/jobs/`
- `backend/src/app.ts`

## Decision: Gate API startup on migration and idempotent worker seed

Date:
2026-09-21

Status:
Accepted

Context:
A database connection can succeed while required tables are missing. Phase 1 also requires three initial logical workers without resetting live records on every restart.

Decision:
Add a one-shot Compose `database-setup` service that runs `prisma migrate deploy` followed by the TSX seed before the backend starts. Seed workers with upsert-by-name and an empty update so reruns create missing records but do not reset status, allocations, or timestamps. Health checks access Phase 1 tables through Prisma.

Alternatives Considered:
- Run `prisma migrate dev` during application startup
- Let the API start before migrations
- Unconditionally recreate workers on every startup

Reasoning:
Deployment migrations are noninteractive and appropriate for repeatable Compose startup. Idempotent non-resetting seed behavior preserves future runtime state.

Consequences:
Compose includes an exited-success setup container in its service history. Migration or seed failure blocks the API instead of reporting false readiness.

Affected Components:
- `compose.yaml`
- `backend/prisma/seed.ts`
- `backend/package.json`
- `backend/src/modules/health/health.service.ts`

## Decision: Use repository-injected services and Node-native tests

Date:
2026-09-21

Status:
Accepted

Context:
Job and worker behavior requires focused tests, but the project should avoid unnecessary dependencies and tests must not mutate the development database.

Decision:
Place Prisma operations behind narrow job and worker repository interfaces. Services accept repositories through constructors and default to Prisma implementations. Run deterministic service tests with in-memory repositories and Node's built-in test runner through already-installed TSX. Add HTTP-boundary tests and an opt-in `RUN_DATABASE_TESTS=true` suite that uses unique temporary records, exercises the real API/Prisma/PostgreSQL path, and removes those records afterward.

Alternatives Considered:
- Add Vitest and Supertest
- Make all tests depend on a running PostgreSQL database
- Mock the global Prisma singleton through module patching

Reasoning:
Constructor injection keeps default tests deterministic and fast without adding packages. The opt-in integration path verifies conditional cancellation, Prisma error translation, database constraints, and HTTP contracts when PostgreSQL is available.

Consequences:
Repository interfaces add a small abstraction. Default tests skip one integration case when PostgreSQL is unavailable; phase validation must enable it after migrations and seeding. Phase 5 will require additional isolated concurrency tests for row locking and reservation transactions.

Affected Components:
- `backend/src/modules/jobs/`
- `backend/src/modules/workers/`
- `backend/package.json`
- `package.json`
## Decision: Enforce allocation/execution identity in PostgreSQL

Date:
2026-09-21

Status:
Accepted

Context:
The initial Phase 1 schema allowed an execution's job, worker, and allocation references to disagree and allowed more than one active reservation for a job. Those states would make later resource release and audit history unsafe.

Decision:
Require every `JobExecution` to reference an allocation and worker. Add composite candidate keys and a composite foreign key that binds execution allocation, job, and worker identity. Add a PostgreSQL partial unique index allowing only one `RESERVED` allocation per job while preserving multiple historical `RELEASED` or `ROLLED_BACK` records.

Alternatives Considered:
- Validate identity only in application services
- Remove job/worker identity from execution records and derive every query through allocation
- Permit multiple active reservations and rely only on worker row locks

Reasoning:
Database constraints protect every caller and future concurrency path. The partial index prevents reservations on different workers for the same job, which worker-only locking cannot prevent. Explicit execution identity keeps direct job/worker audit queries while guaranteeing consistency.

Consequences:
Execution records can only be created after reservation. Phase 5 allocation transactions must handle the unique-reservation conflict as a normal contention outcome. Allocation and execution deletion remains restricted.

Affected Components:
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260921151000_enforce_allocation_integrity/migration.sql`
- `backend/src/modules/jobs/job.integration.test.ts`
