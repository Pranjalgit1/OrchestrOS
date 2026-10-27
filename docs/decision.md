# Why the project works this way

This is a plain-language summary of the current design choices. It includes the early project decisions, the JavaScript/MySQL update completed on 5 October 2026, and the scheduling, autoscaling, benchmark, and dashboard work from 21-23 October 2026.

## 1. Keep the app in one repository

The frontend and backend are npm workspaces in the same repository. A command at the project root can install packages or run checks for both.

The backend runs as one Express application, divided into feature folders. This is simpler for a project that runs on one computer. Separate network services would add more setup and failure points without helping the current demonstration.

## 2. Use JavaScript and MySQL throughout

The backend, tests, seed script, and build configuration use JavaScript. React components use JSX. Node runs the backend directly, and Vite builds the frontend.

MySQL is the only application database. Jobs and reservations live there, so a restart does not erase the queue. Prisma handles most reads and writes.

See [the change record](changes.md) for the conversion, cleanup, and checks carried out on 5 October 2026.

## 3. Pin package versions

The package files use exact versions, and `package-lock.json` records the full dependency tree. `npm ci` installs those recorded versions.

This makes the project easier to reproduce on another computer. Dependency updates should be deliberate and followed by checks. The migration kept the established React, Vite, Express, and Prisma versions while removing packages no longer needed.

## 4. Support both local development and Compose

Two terminals are convenient when editing the backend and frontend. Compose is useful when starting the whole system together.

Compose starts MySQL first, applies the migration, seeds workers, then starts the backend and frontend. The backend should not report ready before its main tables can be read.

Published ports bind to the local computer by default. Database and Docker health have separate endpoints, because a working database does not mean the container engine is available.

## 5. Create missing workers without resetting existing ones

The seed script looks up workers by name. It creates `worker-1`, `worker-2`, and `worker-3` if missing and applies built-in study budgets of 512/1024/1536 MiB to idle defaults. Row locks protect active reservations from capacity changes. Backend startup and periodic recovery use the same setup helper.

This allows setup to run again without resetting a worker's status or reservation counters.

## 6. Keep database rules as well as request checks

Request validation gives users useful error messages. Database constraints also protect records if a later code change sends bad data.

MySQL checks resource bounds, batch and scheduling fields, allocation uniqueness, execution identity, container IDs, output sizes, and completion fields. Foreign keys keep related records connected.

The schema uses `CHAR(36)` for UUID identifiers, JSON for structured values, and suitable text columns for output. IDs cannot be changed through cascading updates. Deleting a worker still referenced by a job is restricted so the job does not lose its recorded worker.

Use `db:setup` or `db:deploy` to install the committed SQL migration. Creating tables from the Prisma model alone can miss SQL-only rules, such as the unique index for a live reservation.

## 7. Make generated workloads repeatable

A versioned seeded generator produces repeatable job specifications. This lets you compare scheduling or placement choices using the same input.

Each job gets its own sampled settings. Standard patterns derive workload size from resource and duration estimates; custom patterns accept bounded explicit ranges. Manual jobs can omit size and use the default of 1.

Batch reuse copies saved specifications instead of rerunning the generator. Changing the generator later therefore does not silently change an old batch's inputs.

## 8. Separate scheduling, placement, and reservation

These steps answer different questions:

- Scheduling: which job should go next?
- Placement: which worker should receive it?
- Reservation: can that worker actually grant its resources now?

Keeping the steps separate makes them easier to explain, test, and compare. A placement is only a plan. Reservation rechecks the database before granting capacity.

## 9. Keep scheduling rules small and explainable

FCFS uses arrival order. SJF uses estimated duration. Priority uses urgency plus waiting-time aging. Round Robin uses previous scheduling rounds and records a time slice.

The job is updated only if it is still queued, so competing requests cannot both claim it. Priority aging helps long-waiting jobs get a turn.

Round Robin preemption evicts and requeues instead of pausing. A paused container still holds its memory, so pausing would free no capacity for the waiting job. Splitting one reservation into a CPU part and a memory part would complicate the locking and accounting described in section 11. Eviction reuses the existing outcome-and-release transaction. Its cost is that a preempted job restarts from the beginning. That is acceptable for deterministic workloads, and it is bounded in three ways:

- A job is only evicted while another job is waiting.
- Each job has a preemption cap (`ROUND_ROBIN_MAX_PREEMPTIONS`).
- A run that finishes at the quantum boundary keeps its result.

Automatic retries are limited to infrastructure faults where the workload never got a fair run. Deterministic failures would repeat, so they wait for an operator's requeue.

## 10. Account for planned worker load

Placement includes saved reservations and the requirements of assigned jobs without a live reservation. Reserved jobs are already represented by worker counters and must not be counted again as advisory load.

First Fit chooses the first suitable worker. Least Loaded checks current usage. Resource Aware estimates usage after adding the new job and prefers lower, more balanced CPU and memory usage. Its formula is visible in the code rather than hidden in a model.

Least Loaded and Resource Aware break equal-score ties using the number of saved jobs assigned to each worker, then name. This avoids repeatedly choosing worker-1 when short jobs finish between dispatches. The count comes from database records, so previews do not change it and backend restarts do not reset it. It reflects retained history rather than a permanent lifetime counter. Scores and eligibility still take priority; First Fit remains ordered by name.

## 11. Lock the worker when reserving capacity

Two requests can arrive at almost the same time. A worker-row lock makes competing reservations wait and check the latest capacity before writing.

The allocation and worker-counter updates belong to one transaction. A failure undoes both. The code checks an existing reservation before checking remaining space, so a duplicate request gets a duplicate-reservation answer rather than a misleading capacity error.

Transactions allow up to 15 seconds to obtain a connection and 20 seconds to finish. This gives real lock waits time to complete. `lockWaitMs` shows how long the row-lock step took.

A MySQL functional unique index permits only one reserved allocation per job while keeping older allocations as history. Capacity check constraints provide another database-level safeguard.

Reservation keeps the job scheduled. Execution is the step that changes it to running.

## 12. Run only the fixed workload image

The backend builds container requests for one known image and five known workloads. Users cannot submit arbitrary commands, images, or scripts.

The runner limits work size and accounts for its memory budget. It reports the actual `effectiveSize` used. The job name determines the execution seed, which helps reused jobs reproduce the same checksum.

The backend uses Docker's HTTP API directly instead of adding a separate Docker client package. It handles API-version negotiation and separates captured standard output from error output.

In Compose, the backend needs the host Docker socket to start containers. That gives it control over Docker on the development machine. The browser does not receive this access. Workload containers themselves have resource limits, no network, and restricted filesystem and process permissions.

## 13. Return from a start request before the workload finishes

A long workload should not hold the browser's request open. The backend claims the job, starts its container, then watches for completion separately.

Claiming locks the job record so two start requests do not launch the same job twice. Finishing saves the result and releases resources together. Repeating an already finished settle operation returns the saved result.

A time limit produces `INTERRUPTED`. A bad exit or invalid result produces `FAILED`. A missing container produces an explicit failure. None of these paths invents a successful result.

Manual settle exists for finished work that was not recorded correctly after an interruption. Startup and periodic reconciliation now recover untracked open executions; the Kill all workloads action handles explicit cancellation and orphan container cleanup.

## 14. Calculate current metrics from the actual records

Job counts, current reservations, and outcomes come from the same records the application uses. There is no separate set of monitoring counters to keep updated.

History is different: current counters cannot tell us what usage was an hour ago. The sampler saves timestamped worker snapshots for that purpose. It writes only monitoring history, not job or reservation state.

A repeated pass at the same timestamp does not create duplicates. Each pass also removes expired history. Query windows have limits so one dashboard request cannot ask for unlimited history.

## 15. Make empty results honest

An unmeasured timing stage has count 0. A success rate with no outcomes is `null`, meaning there is not enough data yet.

MySQL calculates timing differences and p95. JavaScript converts the returned numeric values into numbers the API can send as JSON. Small charts use the existing frontend tools without a chart-library dependency.

## 16. Let the browser control the backend workflow

The dashboard is the normal demonstration interface. It calls the orchestrator API rather than making users run four separate API commands for each job.

The backend still owns all decisions. Per-stage buttons, now inside the job details drawer, remain useful for learning and debugging. Browser auto mode repeats run requests; pausing it does not kill running work.

Autoscaling is automatic only. The dashboard has no manual evaluate button, because the backend timer already checks every few seconds and a second trigger mostly caused confusion with a refresh. `POST /api/autoscaler/evaluate` stays for tests and direct API use.

The Immediate demo uses a valid custom batch with all arrival offsets set to zero. It does not need a separate demo-only backend path.

Clear finished jobs is a backend transaction that removes finished job records and their related history in the required order. It leaves queued and running jobs out of the selection.

## 17. Scale logical workers reactively, and retire instead of delete

Scaling reacts to observed signals: waiting jobs and reserved capacity. It does not use forecasts, which keeps every decision explainable from one database snapshot and recorded with its reason. Requiring both a queue and high utilization avoids adding workers when jobs are only waiting for the next orchestrator pass. Separate scale-up and scale-down thresholds plus a cooldown prevent flapping.

Workers are retired rather than deleted because jobs, allocations, and executions keep foreign keys to the worker that ran them. Retirement keeps that history intact, and scale-up reuses retired workers so rows do not accumulate. A host-memory ceiling keeps the combined logical budgets within what the computer can plausibly back.

Runtime settings are held in memory. They are an operator's experiment knobs, while the environment holds the defaults and the event history in MySQL is the durable record.

## 18. Benchmark policies on the real pipeline, one at a time

A comparison is only fair if every policy does the same work on the same capacity, so the benchmark controls both instead of trusting the operator to.

- **Isolation by refusal, not filtering.** The scheduler, the resume lookup, and Round Robin preemption all look at every job. Scoping them to one batch would change how the console behaves. Instead, a suite needs an idle cluster to start, and while it runs, routes that change the pipeline return 409. Kill all workloads is still allowed, because an emergency stop should never be blocked.
- **Reuse, don't regenerate.** Later runs copy the first run's batch through the existing reuse path. Equal result checksums then prove the work was identical, rather than assuming it.
- **Pause the autoscaler instead of disabling it.** A disabled autoscaler still retires idle autoscaled workers, which would change capacity between runs. Pausing freezes the cluster as it is.
- **Store results as columns.** Metrics are copied onto the run row when it ends, and the batch link is `ON DELETE SET NULL`. Clearing finished jobs therefore keeps the results. CHECK constraints keep counts and timings non-negative.
- **Waiting excludes run time.** Waiting subtracts the time spent running across all attempts, so a preempted Round Robin job's second queue stay counts as waiting.

## 19. Organise the dashboard by task, and use colour only for meaning

The single long page needed a lot of scrolling and showed some information two or three times. It is now four tabs, each roughly one screen: Run, Autoscaling, Policy comparison, and Monitoring.

- **Tabs, not a longer page.** The current tab lives in the URL hash, so reloads and links keep the view. The orchestrator component stays mounted on every tab, so leaving the Run tab never stops a run.
- **Controls always in reach.** Policy, placement, jobs per tick, Run / Pause, and Kill all sit in one sticky run bar. Generating work is a separate Workload panel that starts open on an empty cluster and folds away afterwards.
- **One place per fact.** Worker cards carry each worker's finished attempts, which replaced the second workers table in Monitoring. Job details open in a drawer instead of keeping a mostly empty column on screen.
- **Colour is a signal.** Surfaces stay white and monochrome. Green buttons start actions and red buttons stop them, both with white text. CPU is always blue and memory always green. Each policy keeps one colour across the comparison. Labels, icons, ★, and BEST text still carry the meaning for anyone who cannot rely on colour.

## 20. Use both small tests and real-system tests

Services can receive simple in-memory replacements for database or Docker operations. This lets small tests check their rules quickly. Frontend views are rendered on the server in tests, so their states can be checked without a browser or backend.

Separate integration tests use real MySQL and Docker to check constraints, concurrent requests, rollback, resource release, and actual container results. Test files run one at a time because some operations work across the whole test database.

The migration's full verification passed 130 tests. The latest full backend run with MySQL and Docker enabled passed 210 tests (23 October 2026), and the frontend suite has 33 tests. See [the change record](changes.md) for details and [the run guide](running.md) for the commands.
