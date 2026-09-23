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
## Decision: Version deterministic workload generation and persist reusable batches

Date:
2026-09-21

Status:
Accepted

Context:
Fair scheduling and autoscaling experiments require the same controlled workload to be recreated, while generator algorithms and profiles may evolve over time.

Decision:
Implement pure generator version `v1` with a local Mulberry32 PRNG. Persist seed, canonical pattern, count, normalized parameters, start time, and version in `WorkloadBatch`. Persist ordered job specifications with batch sequence and arrival offset. Reuse clones stored specifications into a new batch instead of rerunning the generator. Batch and jobs are inserted in one database transaction.

Alternatives Considered:
- Use `Math.random()` without a seed
- Add a random-number package
- Regenerate old workloads using whichever generator version is current
- Reset and reuse completed job rows

Reasoning:
A small local PRNG is reproducible and adds no dependency. Versioning prevents silent behavior changes. Cloning immutable specifications preserves exact experiment inputs while giving each run independent job lifecycle records.

Consequences:
Database IDs and default start timestamps differ across batches, but ordered workload fields and offsets are reproducible. Any future algorithm/profile change must use a new generator version. Reuse adds source-batch lineage and requires source batches to be retained.

Affected Components:
- `backend/src/modules/workloads/`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260921153000_workload_batches/migration.sql`

## Decision: Use conservative documented workload-pattern profiles

Date:
2026-09-21

Status:
Accepted

Context:
The project requires Light, Medium, Heavy, Constant, Burst, Increasing, Decreasing, Periodic, and Custom inputs but did not define exact distributions. Generated workloads must remain safe on local logical workers and explainable in experiments.

Decision:
Use fixed v1 resource pools and documented arrival rules. Light uses 100–500 millicores, 64–512 MiB, and 1–10 second estimates. Medium uses 500–2000 millicores, 256–2048 MiB, and 10–45 seconds. Heavy uses 2000–4000 millicores, 2048–4096 MiB, and 30–90 seconds. Constant uses 10-second gaps; Burst uses five-job groups 30 seconds apart; Increasing/Decreasing vary both resource profile and gap direction; Periodic uses `[2,2,2,20]` gaps. `SUDDEN_BURST` aliases canonical `BURST`. Custom accepts only controlled types, bounded integer ranges, and exact nondecreasing offsets.

Alternatives Considered:
- Random values across the entire API maximum range
- User-defined formulas or scripts
- Arbitrary commands/images as custom workloads

Reasoning:
Conservative pools fit existing medium/large logical workers, produce variation, and are simple to explain. Strict custom ranges preserve safety and reproducibility.

Consequences:
These profiles are an experimental contract rather than measured host capacity. Future tuning must be versioned and documented. Planned arrival is stored as metadata until scheduling exists.

Affected Components:
- `backend/src/modules/workloads/workload.generator.ts`
- `backend/src/modules/workloads/workload.schemas.ts`
- `docs/architecture.md`
- `Readme.md`

## Decision: Sample each generated job independently and derive workload size

Date:
2026-09-21

Status:
Accepted

Context:
The first generator draft spent randomness only on per-batch pool rotations, so specifications repeated every few jobs and unrelated seeds could produce identical batches for patterns with fixed arrival offsets. Workload size was also drawn independently of estimated duration, so the recorded estimate did not describe the recorded work.

Decision:
Sample workload type, CPU, memory, estimated duration, and priority per job from the pattern's pools. Derive `workloadSize` for predefined patterns from the sampled duration and CPU using documented per-type factors, with `SLEEP` size equal to its duration. Keep caller-supplied size ranges for custom batches. Pin `v1` output with golden-vector tests and a PRNG reference vector.

Alternatives Considered:
- Keep cyclic pool rotation and accept repetition and seed collisions
- Derive estimated duration from an independently sampled size instead
- Leave size and duration unrelated and document the caveat

Reasoning:
Per-job sampling satisfies the requirement that generated jobs vary across all attributes and makes distinct seeds produce distinct workloads for every pattern. Deriving size from duration preserves the documented duration bands while making the two fields coherent for later scheduling and execution. Golden vectors turn the version contract into an enforced check.

Consequences:
Batches of 10 may omit one workload type, while batches of 25 or more cover all five. Changing pools, factors, or draw order now fails the golden-vector tests and requires a new generator version. `workloadSize` cannot be requested directly for predefined patterns.

Affected Components:
- `backend/src/modules/workloads/workload.generator.ts`
- `backend/src/modules/workloads/workload.test.ts`
- `docs/architecture.md`
- `Readme.md`

## Decision: Keep manual job workload size optional and align SQL bounds

Date:
2026-09-21

Status:
Accepted

Context:
Adding `workloadSize` initially made it required on `POST /api/jobs`, which would reject existing manual clients. The first workload migration also added only upper-bound resource checks, and the job listing order gained a batch-sequence tiebreak that the new index did not cover.

Decision:
Default `workloadSize` to `1` on manual job creation, matching the column default. Add a follow-up migration that recreates the queue index including `batchSequence`, adds SQL lower bounds for CPU and memory, and backfills pre-existing jobs' `arrivalAt` from their `createdAt`.

Alternatives Considered:
- Keep the required field and accept a breaking API change
- Rely on application validation alone for lower bounds
- Edit the already-applied migration instead of adding a new one

Reasoning:
An optional field with the column default keeps the endpoint backward compatible. Matching SQL bounds protects direct database writes. Editing an applied migration would break Prisma checksums, so a forward migration is the safe path.

Consequences:
Manual jobs omitting a size record `1`. Existing out-of-range rows would block the new constraints, and legacy arrival timestamps now reflect original creation time.

Affected Components:
- `backend/src/modules/jobs/job.schemas.ts`
- `backend/prisma/migrations/20260921160000_workload_arrival_index_bounds/migration.sql`
- `backend/prisma/schema.prisma`

## Decision: Define scheduling policy semantics and a conditional claim

Date:
2026-09-21

Status:
Accepted

Context:
The project requires FCFS, SJF, Priority, and Round Robin scheduling, but the repository did not define the priority direction, a starvation strategy, Round Robin behaviour without preemption, or how concurrent schedulers avoid selecting the same job.

Decision:
Treat higher priority numbers as more urgent and prevent starvation by aging: one effective priority level per full 60 seconds waited since arrival, capped at 10. Implement Round Robin by ordering on a persisted `schedulingRounds` counter, recording a configurable time quantum (default 10 seconds) on each scheduled job. Gate all policies on `QUEUED` status and elapsed planned arrival. Claim jobs with a single conditional update matching the ID and `QUEUED` status, validated through the shared job transition policy. Accept the policy per request instead of storing global scheduler state.

Alternatives Considered:
- Lower numbers as higher priority
- No starvation handling
- Round Robin as a rotating in-memory cursor
- Selecting with `SELECT ... FOR UPDATE` now
- A persisted global scheduler configuration

Reasoning:
Aging is simple to explain and keeps the policy a pure function of job and time. A persisted round counter gives real rotation once preemption requeues work, and degrades gracefully to arrival order today. The conditional update provides the needed safety without introducing row locking, which belongs to the resource-reservation increment. Per-request policy lets the same seeded workload be replayed under different policies for fair comparison.

Consequences:
Priority ordering depends on wall-clock wait time, so tests must inject the current time. Round Robin behaves like FCFS until preemption exists. A losing concurrent claim is a normal outcome rather than an error, so dispatch can schedule fewer jobs than requested. Scheduler-wide fairness across the whole queue means integration tests must scope their own candidates to stay deterministic.

Affected Components:
- `backend/src/modules/scheduler/`
- `backend/prisma/migrations/20260921170000_job_scheduling/migration.sql`
- `backend/prisma/schema.prisma`

## Decision: Make placement an advisory decision with projected load accounting

Date:
2026-09-21

Status:
Accepted

Context:
Placement must choose a worker using CPU and memory accounting, but the project requires that every real reservation be transaction-safe with an in-transaction capacity recheck. Implementing counter updates now would either duplicate or pre-empt that work unsafely. Without any load accounting, however, `LEAST_LOADED` and `RESOURCE_AWARE` would see identical idle workers and pile every job onto the same one.

Decision:
Persist placement as an advisory decision on the job (`assignedWorkerId`, `placementStrategy`, `placedAt`) and leave worker counters and allocation records untouched. Compute availability as capacity minus persisted reservations minus the summed requirements of jobs already placed on that worker in `SCHEDULED` or `RUNNING` state. Treat worker statuses `IDLE`, `ACTIVE`, and `BUSY` as able to accept work. Refuse placement with `INSUFFICIENT_RESOURCES` when no worker fits, and guard assignment with a conditional update on job ID, `SCHEDULED` status, and a null worker.

Alternatives Considered:
- Update worker allocation counters during placement
- Create `ResourceAllocation` rows during placement
- Ignore already-placed jobs and use only persisted counters
- Add a dedicated placement state to the job lifecycle

Reasoning:
Advisory placement keeps the reservation rule intact while still producing a real, persisted, testable decision. Projected load makes the strategies behave differently and prevents a plan that overcommits one worker. Excluding `STARTING`, `STOPPING`, and `FAILED` matches their meaning. The conditional update reuses the proven claim pattern without introducing row locking early.

Consequences:
A placed job holds no reserved capacity, so reservation must re-verify availability under a row lock and may reject a stale decision. Placement does not change job status, so `SCHEDULED` covers both pre- and post-placement jobs and the worker field distinguishes them. Because placement considers every worker, integration tests scope their own workers to stay deterministic.

Affected Components:
- `backend/src/modules/placement/`
- `backend/prisma/migrations/20260921180000_job_placement/migration.sql`
- `backend/prisma/schema.prisma`

## Decision: Score RESOURCE_AWARE on post-placement fit

Date:
2026-09-21

Status:
Accepted

Context:
The required Resource-Aware strategy had to consider CPU fit, memory fit, and current utilization while remaining simple and explainable rather than an opaque formula.

Decision:
Score each eligible worker as `0.7 × peakUtilAfter + 0.3 × |cpuUtilAfter − memUtilAfter|`, where the utilizations are computed after hypothetically adding the job. Lower scores win, ties break on worker name.

Alternatives Considered:
- Average utilization instead of peak
- Bin-packing that maximizes utilization
- Weighting estimated duration into the score
- A learned or multi-factor opaque score

Reasoning:
Peak utilization is what saturates a worker first, and the imbalance term discourages leaving one dimension nearly full while the other is idle. Two weights are easy to explain in a report and easy to test. Duration-aware placement would need execution data that does not exist yet.

Consequences:
The strategy can pick a busier worker over an idle one when the idle worker is a poor shape fit, which is intended and covered by tests. The weights are a documented experimental contract; changing them changes placement outcomes and must be recorded.

Affected Components:
- `backend/src/modules/placement/placement.accounting.ts`
- `backend/src/modules/placement/placement.test.ts`

## Decision: Reserve capacity with a worker row lock and an in-transaction recheck

Date:
2026-09-22

Status:
Accepted

Context:
Placement produces an advisory plan, but concurrent reservations for the same worker could still over-allocate it. Prisma has no first-class `SELECT ... FOR UPDATE`, so the locking strategy had to be chosen explicitly.

Decision:
Perform reservation inside a Prisma interactive transaction that first acquires a row lock on the worker with a parameterized raw `SELECT ... FOR UPDATE`, then re-reads capacity and allocated counters and re-verifies them before inserting a `RESERVED` allocation, incrementing the worker counters, and setting the worker `BUSY`. Reserve exactly the job's own requirements; clients cannot supply an amount or a worker. Refuse with `INSUFFICIENT_RESOURCES` without writing when the recheck fails.

Alternatives Considered:
- Optimistic concurrency with a version column and retries
- A conditional `UPDATE ... WHERE allocated + request <= capacity`
- Serializable isolation for the whole transaction
- Trusting the placement decision

Reasoning:
Pessimistic row locking is the clearest demonstration of the DBMS concepts this project must show, and it makes the read-then-write sequence obviously correct. A conditional update would work for counters alone but would not let the allocation insert, counter update, and status change share one verified decision. Serializable isolation would add retry handling without improving safety for a single-row hot spot.

Consequences:
Reservations on the same worker serialise, which is intended and measured through `lockWaitMs`. Because lock waits are legitimate, the transaction uses a widened 15s start window and 20s timeout instead of Prisma's tighter defaults; the first concurrency test failed until this was corrected. Raw SQL is used only for locking and stays parameterized. The in-transaction duplicate check runs before the capacity recheck: a live smoke test showed that a job re-reserving on a saturated worker was told `INSUFFICIENT_RESOURCES`, because its own reservation is part of the worker's allocated total. Ordering the duplicate check first reports the real cause; the partial unique index remains the backstop for concurrent duplicates.

Affected Components:
- `backend/src/modules/resources/resource.repository.ts`
- `backend/src/modules/resources/resource.integration.test.ts`

## Decision: Keep job status unchanged during reservation and make release idempotent

Date:
2026-09-22

Status:
Accepted

Context:
The reservation sequence calls for updating job state alongside the allocation, but nothing executes a workload yet. Marking a job `RUNNING` at reservation time would claim behavior that does not exist. Release also needs to be safe to retry, since later failure recovery will call it during reconciliation.

Decision:
Leave the job in `SCHEDULED` during reservation and treat the `RESERVED` allocation row as the authoritative record that capacity is held; execution will own the transition to `RUNNING`. Make release idempotent: releasing an already released job returns the existing record with `alreadyReleased: true` and does not decrement counters again, while a job that never reserved returns `NO_ACTIVE_ALLOCATION`. Derive worker status from accounting, setting `BUSY` while any reservation exists and `IDLE` when the last is released.

Alternatives Considered:
- Transition the job to `RUNNING` during reservation
- Add a dedicated `RESERVED` job state
- Return an error when releasing twice
- Manage worker status only from execution or monitoring

Reasoning:
Not faking `RUNNING` keeps documented behavior honest and leaves the lifecycle for execution to drive. The allocation table already distinguishes reserved from released, so an extra job state would duplicate it. Idempotent release is safer for recovery paths that may retry after a crash.

Consequences:
A `SCHEDULED` job may or may not hold a reservation, so the allocation record must be consulted to tell the difference. Adding a `RESERVED` job state later would require a migration and a transition-policy change. `ROLLED_BACK` remains unused for now and is reserved for recovery reconciliation.

Affected Components:
- `backend/src/modules/resources/resource.service.ts`
- `backend/src/modules/resources/resource.repository.ts`
- `docs/flow.md`

## Decision: Grant the backend container access to the host Docker socket

Date:
2026-09-22

Status:
Accepted

Context:
Execution has to create real containers, and the backend runs inside a container of its own. Reaching the daemon requires mounting the host Docker socket into the backend service. That mount is root-equivalent on the host: anything able to create containers can mount the host filesystem into a new one.

Decision:
Mount `/var/run/docker.sock` into the backend service only, and compensate in code rather than by restricting the socket. The image is a constant, not configuration. The container specification is built entirely by the backend: limits equal to the reservation, no network, read-only root filesystem, no bind mounts, all capabilities dropped, no privilege escalation, a PID ceiling, no restart policy, and no entrypoint override. Request bodies cannot carry an image, command, environment, or timeout. Document the exposure instead of implying it does not exist.

Alternatives Considered:
- A Docker socket proxy restricting the reachable API surface
- Running the backend on the host and leaving the containerised stack unable to execute
- Shelling out to the `docker` CLI from inside the container
- Rootless Docker or a dedicated container runtime

Reasoning:
A socket proxy sounds safer but is not: execution needs `POST /containers/create`, which is by itself enough to mount the host filesystem into a new container, so the proxy would add a service and its configuration while blocking nothing that matters. Keeping the backend on the host would break the single-command stack that every other phase relies on. Rootless Docker would genuinely reduce the blast radius but changes the developer's whole Docker installation, which is out of scope for a prototype on one machine. Given that, the honest position is to accept the exposure for a local single-machine prototype, keep the frontend well away from it, and make the container itself as inert as possible.

Consequences:
The backend container is a privileged component in practice, and the decision would have to be revisited before anything resembling multi-tenancy or a shared host. The frontend never receives Docker access. `DOCKER_SOCKET_PATH` defaults per platform so the same code works on the Windows host and in the Linux container.

Affected Components:
- `compose.yaml`
- `backend/src/config/env.ts`
- `backend/src/modules/executions/execution.runtime.ts`

## Decision: Talk to the Docker Engine API directly instead of adding a client library

Date:
2026-09-22

Status:
Accepted

Context:
Execution needs seven daemon operations: version, image inspect, container create, start, wait, logs, and remove. The usual choice is `dockerode`.

Decision:
Write a small adapter over `node:http` with `socketPath`, in `docker.client.ts`, exposing only those operations. Negotiate the API version from the daemon's `/version` response, clamped to what the adapter was written against and checked against the daemon's minimum. Demultiplex Docker's framed log stream directly and cap each stream while reading it.

Alternatives Considered:
- `dockerode`
- Shelling out to the `docker` CLI
- Pinning a fixed API version with no negotiation

Reasoning:
`dockerode` 5.0.1 pulls in gRPC and protobuf for features this project does not use, which is a lot of dependency surface for seven calls and works against the project's minimal-dependency posture. Node's `socketPath` handles both a unix socket and a Windows named pipe, so one adapter covers the host and the container. Writing it also makes the reachable API surface explicit, which is the point: the file is the complete list of what OrchestrOS can ask the daemon to do. Shelling out to the CLI would mean string-building commands, exactly the injection surface the project avoids elsewhere. Version negotiation is cheap insurance: Docker 29 already raised its minimum API version, and a hard-coded version would eventually break silently.

Consequences:
No new npm dependency and `npm audit` stays clean. The log demultiplexer and version negotiation are ours to maintain and are unit-tested directly. Adding an eighth operation means writing it rather than calling it.

Affected Components:
- `backend/src/modules/executions/docker.client.ts`
- `backend/src/modules/executions/execution.test.ts`

## Decision: Ship a purpose-built workload runner image with self-imposed work ceilings

Date:
2026-09-22

Status:
Accepted

Context:
The workload types are fixed by the domain, and no arbitrary command or image may run. A generic base image plus a command would violate that. Separately, `workloadSize` is a generated number with no calibration against real runtime: a derived matrix size of 200,000 would mean a 200,000-cubed multiplication.

Decision:
Build one image, `orchestros/workload-runner:v1`, from `workload-runner/`, whose entrypoint is a single dependency-free program implementing the five workload types. Its only inputs are four validated environment variables. The runner applies a per-type ceiling on work and an allocation budget derived from the container's memory limit, then reports the size it actually used as `effectiveSize`. Invalid input exits `64` before any work starts.

Alternatives Considered:
- A stock image plus a command string per workload type
- Trusting `workloadSize` literally
- Refusing jobs whose memory reservation is small
- Calibrating sizes so runtime matches `estimatedDurationSeconds`

Reasoning:
Owning the image is what makes "no arbitrary commands" true rather than aspirational, and it lets the runner validate its own inputs as a second line of defence. Trusting the size literally would produce containers that run for hours or get OOM-killed, and reporting a size that was not used would make recorded results dishonest. Sizing allocations from the memory limit is better than refusing small reservations, because a `LIGHT` generated job legitimately reserves 64 MiB. Calibrating runtime against the estimate is a research problem in itself and is not needed for comparing policies.

Consequences:
`effectiveSize` is frequently below the requested size, most visibly for `MATRIX_MULTIPLICATION`, and recorded runtimes are measured rather than predicted. For `SLEEP` the size is read as seconds, so a `CUSTOM` batch that samples a large size asks for a long sleep, bounded by the runner's 120 second ceiling and the execution timeout. Changing a workload implementation changes its checksums, so the runner is versioned and the version is part of the checksum input.

Affected Components:
- `workload-runner/run.js`
- `workload-runner/Dockerfile`
- `backend/src/modules/executions/execution.contract.ts`

## Decision: Derive the workload seed from the job name

Date:
2026-09-22

Status:
Accepted

Context:
A run has to be reproducible: the same workload executed twice should produce the same result. That needs a deterministic seed per job, and jobs created manually have no batch to inherit one from.

Decision:
Derive a 32-bit seed by hashing the job name, in `deriveWorkloadSeed`. Generated names already encode the batch seed and sequence, so reusing a batch reproduces the same names, seeds, and checksums.

Alternatives Considered:
- A new `executionSeed` column on `Job`
- Seeding from the batch seed plus `batchSequence`, with a fallback for manual jobs
- Seeding from the job id
- Not seeding at all

Reasoning:
Hashing the name needs no migration and makes reproducibility follow from the thing that is already reproducible. Seeding from the batch would need a separate rule for manual jobs. Seeding from the job id would be stable per job but would not reproduce across a regenerated batch, which is the case that matters for experiments. This was verified live: reusing a batch reproduced byte-identical checksums for all ten jobs across four workload types, on different workers and in different containers.

Consequences:
Two jobs with the same name get the same seed, which is intended for batch reuse and harmless otherwise. Renaming a job changes its seed and therefore its checksum.

Affected Components:
- `backend/src/modules/executions/execution.contract.ts`
- `backend/src/modules/executions/execution.service.ts`

## Decision: Start executions asynchronously and settle them idempotently

Date:
2026-09-22

Status:
Accepted

Context:
`estimatedDurationSeconds` allows up to 24 hours, and even generated jobs reach 90 seconds, so an endpoint that blocks until the container exits is not viable. Something still has to record the outcome and release the reservation.

Decision:
`POST /api/executions/start` claims the job, launches the container, and returns HTTP 202 immediately. A background task awaits the exit and settles the run. `POST /api/executions/:id/settle` performs the same finalisation on demand and is idempotent, so it doubles as the recovery path. Finalisation is guarded by the execution's current status, so the two paths cannot both release capacity.

Alternatives Considered:
- A synchronous run endpoint
- Polling containers on a timer
- A separate worker process or job queue
- Requiring a manual settle for every run

Reasoning:
Returning immediately keeps the API usable and matches how the orchestration chain is driven today, one explicit call per stage. Awaiting the daemon's `wait` endpoint is cheaper and more accurate than polling. A separate worker process would be the right answer for a system that must survive restarts, but it is a larger change than this increment needs and the recovery path already exists. Requiring a manual settle would make normal completion depend on a human.

Consequences:
If the backend process dies mid-execution, the execution stays `RUNNING` and its reservation stays held until someone settles it; that gap is documented rather than hidden, and automatic reconciliation belongs to the failure-recovery increment. Graceful shutdown waits for in-flight settlements. Tests expose `awaitPendingSettlements()` so they can assert on completed runs deterministically.

Affected Components:
- `backend/src/modules/executions/execution.service.ts`
- `backend/src/modules/executions/execution.routes.ts`
- `backend/src/server.ts`

## Decision: Record a timeout as an interruption and never invent a result

Date:
2026-09-22

Status:
Accepted

Context:
A container can exit cleanly, exit non-zero, be killed for exceeding its memory limit, run past the orchestrator's time limit, exit zero while printing nothing useful, or disappear before it was recorded. Each needs a defensible mapping onto the execution and job states.

Decision:
Classify outcomes explicitly. A timeout becomes `INTERRUPTED` on both the execution and the job, because the workload did not misbehave, the orchestrator stopped it, and `INTERRUPTED` keeps the job eligible for a later requeue. Every other non-success becomes `FAILED` with a specific reason, including a distinct message for an OOM kill. A zero exit whose stdout does not match the runner contract is `FAILED`, not a success. An execution whose container has vanished is `FAILED` with a null exit code. Capacity is released on every path.

Alternatives Considered:
- Treating a timeout as `FAILED`
- Treating an unparseable result as a success because the exit code was zero
- Inferring an exit code when the container is gone
- Leaving a lost container's execution open

Reasoning:
Collapsing every bad ending into `FAILED` would throw away the distinction that matters for later preemption and recovery work. Trusting a zero exit with no valid result line would let a silently broken runner look like a completed experiment. Inventing an exit code for a container nobody can inspect would put a fabricated number in the audit trail; a null with an explicit reason is the honest record. Leaving the execution open would strand capacity indefinitely.

Consequences:
An interrupted job is distinguishable from a failed one, which the requeue path will rely on. `INTERRUPTED` executions carry the exit code the daemon reported after the stop, commonly 137, alongside the timeout reason, so the reason rather than the code explains the outcome. Verified live: a `SLEEP` job against a ten second limit ran for just over fifteen seconds including the stop grace, then recorded `INTERRUPTED`, a null result, a released allocation, and an idle worker.

Affected Components:
- `backend/src/modules/executions/execution.service.ts`
- `backend/src/modules/executions/execution.contract.ts`

## Decision: Lock the job row when claiming an execution

Date:
2026-09-22

Status:
Accepted

Context:
Two concurrent start requests for one job must not both launch a container. A conditional `SCHEDULED -> RUNNING` update alone guarantees that, but the loser's refusal then depends on interleaving: it could be told the job is "not runnable" when the truth is that another request just started it. An integration test caught exactly that.

Decision:
Lock the job row with `SELECT ... FOR UPDATE` at the start of the claim transaction, then decide. A `RUNNING` job that owns a live `PENDING` or `RUNNING` execution reports `EXECUTION_ALREADY_STARTED`; a `RUNNING` job with no live execution is an orphan and reports `JOB_NOT_EXECUTABLE`. The conditional update stays as a second guard.

Alternatives Considered:
- Relying on the conditional update alone
- Relying on the unique indexes and mapping every collision to "already started"
- Accepting a timing-dependent error code

Reasoning:
This mirrors the locking already used for reservation, so the codebase has one concurrency idiom rather than two. The unique indexes do prevent duplicate rows, but mapping their collisions would not distinguish a concurrent start from an orphaned job left behind by a crash, and that distinction is what recovery will need. A timing-dependent error code is a bad API contract even when every outcome is individually correct.

Consequences:
Claims for the same job serialise, which is intended. The orphan case now has a defined answer and stays refused until reconciliation exists. Verified live and in an integration test: concurrent claims produce exactly one execution and one `EXECUTION_ALREADY_STARTED`.

Affected Components:
- `backend/src/modules/executions/execution.repository.ts`
- `backend/src/modules/executions/execution.integration.test.ts`

## Decision: Derive metrics from the authoritative records instead of accumulating them

Date:
2026-09-22

Status:
Accepted

Context:
Monitoring needs queue depth, cluster utilization, lifecycle timings, throughput, and per-worker activity. The conventional approach is to increment counters as events happen. This project already stores every event it cares about in `jobs`, `resource_allocations`, and `job_executions`, complete with timestamps.

Decision:
Compute every metric from those records at read time. Add no counter columns, no metrics event table, and no write path in the orchestration flow. The one exception is utilization over time, which `worker_samples` stores because worker counters record only the present and a history of them cannot be reconstructed after the fact.

Alternatives Considered:
- Counter columns incremented by the scheduler, placement, reservation, and execution paths
- A metrics event table written alongside every state change
- An in-memory metrics registry such as a Prometheus client
- Sampling everything periodically, including things that are derivable

Reasoning:
A counter that is incremented separately from the state it describes can drift, and when it does the dashboard contradicts the database with no way to tell which is wrong. Deriving removes that failure mode by construction: a metric is a question about the records, so it cannot disagree with them. It also keeps monitoring out of the write path entirely, which matters because reservation and execution already run inside carefully scoped transactions that should not grow. An in-memory registry would lose everything on restart and could not answer questions about history, which the experiment phase needs. Sampling derivable values would store redundant data that could fall out of step with its source.

Consequences:
Metric reads cost queries rather than lookups, so windows are bounded (1 minute to 7 days) and limits are capped to keep a query from scanning without limit. Adding a metric usually means writing a query rather than a migration. The five stage timings are computed from column differences, which Prisma cannot aggregate, so that one query is raw SQL.

Affected Components:
- `backend/src/modules/monitoring/monitoring.repository.ts`
- `backend/src/modules/monitoring/monitoring.metrics.ts`

## Decision: Store utilization history as per-worker rows sharing one timestamp

Date:
2026-09-22

Status:
Accepted

Context:
Utilization over time is the one metric that cannot be derived later. It has to be sampled. The question is what a sample looks like: one row of cluster totals, or one row per worker.

Decision:
Write one row per worker per pass, with every row in a pass sharing a single `capturedAt`. Grouping on that timestamp reconstructs the cluster as it stood at that instant. A unique index on `(workerId, capturedAt)` with `ON CONFLICT DO NOTHING` makes a repeated pass a no-op. Sample rows carry the same `CHECK` constraints as real accounting, and they cascade with their worker instead of restricting its deletion.

Alternatives Considered:
- One row per pass holding pre-summed cluster totals
- A separate `sampleId` column to group a pass
- Storing computed utilization percentages alongside the raw counters
- `ON DELETE RESTRICT`, matching the authoritative tables

Reasoning:
Per-worker rows keep the data normalised and answer per-worker questions that cluster totals would throw away, which the autoscaling and experiment phases will want. Cluster totals are a `GROUP BY` away, so nothing is lost. A shared timestamp is sufficient grouping and needs no extra column; a millisecond-precision collision between two passes is prevented by the unique index rather than tolerated. Storing percentages would duplicate information derivable from the counters and could drift from them. `RESTRICT` is right for authoritative records, because losing a reservation's history would be a correctness problem, but a worker's observations are not authoritative and should not prevent it from being removed.

Consequences:
Three workers sampled every fifteen seconds is about 17,000 rows a day, which is why retention pruning exists. Reading history means grouping rows rather than selecting them directly, done by a pure function that is unit-tested against known input.

Affected Components:
- `backend/prisma/migrations/20260922160000_worker_samples/migration.sql`
- `backend/src/modules/monitoring/monitoring.metrics.ts`

## Decision: Start the sampler in server.ts, not app.ts

Date:
2026-09-22

Status:
Accepted

Context:
Every earlier phase is driven by an explicit request; OrchestrOS has had no background work at all. Periodic sampling needs a timer, which makes it the first. Tests import the Express app from `app.ts` dozens of times.

Decision:
Keep the sampler out of `app.ts` and start it in `server.ts`, so importing the app never starts a timer. Call `unref()` so the sampler can never be the reason the process stays alive, stop it first during shutdown, guard against overlapping passes, and log and swallow failures. Make the interval configurable, with zero disabling periodic sampling and leaving `POST /api/monitoring/sample` as the explicit path.

Alternatives Considered:
- Starting the timer in `app.ts` alongside route registration
- A separate sampler process or container
- No timer at all, sampling only on request
- A cron-style external scheduler

Reasoning:
Starting a timer on import would make every test file spawn background database writes, which is both slow and a source of flaky cross-test interference. Keeping it in `server.ts` means the process that actually serves traffic owns the loop and the test suite stays deterministic. A separate process would be the right answer for a production system but doubles the deployment for one small writer. Sampling only on request would make the history feature real in name only, since nobody would be calling it during an unattended run. Guarding overlap matters because a pass that outlives its interval would otherwise queue passes behind each other under load, which is exactly when monitoring should stay cheap.

Consequences:
The sampler is the project's single background loop and is confined to observation; it writes only `worker_samples`. Graceful shutdown stops it before awaiting execution settlements. A missed observation leaves a gap in the series rather than failing a request, which is the correct trade for a monitoring component.

Affected Components:
- `backend/src/modules/monitoring/monitoring.sampler.ts`
- `backend/src/server.ts`

## Decision: Prune inside the sampling pass and bound every metric window

Date:
2026-09-22

Status:
Accepted

Context:
Sampled history grows forever if nothing removes it, and metric queries scan whatever range a caller asks for. Both are unbounded by default.

Decision:
Prune samples older than a configured retention window as part of each sampling pass, and bound every metric query: windows accept 1 minute to 7 days, sample limits cap at 5000, and unknown query keys are rejected. A retention of zero keeps history forever, chosen explicitly.

Alternatives Considered:
- A separate pruning schedule or maintenance endpoint
- Unbounded windows, trusting callers
- Downsampling old samples into coarser buckets
- A database-level partition or TTL policy

Reasoning:
Pruning inside the pass means history is bounded whether sampling is periodic or on demand, with no second mechanism that could be forgotten or disabled independently. Bounded windows matter because these are read endpoints computing aggregates over growing tables; an unbounded window is a way to ask the database to scan everything, and rejecting it is cheaper than optimising for it. Downsampling would be the right move at a much larger scale and is not justified for a single-machine prototype. PostgreSQL partitioning would add schema complexity for a table measured in tens of thousands of rows a day.

Consequences:
Retention defaults to 24 hours, which is roughly 17,000 rows for three workers and comfortably covers a demo or an experiment run. Anyone wanting a longer experiment history raises retention deliberately. The pruning count is returned from an on-demand capture, so the behaviour is observable rather than silent.

Affected Components:
- `backend/src/modules/monitoring/monitoring.service.ts`
- `backend/src/modules/monitoring/monitoring.schemas.ts`

## Decision: Report a timing stage with no data as a zero count, and no success rate as null

Date:
2026-09-22

Status:
Accepted

Context:
Early in a run most lifecycle stages have no measurements, and no jobs have finished. The API has to say something about them.

Decision:
Always return all five stage timings. A stage nothing has reached reports `count: 0` with null statistics rather than being omitted. Success rate is null when nothing finished in the window rather than zero. Utilization is clamped to 0..1, and a worker with no capacity reports zero utilization rather than dividing by zero.

Alternatives Considered:
- Omitting stages with no data
- Reporting zero for unmeasured averages
- Reporting a 0% success rate before anything finishes
- Letting a divide-by-zero surface as `NaN` or `Infinity`

Reasoning:
Omitting keys would force every caller to distinguish "absent" from "nothing measured", and a dashboard would silently drop rows. Reporting zero for an unmeasured average is worse than saying nothing, because zero is a plausible value and a reader cannot tell it apart from a real measurement. A 0% success rate before any job finishes actively misinforms: it reads as total failure when the truth is no evidence. Clamping utilization means a bug in accounting shows as a full bar rather than an impossible one, and the underlying counters are still reported raw alongside it so the anomaly stays visible.

Consequences:
Consumers handle nulls, which is the honest shape of "not measured yet". The distinction was verified live: an idle cluster reported null success rate and zero counts, and after three jobs completed the same endpoint reported a rate of 1.0 with an `execution` average of 20.2 seconds against a 20-second sleep workload.

Affected Components:
- `backend/src/modules/monitoring/monitoring.metrics.ts`
- `backend/src/modules/monitoring/monitoring.service.ts`

## Decision: Keep the dashboard read-only and draw charts without a charting library

Date:
2026-09-22

Status:
Superseded on 2026-09-23 by **Make React the primary orchestration control interface**.

Context:
The dashboard had been a static status page with nothing to interact with. Phase 7 gives it real data to show, including a time series that wants a chart.

Decision:
Poll the monitoring endpoints every five seconds and render cluster meters, a worker table, queue depth, throughput, lifecycle timings, running containers, and a utilization sparkline drawn as an inline SVG path. Add only two controls, `Refresh` and `Capture sample`, both of which are read or observation actions. Add no charting dependency and no orchestration controls.

Alternatives Considered:
- A charting library such as Recharts or Chart.js
- Server-sent events or a WebSocket instead of polling
- Adding buttons to generate, schedule, place, reserve, and execute jobs
- Leaving the dashboard static and demonstrating only through the API

Reasoning:
A sparkline is a polyline; it does not justify a dependency that would dwarf the rest of the frontend bundle. Polling at five seconds is simpler than a push channel and entirely adequate for a local prototype, and it fails softly. Orchestration controls were tempting because the dashboard has no way to drive work, but each one would need its own validation, error surfacing, and confirmation design, and putting them in would mean shipping a half-considered control surface inside a monitoring increment. Keeping the panel read-only preserves the property that monitoring cannot affect what it measures.

Consequences:
This decision is superseded by the browser-control facade above. The sparkline remains dependency-free and the monitoring panel itself remains observation-only; the new orchestrator panel owns user actions and calls backend APIs. The sparkline still degrades to an explanatory message when fewer than two points exist, so an empty history reads as empty rather than broken.

Affected Components:
- `frontend/src/MonitoringPanel.tsx`
- `frontend/src/api.ts`
- `frontend/src/styles.css`


## Decision: Make React the primary orchestration control interface

Date:
2026-09-23

Status:
Accepted

Context:
The backend already performed the full pipeline correctly, but a normal demonstration required a user to know and call five API/PowerShell commands in a specific order: dispatch, placement, reservation, execution, and later monitoring. The React dashboard only displayed status. That made the project's real capability difficult to operate and gave the impression it was a simulator.

Decision:
Make the React dashboard the normal operator interface. Add browser controls for workload generation, scheduler policy, placement strategy, run-next, bounded batch run, automatic run, terminal cleanup, live queue selection, and per-stage demonstration. Introduce `POST /api/orchestrator/run` as a thin backend facade that calls the existing scheduler, placement, resource, and execution services in their normal order, plus `GET /api/orchestrator/state` as a single dashboard read and `POST /api/orchestrator/clear-finished` for safe demo cleanup.

React only collects intent, submits requests, polls backend state, and renders returned facts. It never picks a job or worker, changes a job state locally, computes capacity, holds a reservation, constructs a Docker request, or keeps a shadow metric. The original per-stage APIs remain available for testing, debugging, and a step-by-step teaching view.

Alternatives Considered:
- Keep the dashboard read-only and document the PowerShell commands better
- Implement scheduling, placement, and resource accounting in React for convenience
- Have the frontend make the four existing stage calls itself in sequence
- Add a generic workflow engine or message queue

Reasoning:
Better instructions do not solve the product problem: command sequencing is an implementation detail, not a user workflow. Moving logic into React would create a second source of truth that would inevitably drift from PostgreSQL and would make row-locking and Docker safety unenforceable. Having React issue the four stage calls would still couple it to sequencing, leave half-advanced jobs easy to strand, and make error handling a frontend concern. A workflow engine is unnecessary for a local single-process prototype when the existing services already expose the needed boundaries. The facade keeps the behavior in the backend while giving the browser one meaningful action.

Consequences:
The UI can demonstrate the real system end to end without PowerShell. A facade response includes stage outcomes (`OK`, `SKIPPED`, `FAILED`) with the actual backend detail, which the activity log renders. The UI's automatic run is deliberately only a loop that asks the backend to advance a bounded batch; it stops on backend-reported idle/full conditions and never assumes a click advanced a job. This is not an autoscaler or a new scheduler.

Affected Components:
- `backend/src/modules/orchestrator/`
- `frontend/src/OrchestratorConsole.tsx`
- `frontend/src/components/`

## Decision: Use a valid all-zero CUSTOM batch for the browser's Immediate demo preset

Date:
2026-09-23

Status:
Accepted

Context:
Predefined workload patterns intentionally space arrivals over time. That is correct for experiments but frustrating in a short mentor demonstration: generating ten `LIGHT` jobs makes most of them ineligible for twenty to forty seconds each, so **Run Orchestrator** appears to do nothing after the first job.

Decision:
Expose an **Immediate — all jobs eligible at once** choice in the browser. It maps onto the existing `CUSTOM` generator contract with an all-zero, correctly sized `arrivalOffsetsSeconds` array. It also offers a controlled `SLEEP` profile (4–10 seconds) or a mixed-compute profile. The browser submits an ordinary validated generation request; no backend eligibility rule is bypassed or special-cased.

Alternatives Considered:
- Change the scheduler to ignore planned arrival times for UI-generated work
- Add a separate undocumented "demo" job type
- Force every predefined pattern to use zero offsets
- Make users wait for the normal arrival schedule

Reasoning:
Ignoring arrival time would invalidate a scheduler invariant and make a UI action behave differently from the API. A special job type would duplicate generator logic and make experiment input less reproducible. Changing every pattern would damage the temporal behavior those patterns were created to test. `CUSTOM` was already designed for exactly bounded explicit ranges and ordered offsets, so all-zero offsets are valid input that preserves every backend rule while making the operator's intention explicit.

Consequences:
Immediate batches are deterministic for the same seed and make all jobs eligible as soon as the batch transaction commits. The UI labels the preset as `CUSTOM`, so it never pretends it is a new predefined pattern. Predefined patterns still display the time until a queued job becomes eligible.

Affected Components:
- `frontend/src/api.ts`
- `frontend/src/components/ControlPanel.tsx`
- `backend/src/modules/workloads/workload.schemas.ts`

## Decision: Make terminal-only cleanup a backend transaction

Date:
2026-09-23

Status:
Accepted

Context:
A browser demonstration creates visible completed jobs, executions, allocations, and batches. The user needs a clean reset without shell SQL, but a broad delete operation could remove queued work, a live container, or a reservation that worker counters still reflect.

Decision:
Add `POST /api/orchestrator/clear-finished`. In one transaction it selects only terminal jobs (`COMPLETED`, `FAILED`, `INTERRUPTED`, `CANCELLED`), deletes their execution and allocation records in foreign-key order, then deletes the jobs and now-empty batches. It deliberately does not select `QUEUED`, `SCHEDULED`, or `RUNNING` work.

Alternatives Considered:
- Let React delete rows directly
- A generic delete-all endpoint
- Keep cleanup as a PowerShell/psql instruction
- Retain all completed work and never offer cleanup

Reasoning:
React cannot and must not connect to the database. A generic delete-all endpoint would be unsafe in exactly the situation the demo is meant to show: a running job holding a reservation. Keeping cleanup in shell instructions defeats the purpose of making the browser the primary interface. Terminal-only cleanup is easy to explain, preserves active work, and lets a user reset a demonstration without affecting the pipeline's concurrency guarantees.

Consequences:
Clearing history removes terminal job results and their batch records, so it is a local demonstration convenience rather than an audit-retention feature. Running jobs and their resource accounting always survive. Tests verify that an active reservation and its worker counters remain after cleanup.

Affected Components:
- `backend/src/modules/orchestrator/orchestrator.repository.ts`
- `backend/src/modules/orchestrator/orchestrator.routes.ts`
- `frontend/src/OrchestratorConsole.tsx`

## Decision: Run database integration tests serially

Date:
2026-09-23

Status:
Accepted

Context:
The Node test runner runs test files concurrently by default. This repository's integration tests intentionally share one PostgreSQL database and several services, including a global scheduler that considers every eligible job and a placement service that considers every worker. A new terminal-cleanup test also removes finished jobs globally by design.

Decision:
Set the backend test script to `--test-concurrency=1`. Unit tests remain fast enough, and database/Docker integration tests execute against a deterministic shared state.

Alternatives Considered:
- Keep concurrent files and rely on randomly prefixed names alone
- Give every test file a separate database/schema
- Mock PostgreSQL for integration tests
- Disable the cleanup test

Reasoning:
Prefixes isolate most rows but cannot isolate intentionally global domain operations such as "next eligible job", "least loaded worker", or terminal cleanup. Concurrent test files exposed exactly that: one file could validly schedule another file's job or reserve another file's worker before its cleanup ran. Separate databases are better at larger scale but significantly complicate local Compose setup. Serial execution takes roughly 105 seconds with Docker, which is acceptable for a college prototype and gives reliable proof rather than intermittent failures.

Consequences:
`npm test` is deterministic and slower when database integration is enabled. Test fakes remain used for pure orchestration behavior, while real PostgreSQL and Docker tests still prove the critical path.

Affected Components:
- `backend/package.json`
- `backend/src/modules/orchestrator/orchestrator.integration.test.ts`
