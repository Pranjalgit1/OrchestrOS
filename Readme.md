# OrchestrOS

OrchestrOS runs small computing jobs in Docker containers on your computer. You create jobs in a browser, choose which job should run first, and choose how to assign jobs to workers. The app keeps track of CPU, memory, progress, and results in MySQL.

The application uses **JavaScript and MySQL**. React screens use JSX, which lets JavaScript describe the page layout.

## Run it on your current computer

Your local MySQL database, `.env` file, and three starting workers were set up on 5 October 2026. You do not need to create them again for each run.

1. Start Docker Desktop and wait until its engine is running.
2. Make sure the local MySQL service is running.
3. Open PowerShell in the project folder:

```powershell
cd C:\Users\pranj\Desktop\OSDBMS\OrchestrOS
npm run docker:images
npm run dev:backend
```

4. Open a second PowerShell window in the same folder:

```powershell
cd C:\Users\pranj\Desktop\OSDBMS\OrchestrOS
npm run dev:frontend
```

5. Open **http://localhost:5173**.

Keep both terminals open while using the app. Press `Ctrl+C` in each terminal to stop it. Build the workload image again when its code changes; it does not need rebuilding for every demonstration.

For a new computer, the all-Docker option, environment settings, and common problems, see [the run guide](docs/running.md).

## Try a short demonstration

1. Open the dashboard's Control Panel.
2. Choose **Immediate** arrival so all jobs can start now.
3. Choose **Sleep**, which is easy to watch because each job takes a few seconds.
4. Choose a scheduling policy and a placement strategy.
5. Click **Demo Mode**, or use **Generate Workload** followed by **Run Orchestrator (auto)**.
6. Watch jobs move through the pipeline and workers become busy.
7. Click a job to see its worker, reserved resources, container, and result.
8. Use **Clear finished jobs** to remove finished demo records. Queued and running jobs remain.

Pause in auto mode stops the browser from asking for more work to start. It does not stop containers that are already running.

## Understand the project in one minute

```text
Create jobs -> Save them in MySQL -> Choose the next job
    -> Choose a worker -> Reserve CPU and memory
    -> Run a Docker container -> Save the result -> Free the resources
```

| Part | What it does |
| --- | --- |
| Frontend | Shows the dashboard and sends your actions to the backend |
| Backend | Checks requests and decides what the system should do |
| MySQL | Stores jobs, workers, reservations, executions, and monitoring history |
| Scheduler | Chooses which job goes next |
| Placement | Chooses which worker should receive that job |
| Resource manager | Reserves the job's CPU and memory, then returns them after the run |
| Docker | Runs the actual workload in a container |
| Monitoring | Shows the current state and recorded history |

A **job** is one task, such as sorting numbers or multiplying matrices. A **batch** is a group of jobs created together.

A **worker** is a database record with a CPU and memory budget. The three starting workers are logical groups on your computer. They are not three separate computers, and adding a worker record does not add physical CPU or RAM.

## What works now

- Create one job or generate batches of 10, 25, 50, or 100 jobs.
- Reuse a saved batch with the same job settings.
- Choose between four scheduling policies and three placement strategies.
- Reserve CPU and memory with database checks that prevent over-allocation.
- Run five fixed workload types in real Docker containers.
- Save the result, execution time, exit code, and captured output.
- Return resources after a completed, failed, or timed-out run.
- View jobs, workers, resource use, timing summaries, and history in the browser.
- Cancel a queued job and clear finished demo records.

## What is still planned

- Automatically adding or removing workers when load changes.
- Automatically recovering work after the backend crashes.
- Stopping a running job from the dashboard.
- Pausing a running job after a Round Robin time slice and resuming it later.
- Machine-learning predictions and a complete experiment-comparison feature.

Round Robin currently records a time slice and uses scheduling rounds to order jobs. It does not yet interrupt running containers.

## Technology and folders

| Tool or folder | Purpose |
| --- | --- |
| JavaScript, Node.js, Express | Backend application and API |
| React and Vite | Browser interface and frontend build |
| MySQL and Prisma | Database and the code used to read/write it |
| Docker and Compose | Workload containers and optional full-app startup |
| `backend/src/` | Backend features and tests |
| `backend/prisma/` | Database structure, migration, and starting workers |
| `frontend/src/` | Screens, components, API calls, and styles |
| `workload-runner/` | The fixed program that runs inside each workload container |
| `docs/` | Project explanations and guides |

## Read more

Start with [the documentation guide](docs/README.md). It links to:

- [Running and testing](docs/running.md): setup, daily commands, and troubleshooting.
- [Project structure](docs/architecture.md): components, database tables, and important rules.
- [A job's journey](docs/flow.md): what happens after each action.
- [Design choices](docs/decision.md): why the project works this way.
- [API guide](docs/api.md): backend URLs and example requests.
- [Work completed on 5 October 2026](docs/changes.md): the JavaScript/MySQL migration, cleanup, local setup, and checks.

During the 5 October 2026 migration, all **130 tests passed**, including real MySQL and Docker tests. The production build and Docker Compose startup also passed. The change record explains exactly what was checked.
