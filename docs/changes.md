# Work completed on 5 October 2026

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
