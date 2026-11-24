# Why the project works this way

This is a plain-language summary of the current design choices. It includes the early project decisions, the JavaScript/MySQL update completed on 5 October 2026, and the later scheduling, autoscaling, comparison, and dashboard work.

## 1. Keep the app in one repository

The frontend and backend are npm workspaces in the same repository. A command at the project root can install packages or run checks for both.

The backend runs as one Express application, divided into feature folders. This is simpler for a project that runs on one computer. Separate network services would add more setup and failure points without helping the current demonstration.

## 2. Use JavaScript and MySQL throughout

The backend, tests, seed script, and build configuration use JavaScript. React components use JSX. Node runs the backend directly, and Vite builds the frontend.

MySQL is the only application database. Jobs and reservations live there, so a restart does not erase the queue. Prisma handles most reads and writes.

See [the change record](changes.md) for the conversion, cleanup, and checks carried out on 5 October 2026.

## 3. Lock the installed dependency tree

Most application and development dependencies use exact versions in the workspace package files. The two Fontsource packages use compatible caret ranges, and the Node and npm engine fields specify minimum versions. `package-lock.json` records the exact resolved dependency tree, so `npm ci` installs the locked versions.

This makes the project easier to reproduce on another computer. Dependency updates should be deliberate and followed by checks. The migration kept the established React, Vite, Express, and Prisma packages while removing packages no longer needed.

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

MySQL can resolve a deadlock by rolling one transaction back and reporting Prisma error `P2034`. Reservation and release transactions retry only that error, with four total attempts. The waits before the three retries are `20 × attempt + random(0..30)` milliseconds, which adds jitter so concurrent transactions are less likely to collide again. Other errors, and a fourth `P2034`, are returned to the caller.

A MySQL functional unique index permits only one reserved allocation per job while keeping older allocations as history. Capacity check constraints provide another database-level safeguard.

Reservation keeps the job scheduled. Execution is the step that changes it to running.

## 12. Run only the fixed workload image

The backend builds container requests for one known image and five known workloads. Users cannot submit arbitrary commands, images, or scripts.

The runner limits work size and accounts for its memory budget. It reports the actual `effectiveSize` used. The job name determines the execution seed, which helps reused jobs reproduce the same checksum.

The backend uses Docker's HTTP API directly instead of adding a separate Docker client package. It handles API-version negotiation and separates captured standard output from error output.

In Compose, the backend bind-mounts the host Docker socket so it can start workload containers. Access to that socket gives the backend container full control of the host Docker daemon and is root-equivalent privilege on the host. This is an accepted trade-off for the local, single-machine prototype. The frontend and browser never receive the socket. Workload-container limits, network isolation, and restricted filesystem and process permissions do not reduce the backend container's Docker-daemon authority.

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

## 17. Share one autoscaler between two explainable strategies

There is one autoscaler service, one timer, one configuration, one worker lifecycle, and one scaling-event history. Exactly one strategy is active at a time:

- **Reactive** applies the scaling thresholds to the current eligible queue length and current peak reserved utilization.
- **ML-assisted** applies the same thresholds to short-term forecasts of those values. It is not an external or opaque trained model. It performs two ordinary least-squares straight-line fits over recent timestamped observations: one for eligible queued jobs and one for peak reserved CPU-or-memory utilization. It evaluates both lines at the configured look-ahead time. Predictions are bounded to valid queue and utilization ranges.

Every evaluation records the current point, regardless of strategy. The default in-memory history is the latest 20 points, the default look-ahead is 60 seconds, and ML-assisted waits for at least three points before acting. Normal strategy changes can therefore reuse compatible observations. The history is operational state, not durable monitoring history, and is lost on backend restart.

Both strategies share scale-up and scale-down thresholds, cooldown, worker limits, host-memory limits, and worker create/retire code. ML-assisted additionally requires a low forecast before scale-down, so current quiet load alone cannot retire a worker when demand is predicted to return. Workers are retired rather than deleted because jobs, allocations, and executions retain foreign keys to the worker that ran them. Scale-up can reuse retired workers without accumulating rows.

Runtime settings are an operator's experiment controls held in memory. Environment values provide defaults, while completed scaling events and comparison results are stored in MySQL.

## 18. Compare Reactive and ML-assisted on controlled real runs

The scaling comparison runs one seeded workload twice through the real orchestrator: Reactive first, then ML-assisted. Only the active autoscaling strategy changes. Scheduling policy, placement, workload specifications, jobs per tick, base capacity, worker size and limit, thresholds, cooldown, idle period, forecast window, and look-ahead stay fixed.

A comparison needs an idle cluster, a running autoscaler timer, permission to add at least one worker, and the fixed workload image. It refuses to overlap another scaling comparison or policy benchmark. The second run copies the first run's saved batch instead of regenerating it, and checksums plus recorded base capacity determine whether the results are comparable.

Before each strategy runs, the service pauses autoscaling, retires empty autoscaled workers, waits out any remaining cooldown, selects the strategy, and clears the autoscaler's load history and last decision. Each controlled run therefore starts with a fresh history. In particular, ML-assisted must collect its own three points and cannot learn from the preceding Reactive run.

The real pipeline drives jobs to completion while a timeline samples queue length, workers in service, extra and idle-extra workers, utilization, and ML forecasts. Saved results include job timing, reaction and backlog duration, extra-worker and idle-extra-worker time, peak workers, scaling actions, flaps, and forecast mean absolute error. Forecast accuracy matches a prediction to the measured queue nearest its look-ahead target, within the allowed sampling tolerance.

`POST /api/scaling-comparisons` starts the asynchronous comparison; list, detail, and abort routes expose saved and live state. The `scaling_comparisons`, `scaling_comparison_runs`, and `scaling_comparison_samples` tables preserve settings, outcomes, and timelines. Startup marks comparisons left running by an interrupted backend as aborted and cancels their unfinished jobs. The service restores the operator's prior enabled state and strategy when it finishes.

## 19. Benchmark scheduling policies on the real pipeline, one at a time

A policy comparison is only fair if every policy does the same work on the same capacity, so the benchmark controls both instead of trusting the operator to.

- **Isolation by refusal, not filtering.** The scheduler, the resume lookup, and Round Robin preemption all look at every job. Scoping them to one batch would change how the console behaves. Instead, a suite needs an idle cluster to start, and while it runs, routes that change the pipeline return 409. Kill all workloads is still allowed, because an emergency stop should never be blocked.
- **Reuse, don't regenerate.** Later runs copy the first run's batch through the existing reuse path. Equal result checksums then prove the work was identical, rather than assuming it.
- **Pause the autoscaler instead of disabling it.** A disabled autoscaler still retires idle autoscaled workers, which would change capacity between runs. Pausing freezes the cluster as it is.
- **Store results as columns.** Metrics are copied onto the run row when it ends, and the batch link is `ON DELETE SET NULL`. Clearing finished jobs therefore keeps the results. CHECK constraints keep counts and timings non-negative.
- **Waiting excludes run time.** Waiting subtracts the time spent running across all attempts, so a preempted Round Robin job's second queue stay counts as waiting.

## 20. Organise the dashboard as a top-bar and sidebar workspace

The current desktop shell has a 52-pixel sticky top bar and a 216-pixel sticky sidebar. The top bar contains OrchestrOS branding, the “Workload orchestrator” label, a measured API/MySQL/Docker status summary, and the Light/Dark selector. The sidebar groups four views under Workloads: **Run workload**, **Autoscaling**, **Comparison**, and **Monitoring**. URL hashes preserve the current view, and number keys 1-4 switch views when the user is not typing. The orchestrator component stays mounted, so polling and automatic runs continue after navigation.

The Comparison view contains both **Autoscaling: Reactive vs ML** and scheduling-policy comparisons. Run controls remain close to the workload, job details open in a drawer, and the capabilities panel from the first redesign has been removed. Pipeline stages use a repeated zero-padded `01`-`06` number beside the shared stage label in the pipeline, queue, and drawer. That stage-number treatment is the current visual signature.

The warm Claude-style theme uses cream and white surfaces in light mode and charcoal surfaces in dark mode. Terracotta marks primary actions and live activity. Reactive is coral and ML-assisted is lavender; scheduling policies have their own stable colors. CPU and memory use neutral tones so they cannot be mistaken for a strategy or policy. Stop controls are neutral outlines until a red warning hover. Status colors keep operational meaning: green for completed or active, red for failed, amber for interrupted or stopping, and terracotta for running, busy, or starting. Text, icons, and labels repeat every color-coded meaning.

## 21. Use small tests, rendered-view tests, and real-system tests

Both workspaces use Node's built-in `node:test` runner. Backend tests run serially because database and container integrations share global resources. Pure policy and service tests inject repository, runtime, clock, and wait replacements. Separate integration tests enable real MySQL with `RUN_DATABASE_TESTS=true` and real workload containers with `RUN_DOCKER_TESTS=true`; they cover SQL constraints, concurrency, rollback, resource release, recovery, and container outcomes.

Frontend tests load JSX through Vite in middleware/SSR mode and render views with `react-dom/server`. This checks components and states without requiring a browser or running backend. The production build remains a separate validation of the browser bundle.

The current verified state is **241/241 backend tests passed with MySQL and Docker enabled**, **68/68 frontend tests passed**, and the JavaScript syntax check and frontend production build passed. Historical totals remain in [the change record](changes.md) with their dates; they describe those earlier revisions, not the current suite. See [the run guide](running.md) for the commands.
