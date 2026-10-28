# OrchestrOS

**A Kubernetes-inspired container orchestrator that runs on one computer.**

OrchestrOS schedules computing jobs, places them on logical workers, reserves CPU and memory inside MySQL transactions, and runs each job as a resource-limited Docker container. A React dashboard drives the whole pipeline and shows every decision as it happens.

**Repository:** [Pranjalgit1/OrchestrOS](https://github.com/Pranjalgit1/OrchestrOS)

## Features

- **Repeatable workloads.** A seeded generator creates batches of 10, 25, 50, or 100 jobs with nine arrival patterns. The same seed reproduces the same jobs and result checksums.
- **Four scheduling policies.** FCFS, SJF, Priority with aging, and Round Robin. Round Robin preempts a running job when its quantum expires and another job is waiting.
- **Three placement strategies.** First Fit, Least Loaded, and Resource-Aware.
- **Safe resource reservation.** CPU and memory are claimed in a MySQL transaction that locks the worker row, so concurrent jobs can never over-allocate a worker.
- **Real execution.** Every job runs in a locked-down container limited to exactly its reservation: no network, read-only filesystem, and capped processes.
- **Job control.** Cancel a job at any stage, including a running container. Failed jobs can be requeued, and infrastructure faults are retried automatically.
- **Reactive and ML autoscaling.** Extra logical workers are added when jobs wait on a busy cluster and retired when it is idle. A reactive strategy scales on the load measured now; an ML strategy scales on the load a linear regression predicts ahead. One runs at a time so they can be compared, and every decision is recorded with its reason.
- **Policy comparison.** Run the same workload under several policies through the real pipeline and compare waiting, turnaround, response, makespan, and throughput in colour-coded charts.
- **Reactive vs ML comparison.** Run the same workload with each autoscaling strategy and get a plain-language verdict, four "which was better?" answers, side-by-side timelines of waiting jobs and workers, and a check of how accurate the ML forecast was.
- **Live monitoring.** Reserved capacity, queue state, throughput, a reservation history chart, and lifecycle timings with p95.
- **Restart recovery.** After a crash, the backend reconciles containers and executions it was tracking.

## Technology stack

| Part | Technology |
| --- | --- |
| Frontend | React 19, Vite, plain SVG charts |
| Backend | Node.js 22, Express 5, Zod validation |
| Database | MySQL 8, Prisma 6 |
| Execution | Docker Engine API, fixed workload-runner image |
| Tests | Node's built-in test runner |

## Project structure

```text
OrchestrOS/
├── backend/            Express API, Prisma schema and migrations, tests
│   └── src/modules/    jobs, workers, workloads, scheduler, placement, resources,
│                       executions, orchestrator, monitoring, autoscaler, benchmarks
├── frontend/           React dashboard and its tests
├── workload-runner/    Program that runs inside each workload container
├── docs/               Project documentation
└── compose.yaml        Optional all-in-one Docker Compose setup
```

## Quick start

You need Node.js 22.12+, Docker Desktop (Linux containers), and MySQL 8.0.16+.

```powershell
git clone https://github.com/Pranjalgit1/OrchestrOS.git
cd OrchestrOS
Copy-Item .env.example .env        # then set DATABASE_URL to your MySQL database
npm ci
npm run prisma:generate
npm run db:setup                   # create tables and the three starting workers
npm run docker:images              # build the workload container image
```

Then start the app in two terminals:

```powershell
npm run dev:backend
npm run dev:frontend
```

Open **http://localhost:5173**. To run everything in containers instead, use `npm run docker:up`.

## Using the dashboard

| Tab | What you do there |
| --- | --- |
| **Run** | Generate a workload, choose a policy and placement strategy, and press **Run orchestrator**. Watch jobs move through the pipeline, onto workers, and through the job queue. Click a job for its details |
| **Autoscaling** | Pick the Reactive or ML predictive strategy, switch autoscaling on, and watch workers being added and retired as load changes |
| **Comparison** | Choose **Scheduling policies** to compare FCFS, SJF, Priority, and Round Robin, or **Autoscaling: Reactive vs ML** to run the same workload with each autoscaling strategy |
| **Monitoring** | Read cluster capacity, throughput, history, and timings |

## Testing

```powershell
npm run check     # backend syntax
npm run build     # backend check and frontend production build
npm test          # backend and frontend tests
```

Database and container tests are skipped unless `RUN_DATABASE_TESTS=true` (and `RUN_DOCKER_TESTS=true`) are set. Run them against a separate test database. See [the run guide](docs/running.md).

## Documentation

Start at [docs/README.md](docs/README.md). It links to:

- [Running and testing](docs/running.md)
- [Architecture](docs/architecture.md)
- [A job's journey](docs/flow.md)
- [Design choices](docs/decision.md)
- [API guide](docs/api.md)
- [Change record](docs/changes.md)

## Current limitations

- Workers are logical capacity budgets on one computer, not separate machines.
- A preempted Round Robin job restarts from the beginning; containers are not paused and resumed.
- Worker-level failure detection (heartbeats) is planned but not implemented.
- The ML autoscaling forecast is a linear trend over recent checks. It is kept in memory, so it restarts empty with the backend.
- The API has no authentication. It is meant for a local development machine, and the backend controls the host's Docker engine.

## License

No license file has been added yet. Until one is chosen, all rights are reserved by the repository owner.
