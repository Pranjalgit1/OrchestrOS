# OrchestrOS Architecture

## 1. Project purpose

OrchestrOS is a Kubernetes-inspired local container orchestration prototype. It will schedule controlled computational workloads, place them on logical workers according to available resources, execute them in Docker containers, protect resource accounting with PostgreSQL transactions and row locks, monitor system state, recover interrupted work, and use workload forecasting to assist proactive autoscaling.

It is an educational OS + DBMS + container-orchestration project. It is not Kubernetes, a Kubernetes API implementation, a cloud platform, or a basic scheduling simulator.

## 2. System boundary

The complete MVP runs on one physical development machine using local CPU and RAM. OrchestrOS manages **logical workers**: database-backed representations of orchestration capacity. A logical worker is not a VM, container host, physical node, or separate computer.

Inside the boundary:

- React dashboard
- Node.js/Express modular backend
- PostgreSQL authoritative state
- Prisma persistence adapter
- Docker-controlled workload execution in a later phase
- Python/scikit-learn forecasting in a later phase

Outside the boundary:

- Cloud infrastructure and multi-machine clusters
- Kubernetes installation or API compatibility
- Arbitrary user commands and arbitrary Docker images
- Redis, Kafka, service discovery, and complex distributed networking
- GPU orchestration and authentication in the initial MVP

## 3. Architectural style and current phase

The backend is a modular monolith. Domain responsibilities are isolated by route, service, and repository boundaries while running in one Node.js process. This avoids artificial service networking on one development machine.

The npm-workspace repository contains:

```text
frontend/  React + Vite dashboard
backend/   Express API, domain modules, Prisma
postgres   Local PostgreSQL service supplied by Compose
```

Phase 1 implements the persistence and management foundation: schema migration, logical-worker seed, job and worker create/read APIs, job lifecycle rules, queued-job cancellation, structured errors, and database readiness. Later components below remain intended architecture unless `docs/flow.md` identifies a real code path.

## 4. Major components and responsibilities

| Component | Responsibility | Status |
| --- | --- | --- |
| Frontend dashboard | Display system state and call REST APIs | Foundation only |
| Backend API | Validate requests and expose modular orchestration operations | Implemented foundation |
| Job manager | Create/read jobs and enforce lifecycle/cancellation | Phase 1 implemented scope |
| Job queue | Persist queued jobs in PostgreSQL; later support concurrent scheduling | Persistence implemented; scheduling pending |
| Worker manager | Create/read logical capacity records; later manage heartbeats/state | Phase 1 implemented scope |
| Scheduler | Select the next job using FCFS, SJF, Priority, or Round Robin | Phase 3 |
| Placement manager | Select an eligible worker using First Fit, Least Loaded, or Balanced | Phase 4 |
| Resource manager | Reserve/release CPU and memory under transactions and row locks | Phase 5 |
| Container manager | Execute predefined workloads with Docker limits and capture results | Phase 6 |
| Monitoring manager | Persist operational and experiment metrics | Phase 7 |
| Reactive autoscaler | Adjust bounded logical-worker capacity using thresholds/cooldowns | Phase 8 |
| Failure detector | Detect stale heartbeats and reconcile/requeue interrupted work | Phase 9 |
| ML predictor | Forecast demand and advise the autoscaler | Phase 10–11 |
| Workload generator | Generate controlled, deterministic workloads from a seed | Phase 2 |
| Experiment manager | Re-run identical workloads across policies and compare results | Phase 12 |

## 5. Technology stack

- Frontend: React 19, Vite 8, TypeScript
- Backend: Node.js, Express 5, TypeScript, Zod
- Database: PostgreSQL 17
- ORM/database client: Prisma 6
- Runtime isolation: Docker and Docker Desktop locally
- ML: Python and scikit-learn, introduced after monitoring data exists
- Package layout: npm workspaces
- Local topology: Docker Compose
- Tests: Node.js built-in test runner executed through TSX

Exact versions are pinned in package manifests and the lockfile.

## 6. Job model and lifecycle

A job is OrchestrOS's persistent representation of a controlled workload. It records workload type, requested CPU/memory, estimated duration, priority, lifecycle timestamps, assignment/execution references, result, and failure reason. API clients cannot set status, assignment, container identity, result, or failure details when creating a job.

Required states are `CREATED`, `QUEUED`, `WAITING`, `SCHEDULED`, `RUNNING`, `COMPLETED`, `FAILED`, `INTERRUPTED`, and `CANCELLED`. Valid transitions are centralized in `job.transitions.ts`. Phase 1 creates jobs directly as `QUEUED` and exposes cancellation only for queued jobs. Repeated cancellation is idempotent. Runtime cancellation remains disabled until container termination and transactional resource release exist.

Queued jobs are stored only in PostgreSQL. There is no in-memory or Redis queue.

## 7. Logical worker model

Logical-worker capacity uses integer units:

- CPU: millicores (`1000` = one logical CPU core)
- Memory: MiB (`1024` = one GiB)

The idempotent seed creates:

| Worker | CPU | Memory |
| --- | ---: | ---: |
| `worker-1` | 2000 millicores | 2048 MiB |
| `worker-2` | 4000 millicores | 4096 MiB |
| `worker-3` | 6000 millicores | 8192 MiB |

Worker states are `STARTING`, `ACTIVE`, `IDLE`, `BUSY`, `STOPPING`, and `FAILED`. Phase 1 seeds and manually creates workers as `IDLE` with zero allocation. Capacity is accounting tracked by OrchestrOS, not evidence of separate hardware. The API validates bounded capacities and does not accept allocated counters or status from clients.

## 8. Scheduler

The scheduler answers only **which job should run next** and will implement FCFS, SJF, Priority, and Round Robin. It is not implemented in Phase 1. Scheduling policy selection must not contain worker-placement logic, and experiments must reuse the same generated workload seed.

## 9. Resource-aware placement

Placement answers **which eligible worker should run the selected job**. Planned strategies are First Fit, Least Loaded, and Resource-Aware/Balanced. Eligibility requires enough available CPU and memory on a runnable worker. This component is not implemented in Phase 1.

Any preselection result remains advisory until capacity is rechecked while holding a database row lock.

## 10. Database and consistency

PostgreSQL is the authoritative source of truth. Phase 1 introduces exactly four domain models:

- `Job`: lifecycle and controlled workload request
- `Worker`: logical capacity and allocated counters
- `ResourceAllocation`: durable future reservation/release history
- `JobExecution`: durable future execution-attempt history

The allocation and execution tables are schema foundations only; production Phase 1 code does not create allocation or execution records. Foreign keys preserve audit records, indexes support stable queue/relationship access, and SQL `CHECK` constraints enforce positive requests/capacities, bounded priority, nonnegative allocations, and no worker over-allocation. A partial unique index allows only one `RESERVED` allocation per job, while a composite foreign key guarantees each execution references an allocation for the same job and worker.

Phase 5 resource reservation and release must begin a transaction, lock the worker with `SELECT ... FOR UPDATE`, recheck capacity inside the transaction, update allocation/worker/job state atomically, and commit before starting a container. No container may start from a stale pre-transaction check.

Compose runs `prisma migrate deploy` and the idempotent worker seed in a one-shot setup service before the backend can start. Health checks query all four Phase 1 models through Prisma, so a missing required table reports degraded readiness.

## 11. Docker execution

The future container manager will be the only component permitted to access Docker. The frontend never accesses the Docker daemon. Users will select predefined workload types and validated parameters rather than commands or image names.

Phase 1 Compose containers host the application stack; they are infrastructure containers, not workload containers managed by OrchestrOS.

## 12. Monitoring

Monitoring will collect only metrics needed for operations and experiments: queue length, arrivals, job timing/outcomes, throughput, worker utilization, container state, heartbeats, scaling actions, recovery results, and transaction conflicts/waits. Important history will be stored in PostgreSQL. Monitoring is not implemented in Phase 1.

## 13. Autoscaling

Reactive autoscaling will be implemented before ML. It will enforce minimum/maximum logical workers, sustained thresholds, idle safety checks, cooldowns, and logged reasons. ML will forecast demand from actual historical metrics; the bounded autoscaler—not the model—will make capacity decisions. Neither mode is implemented in Phase 1.

## 14. Failure recovery

Workers will emit heartbeats. A stale heartbeat will eventually trigger worker failure, resource reconciliation, interruption, requeue, and traceable recovery. Controlled workloads will restart from reproducible parameters unless a later documented workload supports checkpoints. This flow is not implemented in Phase 1.

## 15. Frontend/backend and API boundary

The browser communicates only with REST endpoints under `/api`, with Vite proxying to Express. Express applies a 16 KB JSON limit, strict Zod schemas, a specific CORS origin, structured validation/domain errors, and generic internal errors.

Phase 1 endpoints are:

- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`
- `POST /api/workers`
- `GET /api/workers`
- `GET /api/workers/:id`
- `GET /api/health`

Authentication is outside the initial MVP. Published ports bind to loopback by default.

## 16. Main target data flow

```text
Workload Generator / User
          |
          v
PostgreSQL-backed Job Queue
          |
          v
Scheduler -> Placement -> Transactional Reservation
          |
          v
Controlled Docker Execution
          |
          v
Monitoring / Result -> Transactional Release
```

Supporting future loops:

```text
Monitoring -> Reactive or ML-assisted Autoscaler -> Logical worker capacity
Heartbeat -> Failure Detector -> Reconciliation -> Job requeue
Historical metrics -> ML Predictor -> Forecast -> Bounded autoscaler decision
```

## 17. Constraints

- One physical development machine
- Local CPU/RAM and Docker Desktop
- PostgreSQL source of truth; no Redis or Kafka
- Scheduler and placement stay separate
- Resource checks must be repeated under transaction locks
- Workload and resource input is strictly validated
- Reactive scaling precedes ML-assisted scaling
- Identical seeded workloads are reused in experiments
- Architecture, flow, and decision documentation changes with implementation

## 18. Explicit exclusions

The project will not implement Kubernetes, cloud provisioning, physical clusters, Kubernetes API compatibility, arbitrary commands/images, Redis, Kafka, GPU scheduling, production multi-tenant security, complex service discovery, or unrelated technologies added for appearance.

The original proposal visual remains at [`docs/image.png`](image.png). Actual implemented behavior is documented in [`docs/flow.md`](flow.md).
