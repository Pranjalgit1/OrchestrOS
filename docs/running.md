# Running OrchestrOS

Run commands from the project folder. On the current computer:

```powershell
Set-Location C:\Users\pranj\Desktop\OSDBMS\OrchestrOS
```

## 1. Everyday startup on your current computer

The local database and `.env` were configured on 5 October 2026. Keep that file; do not overwrite it with the example.

Start Docker Desktop with Linux containers and make sure the local MySQL service is running.

In the first PowerShell terminal:

```powershell
npm run docker:images
npm run dev:backend
```

In a second terminal, from the same project folder:

```powershell
npm run dev:frontend
```

Open **http://localhost:5173**. Keep both terminals open; press `Ctrl+C` in each to stop the app.

The interface opens on **Run workload**. Generate work with **Add workload** or **Try a demo · 10 jobs**, then select **Run orchestrator**. The **Workloads** sidebar also contains **Autoscaling**, **Comparison**, and **Monitoring**. Comparison has **Autoscaling: Reactive vs ML** and **Scheduling policies** modes. See [the job flow](flow.md) for pipeline details.

`docker:images` builds the fixed program used by workload containers. Rebuild it only when the workload runner changes or the image has been removed.

### After pulling database changes

The committed migrations currently end with policy benchmarks and scaling comparisons. After pulling migration or Prisma schema changes:

```powershell
# Stop the backend first on Windows, then run:
npm run db:deploy
npm run prisma:generate
```

A running backend can lock Prisma's generated engine on Windows. An unapplied migration or stale generated client can appear as an unknown column, a missing table, or a missing Prisma model/property.

If deployment fails:

1. Confirm `DATABASE_URL` points to the intended host database, not the Compose or test database.
2. Stop every backend process using that database/client.
3. Run `npm run db:deploy`, read the first migration error, and then run `npm run prisma:generate` only after deployment succeeds.
4. Do not edit `_prisma_migrations` or mark a failed migration as applied without diagnosing what SQL succeeded. Repair failed production migrations case by case.

`npm run db:setup` runs deployment and the idempotent starting-worker seed. It is appropriate for a new empty database and safe to repeat, but it does not reset existing workers.

## 2. First-time setup on another computer

Install Node.js 22.12 or newer, npm 10 or newer, Docker Desktop, and MySQL. Compose uses MySQL 8.4; a directly installed server must be MySQL 8.0.16 or newer. Migrations have been tested on MySQL 8.0.46 and the MySQL 8.4 container.

Create `.env` only if it does not exist:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm run prisma:generate
```

For a directly installed MySQL server, create an empty `orchestr_os` database and set `DATABASE_URL` in `.env` with your own credentials:

```text
mysql://YOUR_USER:YOUR_PASSWORD@localhost:3306/orchestr_os
```

```sql
CREATE DATABASE orchestr_os CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Create the tables, starting workers, and workload image:

```powershell
npm run db:setup
npm run docker:images
```

Continue with the two-terminal startup above.

## 3. Alternative: Docker Compose

Compose runs a separate MySQL container, backend, and frontend. It does not use a directly installed MySQL database.

```powershell
npm run docker:up
```

Open **http://localhost:5173** after startup finishes. Stop the stack with:

```powershell
npm run docker:down
```

Database data remains in a Docker volume. Do not run the host app and full Compose stack on the same app ports simultaneously.

On the current computer, local MySQL uses port **3306** and the ignored `.env` sets `MYSQL_PORT=3307` for Compose. These servers contain separate data. On another computer where 3306 is occupied, set `MYSQL_PORT` to a free port before starting Compose.

To run only the Compose database with a host backend:

```powershell
docker compose up -d --wait mysql
```

The host `DATABASE_URL` must then use the published `MYSQL_PORT` and the container's application credentials.

## 4. Environment and runtime settings

Credentials belong in the ignored `.env`. Encode special characters in URL passwords, for example `@` as `%40`.

### Startup environment

These values are read when the backend starts. Changing `.env` requires a restart.

| Setting | Meaning |
| --- | --- |
| `DATABASE_URL` | Database connection for a host backend |
| `DATABASE_URL_DOCKER` | Compose backend connection; hostname `mysql`, internal port 3306 |
| `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Application account and database created by Compose MySQL |
| `MYSQL_ROOT_PASSWORD` | MySQL container initialization password |
| `MYSQL_PORT` | Host port for the Compose database |
| `HOST`, `PORT` | Host backend address; normally `127.0.0.1:4000` |
| `CORS_ORIGIN` | Browser origin allowed to call the backend; normally `http://localhost:5173` |
| `FRONTEND_PORT` | Frontend port published by Compose; normally 5173 |
| `EXECUTION_TIMEOUT_SECONDS` | Workload timeout; default 300 seconds |
| `EXECUTION_LOG_LIMIT_BYTES` | Captured output limit per stream; default 8192 bytes |
| `EXECUTION_MAX_RETRIES` | Requeues after infrastructure faults; default 2, 0 disables |
| `ROUND_ROBIN_MAX_PREEMPTIONS` | Evictions per job before it runs to completion; default 3, 0 disables |
| `AUTOSCALE_ENABLED` | Initial autoscaling state; default `false` |
| `AUTOSCALE_INTERVAL_SECONDS` | Evaluation interval; default 5 seconds, 0 disables the loop |
| `AUTOSCALE_MAX_WORKERS` | Initial maximum extra workers; default 3 |
| `AUTOSCALE_WORKER_CPU_MILLICORES` | Initial CPU per extra worker; default 1000m |
| `AUTOSCALE_WORKER_MEMORY_MIB` | Initial memory per extra worker; default 512 MiB |
| `MONITORING_SAMPLE_INTERVAL_SECONDS` | Saved-sample interval; default 15 seconds, 0 disables periodic sampling |
| `MONITORING_SAMPLE_RETENTION_HOURS` | Saved-sample retention; default 24 hours, 0 keeps samples indefinitely |
| `DOCKER_SOCKET_PATH` | Docker connection; normally unset so the platform default is used |

Compose passes only settings listed in the backend service's `environment` block. Add the monitoring variables there to override defaults in Compose; putting them only in `.env` does not automatically pass them through.

The monitoring UI reads cluster overview every 2 seconds and 60-minute job/sample history every 5 seconds. Service health is checked every 10 seconds and Docker every 15 seconds. **Refresh now** requests fresh data; **Save snapshot** records a sample manually. Periodic sampling and retention remain backend settings.

### Autoscaling settings changed at runtime

The **Autoscaling** view updates in-memory settings through the API. Changes take effect without restarting, but revert on backend restart:

- enabled state and one active strategy: **Reactive** or **ML-assisted**
- maximum extra workers and each worker's CPU/memory capacity
- queue, scale-up utilization, and scale-down utilization thresholds
- idle and cooldown durations
- ML sliding-window size (3–100 points) and look-ahead (5–300 seconds)

Defaults not provided by startup environment are Reactive, queue threshold 2, scale-up 75%, scale-down 40%, idle 30 seconds, cooldown 15 seconds, 20 ML history points, and a 60-second look-ahead. `AUTOSCALE_INTERVAL_SECONDS` is startup-only. Runtime settings and the in-memory ML history reset on restart; scaling events remain in MySQL. Settings cannot be changed while either comparison experiment is active.

## 5. Useful URLs

| URL | What it shows |
| --- | --- |
| `http://localhost:5173` | Interface |
| `http://localhost:4000/api` | Basic API information |
| `http://localhost:4000/api/health` | API and main-table database health |
| `http://localhost:4000/api/executions/runtime` | Docker and workload-image status |
| `http://localhost:4000/api/monitoring/config` | Effective monitoring sample interval and retention |

Database health does not prove Docker is available; check both.

## 6. Checks and tests

```powershell
npm run prisma:validate
npm run check
npm run build
npm test
npm audit
docker compose config --quiet
```

| Command | What it checks |
| --- | --- |
| `prisma:validate` | Prisma schema validity |
| `check` | Backend JavaScript syntax |
| `build` | Backend check and frontend production build |
| `test` | Backend and frontend suites; database/container tests need flags |
| `npm audit` | Dependency advisories |
| `docker compose config --quiet` | Compose configuration without printing credentials |

The backend runs JavaScript directly. The frontend build goes to `frontend/dist/`. Run one suite with `npm test --workspace backend` or `npm test --workspace frontend`.

Current session results:

- Backend: **241 passed, 0 skipped**, with MySQL and Docker tests enabled.
- Frontend: **68 passed**.
- `npm run check` and `npm run build`: **passed**.

## 7. Database and Docker tests

Use a separate database. Some tests select jobs across the database or clear finished jobs.

```powershell
$env:DATABASE_URL = 'mysql://YOUR_USER:YOUR_PASSWORD@localhost:3306/orchestr_os_test'
npm run db:setup
$env:RUN_DATABASE_TESTS = 'true'
npm test
```

To include real workload containers:

```powershell
npm run docker:images
$env:RUN_DOCKER_TESTS = 'true'
npm test
```

Both flags are required for container tests. Backend test files run one at a time because they share the database. Use `orchestr_os_test`, not everyday `orchestr_os`; comparison tests also require an idle cluster.

Remove temporary overrides afterward:

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:RUN_DATABASE_TESTS -ErrorAction SilentlyContinue
Remove-Item Env:RUN_DOCKER_TESTS -ErrorAction SilentlyContinue
```

## 8. Common problems

| Problem | What to check |
| --- | --- |
| Interface will not open | Keep the frontend running and check port 5173 |
| Interface cannot reach the API | Check the backend on port 4000 and its terminal output |
| Database access denied | Check credentials, host, port, and database in `DATABASE_URL` |
| Tables, comparison models, or fields are missing | Stop the backend; run `npm run db:deploy`, then `npm run prisma:generate`, against the intended database |
| Migration deployment fails | Read the first database error and inspect what was applied; do not blindly edit migration history |
| Prisma client is missing or locked | Stop backend processes, run `npm ci`, then `npm run prisma:generate` |
| Docker unavailable | Start Docker Desktop and wait for the Linux engine |
| Workload image missing | Run `npm run docker:images` |
| Job stays queued | Check planned arrival, then use **Run orchestrator** |
| Job cannot get a worker | Its CPU/memory request may not fit; wait for capacity or use a smaller workload |
| Paused orchestration but jobs still run | **Pause** stops new starts; existing containers continue |
| Job remains running after a backend crash | Restart for reconciliation, or use **Kill all** to stop work and release reservations |
| Worker rings appear full | They show reservations, not measured host RAM; stop workloads to release reservations |
| Windows RAM stays high with no workloads | Check other applications and Docker/WSL memory separately |
| Port already in use | Stop the other instance or update the related port and connection settings |

### Comparison problems

| Problem | What to check |
| --- | --- |
| Comparison says the cluster is not idle | Let all queued/running jobs finish or use **Kill all**, then retry |
| A policy benchmark or autoscaling comparison is already running | The two experiment types are mutually exclusive; wait, use **Stop benchmark**/**Stop comparison**, or use **Kill all** for an emergency abort |
| Pipeline or autoscaler settings are locked | Adding/clearing jobs, manual pipeline actions, and autoscaler changes are blocked during an experiment |
| Autoscaling comparison says its timer is off | Set `AUTOSCALE_INTERVAL_SECONDS` above 0 and restart the backend |
| Autoscaling comparison says no extra capacity is allowed | Set **Most extra workers** above 0 before starting it |
| Cluster reset says extra workers still hold work | Stop remaining workloads and wait for reservations to release before retrying |
| Comparison workload image is missing | Run `npm run docker:images` |
| Comparison was abandoned after restart | Experiments run in the backend process; startup marks interrupted runs aborted. Start a new comparison |
| Reactive and ML look identical | Confirm extra-worker capacity is above 0 and choose a workload that crosses the shared queue/utilization thresholds |
| Comparison tables or Prisma models are missing after pulling | Apply the latest migrations with `npm run db:deploy`, then regenerate with `npm run prisma:generate` |
