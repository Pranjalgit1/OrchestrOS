# Change record

Newest work first. The first section describes the current implementation and verification. Every later section is an explicitly historical record of what was verified at that time; later edits are not covered by an earlier check.

# Current implementation and verification

## A. One autoscaler with Reactive and ML-assisted strategies

- One shared autoscaler now exposes two mutually exclusive strategies. **Reactive** evaluates the current eligible queue and peak reserved utilization. **ML-assisted** uses ordinary least-squares forecasts over recent timestamped queue and peak-utilization observations. Both strategies share thresholds, cooldown, limits, worker creation and retirement, and scaling-event persistence.
- ML-assisted fits independent queue and utilization lines, projects them to the configured look-ahead, and waits for at least three history points. Its history is a bounded in-memory window; normal evaluations collect compatible points regardless of the selected strategy.
- Controlled comparisons clear both history and the last decision before each run. Reactive and ML-assisted therefore receive fresh histories, and ML-assisted never inherits the preceding Reactive observations.

## B. Reactive-vs-ML scaling comparisons

- The `scaling-comparisons` module runs one seeded workload twice through the real pipeline, Reactive first and ML-assisted second. It fixes scheduling, placement, generated job specifications, jobs per tick, base capacity, thresholds, worker limits, cooldown, idle period, forecast window, and look-ahead.
- Each run resets the cluster to base workers and waits out the preceding cooldown. The second run reuses the saved first batch rather than regenerating it. Recorded capacity and result checksums determine comparability.
- The service samples queue, utilization, workers, extra and idle-extra workers, and ML predictions. It stores job timings, pressure and reaction time, backlog duration, extra-worker time, idle-extra-worker time, peak workers, scaling actions, flaps, and forecast mean absolute error.
- Migration [20261101000000_scaling_comparisons](../backend/prisma/migrations/20261101000000_scaling_comparisons/migration.sql) adds `scaling_comparisons`, `scaling_comparison_runs`, and `scaling_comparison_samples`, with constraints and durable results whose batch links survive job cleanup.
- `GET` and `POST /api/scaling-comparisons`, `GET /api/scaling-comparisons/:id`, and `POST /api/scaling-comparisons/:id/abort` provide list, asynchronous start, detail, and stop operations. Startup recovery marks interrupted comparisons aborted and cancels their unfinished jobs.
- The Comparison workspace now includes **Autoscaling: Reactive vs ML** with experiment setup, live progress, stop/re-run/export actions, selectable timelines, a measured takeaway and results table, fairness notes, saved comparisons, raw run records, and predicted-versus-measured ML queue charts.

## C. Claude-style redesign and later unslop polish

- The dashboard moved to a warm Claude-style workspace with a sticky top bar, measured API/MySQL/Docker status, Light/Dark selector, and a Workloads sidebar for **Run workload**, **Autoscaling**, **Comparison**, and **Monitoring**.
- The later unslop polish standardized sentence case, spacing, weights, and card alignment; removed breadcrumbs and the capabilities panel; and made **ML-assisted** the consistent strategy name.
- Terracotta now marks primary actions and live state. Reactive is coral and ML-assisted is lavender. CPU and memory changed to neutral tones so they do not compete with strategy and policy colors. Stop controls are neutral outlines with a red warning hover.
- Zero-padded stage numbers `01`-`06`, paired with the same stage labels across the pipeline, queue, and job drawer, are the current visual signature.

## D. Concurrency and privilege details

- Reservation and release transactions retry only Prisma `P2034` deadlock-victim errors. They make four total attempts, with `20 × attempt + random(0..30)` milliseconds of jitter before each of the three retries.
- Compose bind-mounts `/var/run/docker.sock` into the backend. This grants the backend container full control of the host Docker daemon and root-equivalent host privilege. The frontend does not receive the socket.

## E. Current verification

| Check | Current result |
| --- | --- |
| Backend suite with MySQL and Docker enabled | **241 passed out of 241** |
| Frontend suite | **68 passed out of 68** |
| JavaScript syntax check | Passed |
| Frontend production build | Passed |

# Historical record: work completed on 21-23 October 2026

## A. Scheduling and job control

- **Round Robin preemption.** The quantum is enforced while the container runs. When it expires and another job is waiting, the container is stopped, the execution is recorded as `PREEMPTED`, and the job is requeued with its reservation released in one transaction. `ROUND_ROBIN_MAX_PREEMPTIONS` (default 3) caps evictions per job. A preempted job restarts from the beginning; containers are not paused and resumed.
- **Cancel at any stage.** `POST /api/jobs/:id/cancel` now also stops a running job's container before recording the cancellation.
- **Requeue and automatic retry.** `POST /api/jobs/:id/requeue` returns a failed or interrupted job to the queue. Infrastructure faults are retried automatically up to `EXECUTION_MAX_RETRIES` (default 2).
- **Placement ties** between equally loaded workers are broken by saved assignment count, so short jobs spread across workers.
- **Deadlock retries.** Reservation and execution transactions retry when MySQL picks them as a deadlock victim.
- Migration [20261021000000_preemption_and_requeue](../backend/prisma/migrations/20261021000000_preemption_and_requeue/migration.sql) adds the `PREEMPTED` status and the `preemptionCount` and `retryCount` columns.

## B. Reactive autoscaling at that time

- This release introduced the reactive strategy. The autoscaler added `auto-worker-N` workers when jobs waited on a busy cluster and retired idle ones, with a cooldown and a host-memory ceiling. Every change was recorded in `scaling_events`. A later release added the mutually exclusive ML-assisted strategy to the same autoscaler.
- Thresholds could be changed at runtime from the dashboard or `PATCH /api/autoscaler`; those controls remain available.
- Migration [20261021120000_reactive_autoscaling](../backend/prisma/migrations/20261021120000_reactive_autoscaling/migration.sql) added the `RETIRED` worker status, the `autoscaled` flag, and `scaling_events`.

## C. Multi-policy benchmark

- The new benchmarks module runs one seeded workload once per scheduling policy through the real pipeline and stores waiting, turnaround, response, makespan, throughput, and preemption metrics per run.
- Fairness is enforced, not assumed: a suite needs an idle cluster, pipeline-changing routes return 409 `BENCHMARK_RUNNING` while it runs, the autoscaler is paused, later runs reuse the first batch, and equal checksum digests prove identical work.
- Migration [20261023000000_policy_benchmarks](../backend/prisma/migrations/20261023000000_policy_benchmarks/migration.sql) adds `benchmark_suites` and `benchmark_runs`.
- A live check on 23 October ran FCFS, SJF, and Round Robin on 10 sleep jobs each: all runs completed with identical checksums and equal capacity, and the stop button left nothing unfinished.

## D. First dashboard redesign, later superseded

These bullets describe the first dashboard redesign as it looked in October. The current shell and color system are recorded above.

- Four tabs replaced the single long page: **Run**, **Autoscaling**, **Policy comparison**, and **Monitoring**, under a sticky header that showed the connection state.
- A sticky run bar held policy, placement, jobs per tick, Run / Pause, and Kill all. Generating and cleaning up work moved into a collapsible Workload panel.
- Job details opened in a side drawer. Worker cards showed finished attempts (`jobsCompleted` and `jobsFailed` were added to `GET /api/orchestrator/state`), and the duplicate workers table in Monitoring was removed.
- The autoscaler panel was simplified to an **Autoscaling: On/Off** switch, four signal cards, and one decision line, with the rules and history collapsed. The manual **Evaluate now** button was removed; scaling became automatic.
- Monitoring showed reserved capacity, queue, throughput, and running containers as a 2 × 2 block.
- At that stage, green and red marked start and stop, CPU was blue, memory was green, and each policy had one comparison-chart color. The later polish replaced these semantics as described in the current section.

## E. Historical verification for that release

These checks describe the 21-23 October state and are superseded by the current verification section above.

| Check | Recorded result |
| --- | --- |
| Full backend suite with MySQL and Docker enabled (23 October, before the dashboard redesign) | **210 passed, 0 failed, 0 skipped** |
| Backend suite without database or Docker (after the redesign) | 158 passed, 52 skipped, 0 failed |
| Frontend suite (after the redesign) | **33 passed, 0 failed** |
| Frontend production build | Passed |
| Prisma schema validation | Passed |
| npm dependency audit | One high-severity advisory in the Vite 8.3.0 dev server; fixed in Vite 8.3.2 and later |

The per-worker finished-attempt counts added during the redesign were checked against live data and matched `/api/monitoring/overview`; the database-enabled suite was not rerun after that change.

# Historical record: work completed on 5 October 2026

This records the JavaScript/MySQL migration and the documentation update. The scheduling, placement, workload, execution, and monitoring features already existed; the migration converted and verified them rather than claiming they were all newly built that day.

## 1. Application code now uses JavaScript

- Converted backend application files and tests to `.js`.
- Converted React components to `.jsx` and frontend API code to `.js`.
- Converted the Prisma seed script and Vite configuration to JavaScript.
- Updated imports and the frontend HTML entry point to the new filenames.
- Removed the old typed-language source files, compiler settings, compiler package, runner package, and direct type-only development packages.
- Changed backend development startup to `node --watch src/server.js`.
- Changed normal backend startup to `node src/server.js`.
- Changed tests to use Node's own test runner directly.
- Added `backend/scripts/check.js` and `npm run check` for JavaScript syntax checks.
- Changed the root build command to check the backend and build the frontend with Vite.
- Updated the backend Dockerfile to check JavaScript instead of compiling a backend output folder.
- Removed stale backend compiled files, source maps, and the old local monitoring log.

The backend now runs its source files directly. The frontend still needs a production build when it is packaged for deployment.

## 2. Database setup now uses MySQL

- Changed the Prisma datasource to MySQL.
- Replaced the old database migration history with one fresh MySQL migration: [20261005000000_mysql_initial](../backend/prisma/migrations/20261005000000_mysql_initial/migration.sql).
- Updated the migration provider lock to MySQL.
- Stored UUID identifiers as `CHAR(36)` and kept structured values as JSON.
- Used text columns suitable for saved failure messages and container output.
- Kept the job, worker, batch, scheduling, allocation, and execution constraints in SQL.
- Kept the relationship that requires an execution's job and worker to match its allocation.
- Added a functional unique index that rejects a second live reservation for the same job while allowing released allocation history.
- Kept the worker/status lookup index in the Prisma schema.
- Used restrictive ID-update and worker-deletion rules so referenced records remain valid.
- Updated the deploy and seed commands to load the local environment. `db:setup` runs deployment followed by seeding.

This is a fresh MySQL setup. No existing data from another database engine was copied into it. Use the committed migration so its extra SQL constraints and unique index are created too.

## 3. Database-specific application queries were converted

Reservation and execution code now use MySQL row-lock queries and identifiers. These locks still protect capacity checks and job claims.

Monitoring queries were also updated:

| Change | Why it matters |
| --- | --- |
| MySQL timestamp differences | Keeps fractional-second timing measurements |
| Ranked rows and interpolation for p95 | Keeps the same percentile meaning, including ties and small samples |
| Conditional counts | Counts active reservations and execution outcomes using MySQL syntax |
| MySQL UUID generation for samples | Gives each saved sample an ID |
| No-op duplicate-key handling | Repeating a sampling timestamp does not add a second sample |
| Numeric result conversion | The API returns normal JSON numbers rather than database-specific number objects |

## 4. Compose, environment, and dependencies were cleaned up

- Replaced the database service with MySQL 8.4.
- Added MySQL application-account and administrator-password settings.
- Added a health check that logs in and runs `SELECT 1` before database setup starts.
- Changed the database volume to MySQL's data location.
- Updated host and container database URLs, ports, and service dependencies.
- Updated `.env.example`, the ignored local `.env`, and the database ignore rule.
- Made backend environment validation require a MySQL connection URL.
- Updated dashboard labels and documentation to describe the actual stack.
- Updated the academic slide source's technology list to JavaScript and MySQL.
- Rebuilt `package-lock.json` from the workspace manifests, then checked a clean `npm ci` install.
- Removed unused packages, including leftover packages from the former source runner.

The final application-file audit found no old language source/configuration files, old database references, or unwanted installed dependency entries. Standard third-party packages may contain their own optional peer metadata and type declarations; those are not application source or selected compiler dependencies.

## 5. Your local setup was prepared

The MySQL login you supplied was tested against your local server. The `orchestr_os` database did not already exist, so it was created and initialized without replacing an existing database.

The ignored `.env` now points the native backend at local MySQL on port 3306 using your supplied login. Credentials were kept out of tracked documentation.

The migration was applied and the three starting workers were created. The optional Compose database uses host port 3307 in your local `.env`, avoiding a clash with the native MySQL service on port 3306. Compose keeps its own application account and separate database data.

Docker Desktop was started for verification, and the fixed workload-runner image was built. Temporary database and Compose services used for tests were stopped afterward. The local `orchestr_os` database and your `.env` were kept for normal use.

## 6. Verification completed during the migration

| Check | Recorded result |
| --- | --- |
| Prisma schema validation | Passed |
| Prisma client generation | Passed |
| Fresh database migration and worker seed | Passed on MySQL 8.0.46 and the MySQL 8.4 Compose service |
| Repeated setup | Completed without resetting the starting workers |
| JavaScript syntax check | Passed |
| Frontend production build | Passed |
| Full test suite with database and Docker enabled | **130 passed, 0 failed, 0 skipped** |
| Clean `npm ci` install | Passed |
| npm dependency audit | No vulnerabilities reported at that time |
| Installed package list | No unused extra packages remained |
| Compose build and startup | Database, setup job, backend, and frontend started successfully |
| HTTP smoke checks | Native health, frontend page, frontend-to-backend health, monitoring, and orchestrator state returned HTTP 200 |
| Repository cleanup scan | No old application source/configuration or database setup leftovers found |

Two focused MySQL tests were added:

1. Timing results retain fractional values and handle ties, one measurement, and an empty window. Their numeric values can be sent as JSON.
2. The database itself rejects two live reservations, allows historical allocations, and rejects changing an old allocation back to reserved when another live reservation exists.

Existing tests also checked reservation concurrency, rollback, duplicate job claims, execution constraints, resource release, API responses, monitoring samples, and real container outcomes.

These results describe the verified migration state on 5 October 2026. They are not a claim that every later edit has automatically been tested.

## 7. Documentation was rewritten for easier reading

- Replaced the long opening explanation with a short project overview and everyday run commands.
- Added a documentation starting page and a glossary.
- Added a run guide for the current computer, a fresh setup, the Compose option, tests, environment variables, and common problems.
- Rewrote the architecture page to explain each component and table in plain language.
- Rewrote the flow page to follow a job from creation to cleanup.
- Replaced repeated formal decision sections with short explanations of the current choices.
- Added a separate API reference so the main README is easier to read.
- Added this change record covering the code conversion, database migration, cleanup, local setup, and verification.
- Made unfinished features clear, especially automatic recovery and actual Round Robin pause/resume behavior.

The documentation update changes explanations and examples, not application behavior. Its check covered 8 Markdown documents, 30 local links, 20 npm-command references, 34 API routes, and 8 example request bodies. The links and commands matched the repository, the routes matched the backend, and the request examples passed the actual input validators. No old stack references were found in these guides. The container workload suite was not rerun for this documentation-only update.

For the next run, follow [Running and testing](running.md).
