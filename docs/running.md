# Running and testing OrchestrOS

Run the commands in this guide from the project folder. On your current computer, that is:

```powershell
cd C:\Users\pranj\Desktop\OSDBMS\OrchestrOS
```

## 1. Everyday startup on your current computer

The local database and `.env` were configured on 5 October 2026. Keep that file; you do not need to copy the example over it.

Start Docker Desktop and make sure the local MySQL service is running. Docker must use Linux containers.

In the first PowerShell terminal:

```powershell
npm run docker:images
npm run dev:backend
```

In a second terminal, from the same project folder:

```powershell
npm run dev:frontend
```

Open **http://localhost:5173**. Keep the two terminals open. Press `Ctrl+C` in each to stop the app.

`docker:images` builds the fixed program used by workload containers. You can skip rebuilding it on later runs unless the workload-runner code changed or the image was removed.

## 2. First-time setup on another computer

Install Node.js 22.12 or newer, npm 10 or newer, Docker Desktop, and MySQL. Compose uses MySQL 8.4; a directly installed MySQL server must be 8.0.16 or newer. The migration was tested on MySQL 8.0.46 and on the MySQL 8.4 container.

Create `.env` only if it does not exist:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm run prisma:generate
```

For a directly installed MySQL server, create an empty database called `orchestr_os` and set `DATABASE_URL` in `.env` to its connection URL. Use your own username and password:

```text
mysql://YOUR_USER:YOUR_PASSWORD@localhost:3306/orchestr_os
```

You can create the database in MySQL Workbench or a MySQL client:

```sql
CREATE DATABASE orchestr_os CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Then create the tables and starting workers:

```powershell
npm run db:setup
npm run docker:images
```

Continue with the two-terminal startup above. Setup uses the committed migration and then creates any missing starting workers. Running setup again does not reset existing workers.

## 3. Alternative: run the whole app with Docker Compose

This option runs a separate MySQL container, the backend, and the frontend. It does not use your directly installed MySQL database.

With Docker Desktop running and `.env` available:

```powershell
npm run docker:up
```

Open **http://localhost:5173** after startup finishes. Stop the stack with:

```powershell
npm run docker:down
```

The database data stays in a Docker volume, so a normal stop does not erase it. Avoid running the two-terminal setup and the full Compose stack on the same app ports at the same time.

On your current computer, the local MySQL service uses port **3306**. The ignored `.env` sets `MYSQL_PORT=3307` for the optional Compose database, so the two database servers can coexist. They contain separate data.

The example environment uses port 3306 for Compose. On another computer that already uses this port, set `MYSQL_PORT=3307` or another free port before starting Compose.

If you run only the Compose database with a host backend, use:

```powershell
docker compose up -d --wait mysql
```

In that case, the host `DATABASE_URL` must use the published `MYSQL_PORT` and the container's application username/password.

## 4. Environment settings

Actual credentials belong in the ignored `.env` file. The example file shows the setting names and sample values.

| Setting | Meaning |
| --- | --- |
| `DATABASE_URL` | Database connection for the backend running directly on your computer |
| `DATABASE_URL_DOCKER` | Database connection inside Compose; its hostname is `mysql` and its internal port is 3306 |
| `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Application account and database created by the MySQL container |
| `MYSQL_ROOT_PASSWORD` | Administrator password used when initializing the MySQL container |
| `MYSQL_PORT` | Port used to reach the Compose database from your computer |
| `HOST`, `PORT` | Address and port for a directly running backend; normally `127.0.0.1:4000` |
| `CORS_ORIGIN` | Browser origin allowed to call the backend; normally `http://localhost:5173` |
| `FRONTEND_PORT` | Frontend port published by Compose; normally 5173 |
| `EXECUTION_TIMEOUT_SECONDS` | Longest allowed run time for a workload; default 300 seconds |
| `EXECUTION_LOG_LIMIT_BYTES` | Maximum captured output per stream; default 8192 bytes |
| `MONITORING_SAMPLE_INTERVAL_SECONDS` | Time between saved usage samples; default 15 seconds, 0 disables the timer |
| `MONITORING_SAMPLE_RETENTION_HOURS` | How long to keep samples; default 24 hours, 0 keeps them indefinitely |
| `DOCKER_SOCKET_PATH` | Connection to Docker; normally leave it unset so the app chooses the platform default |

For a host backend, monitoring settings can be added to `.env`. For a backend in Compose, add them to that service's `environment` block if you want to override its defaults.

Compose uses its application account for the database connection. Keep `DATABASE_URL_DOCKER` consistent with the `MYSQL_*` application settings. The native host connection can use a different account. Encode special characters in URL passwords, for example `@` as `%40`.

## 5. Useful URLs

| URL | What it shows |
| --- | --- |
| `http://localhost:5173` | Dashboard |
| `http://localhost:4000/api` | Basic API information |
| `http://localhost:4000/api/health` | Whether the application can read its main database tables |
| `http://localhost:4000/api/executions/runtime` | Docker connection and workload-image status |

A healthy database does not prove Docker is running. The two checks are separate.

## 6. Checks that do not need a test database

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
| `prisma:validate` | The database schema is written correctly |
| `check` | Backend JavaScript files have valid syntax |
| `build` | Backend syntax, then the frontend production build |
| `test` | Logic and request-handling tests; database/container tests are skipped unless enabled |
| `npm audit` | Known dependency problems reported by npm |
| `docker compose config --quiet` | Whether the Compose configuration is valid, without printing credentials |

The backend runs JavaScript directly, so it does not need a compiled output folder. The frontend build goes into `frontend/dist/`.

## 7. Run the database and Docker tests

Use a separate test database. Some tests deliberately choose jobs across the entire database or clear finished jobs, so do not point them at demo records you want to keep.

Create an empty MySQL database named `orchestr_os_test`. In PowerShell, replace the username/password placeholders before running:

```powershell
$env:DATABASE_URL = 'mysql://YOUR_USER:YOUR_PASSWORD@localhost:3306/orchestr_os_test'
npm run db:setup
$env:RUN_DATABASE_TESTS = 'true'
npm test
```

To also run real workload containers, start Docker Desktop and run:

```powershell
npm run docker:images
$env:RUN_DOCKER_TESTS = 'true'
npm test
```

Both flags must be set for the container tests. Test files run one at a time because they share the test database.

When finished, close this terminal or remove these temporary overrides before starting normal development:

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:RUN_DATABASE_TESTS -ErrorAction SilentlyContinue
Remove-Item Env:RUN_DOCKER_TESTS -ErrorAction SilentlyContinue
```

The recorded migration check on 5 October 2026 passed all 130 tests with both flags enabled and no skipped tests. See [the change record](changes.md).

## 8. Common problems

| Problem | What to check |
| --- | --- |
| Dashboard will not open | Is the frontend terminal still running? Open port 5173 |
| Dashboard cannot reach the API | Is the backend running on port 4000? Check its terminal output |
| Database access denied | Check the username, password, host, port, and database in `DATABASE_URL` |
| Tables are missing | Run `npm run db:setup` against the intended database |
| Prisma client is missing or out of date | Run `npm ci`, then `npm run prisma:generate` |
| Docker unavailable | Open Docker Desktop and wait for the Linux engine to start |
| Workload image missing | Run `npm run docker:images` |
| Job stays queued | Check its planned arrival time, then use Run Orchestrator |
| Job cannot get a worker | Its CPU/memory request may not fit; wait for capacity to return or use a smaller workload |
| Paused auto mode but jobs still run | Pause stops new start requests; existing containers continue |
| Job stays running after a backend crash | Restart the backend for automatic reconciliation, or use Kill all workloads to stop work and release reservations |
| Worker rings show full capacity | Rings show CPU/memory reservations, not measured physical RAM; use Kill all workloads to stop jobs and release capacity. Small worker budgets are automatic |
| Windows RAM remains high with no workloads | Check other applications and Docker/WSL memory separately; stopped workload reservations do not represent live RAM use |
| Port already in use | Stop the other instance or choose a free published port and update the related connection settings |
