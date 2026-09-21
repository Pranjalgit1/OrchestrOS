# OrchestrOS

**Intelligent Container Orchestration with Resource-Aware Scheduling & Autoscaling**

OrchestrOS is a Kubernetes-inspired local container orchestration prototype that will schedule controlled computational workloads, perform resource-aware placement across logical workers, execute workloads with Docker, protect allocation with PostgreSQL transactions and row locks, monitor system state, recover interrupted jobs, and use ML-assisted demand forecasting for proactive autoscaling.

> **Current implementation:** Phase 1 — Database and Job Management. PostgreSQL migrations, job/worker persistence, controlled lifecycle rules, queued-job cancellation, initial logical workers, REST APIs, schema-aware health, and focused tests work. Workload generation, scheduling, placement, resource reservation, workload containers, monitoring, autoscaling, recovery, experiments, and ML are not implemented yet.

## System boundary

The MVP runs on **one physical development machine**. Logical workers are database records representing orchestration CPU and memory capacity; they are not separate computers, VMs, cloud nodes, or Docker hosts.

OrchestrOS is not Kubernetes, a cloud platform, an ML-only system, a generic Docker dashboard, or a basic CPU scheduling simulator.

## Current architecture

```text
React/Vite frontend
        |
        v
Express REST API
        |
        +--> Job service --> Job repository -----+
        |                                         |
        +--> Worker service --> Worker repository +--> Prisma --> PostgreSQL
```

Target orchestration remains:

```text
Workload Generator -> Persistent Queue -> Scheduler -> Placement
  -> Transactional Reservation -> Docker Execution -> Monitoring -> Release
```

See [`docs/architecture.md`](docs/architecture.md) for stable intended architecture and [`docs/flow.md`](docs/flow.md) for actual execution paths.

## Phase 1 capabilities

- Four-model Prisma schema: jobs, workers, resource allocations, and job executions
- Initial SQL migration with foreign keys, indexes, enums, and resource `CHECK` constraints
- All required job states and centralized valid transitions
- Strict predefined workload types: CPU intensive, matrix multiplication, sorting, data processing, and sleep
- Job create/list/get and queued-job cancellation APIs
- Logical-worker create/list/get APIs
- Atomic conditional cancellation and idempotent cancellation retries
- Three idempotently seeded logical workers
- Compose migration/seed gate before backend startup
- Structured 400/404/409/413/500 errors
- Schema-aware database health check across all four Phase 1 models
- Thirteen focused unit, HTTP-boundary, and opt-in PostgreSQL integration tests

Allocation and execution tables are foundations only; production Phase 1 code does not create those records. Database integration tests verify their identity and uniqueness constraints with temporary records that are removed afterward.

## Resource units and initial workers

CPU is stored as integer **millicores** (`1000` = one logical CPU core). Memory is stored as integer **MiB** (`1024` = one GiB).

| Worker | CPU capacity | Memory capacity | Initial state |
| --- | ---: | ---: | --- |
| `worker-1` | 2000 millicores | 2048 MiB | `IDLE` |
| `worker-2` | 4000 millicores | 4096 MiB | `IDLE` |
| `worker-3` | 6000 millicores | 8192 MiB | `IDLE` |

The seed creates missing workers but never resets an existing worker's state or allocated counters.

## REST API

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api` | API phase/status metadata |
| `GET` | `/api/health` | Database and Phase 1 table readiness |
| `POST` | `/api/jobs` | Create a controlled job as `QUEUED` |
| `GET` | `/api/jobs` | List jobs in persistent arrival order |
| `GET` | `/api/jobs?status=QUEUED&limit=25` | Filter and bound job listing |
| `GET` | `/api/jobs/:id` | Read one job |
| `POST` | `/api/jobs/:id/cancel` | Atomically cancel a queued job |
| `POST` | `/api/workers` | Create an idle logical worker |
| `GET` | `/api/workers` | List logical workers by name |
| `GET` | `/api/workers/:id` | Read one logical worker |

Example job request:

```json
{
  "name": "matrix-demo",
  "workloadType": "MATRIX_MULTIPLICATION",
  "cpuRequiredMillicores": 2000,
  "memoryRequiredMiB": 1024,
  "estimatedDurationSeconds": 30,
  "priority": 7
}
```

Clients cannot submit status, assignments, commands, Docker images, container IDs, results, failure details, or allocated worker counters. Runtime cancellation intentionally remains unavailable until container and resource cleanup exist.

## Repository structure

```text
backend/
├── prisma/
│   ├── migrations/
│   ├── schema.prisma
│   └── seed.ts
└── src/
    ├── errors/
    ├── modules/health/
    ├── modules/jobs/
    ├── modules/workers/
    ├── app.ts
    └── server.ts
frontend/
docs/
├── architecture.md
├── decision.md
├── flow.md
└── image.png
```

## Prerequisites

- Node.js 22.12 or newer
- npm 10 or newer
- Docker Desktop with Docker Compose

Validated locally with Node.js 24.13.0, npm 11.6.2, Docker 29.7.2, and Docker Compose 5.5.1.

## Run the complete stack

From PowerShell in the repository root:

```powershell
Copy-Item .env.example .env
npm install
npm run docker:up
```

Compose automatically applies pending migrations and idempotently seeds workers before starting the backend.

Open:

- Dashboard: <http://localhost:5173>
- API: <http://localhost:4000/api>
- Health: <http://localhost:4000/api/health>
- Jobs: <http://localhost:4000/api/jobs>
- Workers: <http://localhost:4000/api/workers>

Stop the stack from another terminal:

```powershell
npm run docker:down
```

The named PostgreSQL volume is retained. `docker compose down --volumes` deletes local database data and should be used only when a clean database is intended.

## Run in development mode

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
docker compose up -d postgres
npm run db:setup
```

Then run these in separate terminals:

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

## Database commands

```powershell
npm run prisma:validate
npm run prisma:generate
npm run db:deploy
npm run db:seed
npm run db:setup
```

`db:deploy` applies committed migrations. `db:seed` ensures the initial workers exist. `db:setup` performs both.

## Validation commands

```powershell
npm test

# Run the same suite with PostgreSQL integration coverage after db:setup
$env:RUN_DATABASE_TESTS = "true"
npm test

npm run prisma:validate
npm run typecheck
npm run build
npm audit
docker compose config
```

## Configuration

Copy `.env.example` to `.env`. `.env` is ignored and must not be committed. Compose publishes services only on `127.0.0.1`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_USER` | `orchestr_os` | Local PostgreSQL user |
| `POSTGRES_PASSWORD` | `orchestr_os` | Local development password |
| `POSTGRES_DB` | `orchestr_os` | Local database name |
| `POSTGRES_PORT` | `5432` | Loopback PostgreSQL port |
| `DATABASE_URL` | local PostgreSQL URL | Prisma URL for host development |
| `DATABASE_URL_DOCKER` | Compose PostgreSQL URL | Prisma URL inside Docker |
| `HOST` | `127.0.0.1` | Backend host-development bind address |
| `PORT` | `4000` | Loopback backend port |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed browser origin |
| `FRONTEND_PORT` | `5173` | Loopback frontend port |
| `NODE_ENV` | `development` | Backend runtime mode |

If credentials change, update PostgreSQL variables and both database URLs together. Percent-encode reserved credential characters in URLs. Existing volumes retain initialization credentials.

## Safety and consistency rules

- Only predefined workload types and bounded resource values are accepted.
- Arbitrary commands and Docker images are rejected by strict request schemas.
- The frontend never receives Docker daemon access.
- PostgreSQL is authoritative; Redis and Kafka are not used.
- Jobs are retained when cancelled rather than deleted.
- Scheduler and placement remain separate future components.
- Resource reservation will recheck capacity under a PostgreSQL row lock in Phase 5.

## Remaining phases

2. Seeded automated workload generation
3. FCFS, SJF, Priority, and Round Robin scheduling
4. First Fit, Least Loaded, and Resource-Aware placement
5. Transaction-safe reservation/release and concurrency demonstration
6. Controlled Docker workload execution
7. Monitoring and dashboard features
8. Reactive threshold autoscaling
9. Heartbeat failure detection and recovery
10. Historical ML data pipeline
11. ML-assisted proactive autoscaling
12. Reproducible experiments and metrics
13. Final testing, documentation, and demo polish

## Engineering memory

- [`docs/architecture.md`](docs/architecture.md): intended stable architecture
- [`docs/flow.md`](docs/flow.md): actual executable code paths
- [`docs/decision.md`](docs/decision.md): meaningful decisions and trade-offs
- [`docs/image.png`](docs/image.png): retained proposal architecture visual

Academic proposal assets remain under `docs/07a74a187970d58871c4261b7922ca06/`.
