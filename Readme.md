# OrchestrOS

**Intelligent Container Orchestration with Resource-Aware Scheduling & Autoscaling**

OrchestrOS is a Kubernetes-inspired local container orchestration prototype for controlled computational workloads. It runs on one physical development machine with logical workers, PostgreSQL-backed state, and a modular TypeScript backend.

> **Current implementation:** deterministic workload batches, persistent jobs/workers, controlled lifecycle management, exact batch reuse, database migrations, health checks, and tests work. Scheduling, placement, transactional reservation, workload containers, monitoring, autoscaling, recovery, experiments, and ML do not run yet.

## System boundary

Logical workers are resource-capacity records on one machine—not physical nodes, VMs, cloud hosts, or separate computers. OrchestrOS is not Kubernetes, a cloud platform, an ML-only project, or a basic scheduling simulator.

## Current flow

```text
Generate or reuse controlled workload
              |
              v
WorkloadBatch + QUEUED Jobs
              |
              v
           PostgreSQL
```

Target orchestration remains:

```text
Generator -> Queue -> Scheduler -> Placement -> Transactional Reservation
  -> Docker Execution -> Monitoring -> Resource Release
```

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
- Planned arrival offsets/timestamps for future scheduling
- Structured validation/errors and five-model readiness
- Unit, HTTP-boundary, and PostgreSQL integration tests

Generated jobs remain `QUEUED`. Arrival times are metadata only until the scheduler is implemented.

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

Open:

- Dashboard: <http://localhost:5173>
- API: <http://localhost:4000/api>
- Health: <http://localhost:4000/api/health>

Stop without deleting database data:

```powershell
npm run docker:down
```

For direct development:

```powershell
docker compose up -d postgres
npm run db:setup
npm run dev:backend
```

Run `npm run dev:frontend` in a second terminal.

## Validation

```powershell
npm test

# Include real PostgreSQL integration tests after db:setup
$env:RUN_DATABASE_TESTS = "true"
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
- The frontend never receives Docker daemon access.
- Published ports bind to `127.0.0.1`.

## Remaining work

1. FCFS, SJF, Priority, and Round Robin scheduling
2. First Fit, Least Loaded, and Resource-Aware placement
3. Transaction-safe reservation/release and concurrency demonstration
4. Controlled Docker execution
5. Monitoring and dashboard pages
6. Reactive autoscaling
7. Heartbeat failure recovery
8. Historical ML data and proactive scaling
9. Reproducible policy experiments and graphs

## Engineering memory

- [`docs/architecture.md`](docs/architecture.md): stable intended architecture
- [`docs/flow.md`](docs/flow.md): actual execution paths
- [`docs/decision.md`](docs/decision.md): decisions and trade-offs

Academic proposal assets remain under `docs/07a74a187970d58871c4261b7922ca06/`.
