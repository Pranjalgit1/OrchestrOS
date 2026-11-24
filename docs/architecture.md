# How the project is built

OrchestrOS runs computing jobs on one development computer. It combines a browser dashboard, a JavaScript backend, MySQL, and Docker.

The browser asks for work to happen. The backend makes the decisions. MySQL stores what happened. Docker runs each workload.

```text
React 19 dashboard (top bar + Workloads sidebar)
                     |
                     | REST/JSON under /api
                     v
Express 5 application
  |-- orchestrator --> scheduler --> placement --> reservation
  |                                           \-> Docker execution
  |-- autoscaler (Reactive or ML-assisted) --> logical workers
  |-- policy benchmark + Reactive/ML comparison
  |-- monitoring + recovery
  |
  +--> MySQL 8 / Prisma 6      durable jobs, workers, allocations,
  |                            executions, samples, events, experiments
  |
  +--> Docker Engine API       fixed, resource-limited workload containers
```

## 1. Main parts

| Part | Main job | Where to look |
| --- | --- | --- |
| Dashboard | Show controls, jobs, workers, results, and graphs in four hash-based views; the top bar reports API/MySQL/Docker status and switches theme, and the sidebar selects views with links or keys 1–4 | `frontend/src/` |
| API setup | Connect routes, validate request bodies, and report errors | `backend/src/app.js` |
| Server | Listen for requests, start monitoring and the autoscaler, recover after restarts, and handle shutdown | `backend/src/server.js` |
| Orchestrator | Call scheduling, placement, reservation, and execution in order | `backend/src/modules/orchestrator/` |
| Jobs and workers | Create and read their database records | `backend/src/modules/jobs/`, `backend/src/modules/workers/` |
| Workload generator | Create repeatable batches of job specifications | `backend/src/modules/workloads/` |
| Scheduler | Choose the next job | `backend/src/modules/scheduler/` |
| Placement | Choose a worker | `backend/src/modules/placement/` |
| Resources | Reserve and release CPU and memory | `backend/src/modules/resources/` |
| Executions | Start Docker containers and record results | `backend/src/modules/executions/` |
| Monitoring | Read current values and save usage history | `backend/src/modules/monitoring/` |
| Autoscaler | Add and retire extra logical workers using Reactive or ML-assisted decisions | `backend/src/modules/autoscaler/` |
| Benchmarks | Run one workload under several scheduling policies and compare measured results | `backend/src/modules/benchmarks/` |
| Scaling comparisons | Run the same seeded workload under Reactive and ML-assisted autoscaling and compare timelines and costs | `backend/src/modules/scaling-comparisons/` |
| Workload program | Do the actual calculation inside a container | `workload-runner/run.js` |
| Tests | Check backend and frontend behavior separately from application source | `backend/tests/`, `frontend/tests/` |

Most backend features use the same file pattern:

| File ending | Purpose |
| --- | --- |
| `.routes.js` | Connect an API URL to its handler |
| `.schemas.js` | Check that incoming values are allowed |
| `.service.js` | Apply the feature's rules |
| `.repository.js` | Read and change database records |

Tests live in `backend/tests/` and `frontend/tests/`, outside the source folders. Files ending in `.test.js` check behavior with controlled inputs; backend `.integration.test.js` files use a real database or container when enabled.

Some features also have calculation-only files, such as `scheduler.policies.js`, `placement.accounting.js`, `autoscaler.policy.js`, and `benchmark.metrics.js`. These are easier to test because they do not need a server or database.

### The dashboard

The current shell has a sticky top bar with the OrchestrOS brand, the “Workload orchestrator” label, combined API/MySQL/Docker status, and a Light/Dark selector. The desktop sidebar is fixed below it, is headed **Workloads**, and links to the four hash-based views below; at narrow widths it becomes a non-sticky horizontal navigation strip. Number keys 1–4 switch views when focus is not in a form field. `OrchestratorConsole.jsx` owns orchestrator state and the browser auto-run timer and remains mounted across views, so a run continues while another view is open.

| View | Main components |
| --- | --- |
| Run workload (`#run`) | `PageHeader` with `RunActions`, `RunSettings` and `WorkloadPanel` (`ControlPanel.jsx`), `PipelineView`, `WorkerGrid` beside `ActivityLog`, `JobQueue`, and `JobDetail` in a side drawer |
| Autoscaling (`#autoscaling`) | `PageHeader`, `AutoscalerPanel`, and `WorkerGrid` |
| Comparison (`#comparison`) | `ComparisonTab` switches between `ScalingComparisonPanel` (the default **Autoscaling: Reactive vs ML** mode) and `BenchmarkPanel` (**Scheduling policies**). Supporting components are `ScalingSetup`, `ScalingChart`, and `ScalingInsights`; chart calculations are in `scaling.chart.js` and `benchmark.chart.js` |
| Monitoring (`#monitoring`) | `PageHeader` and `MonitoringPanel`, with chart geometry in `reservation.chart.js` |

Shared UI pieces live in `frontend/src/components/`: `PageHeader`, `Icon`, `CapacityGauge`, `PipelineView`, `WorkerGrid`, `ActivityLog`, `JobQueue`, `JobDetail`, `ControlPanel`, the autoscaling and comparison panels, and their chart/setup/insight components. The six pipeline stages carry the same two-digit tags everywhere they appear: **01** Job queue, **02** Scheduler, **03** Placement, **04** Reservation, **05** Docker execution, and **06** Completed. Failed, interrupted, and cancelled jobs are shown as ended early and do not receive a seventh stage.

CPU and memory use two neutral tones in bars, rings, and charts so coral and lavender remain available for scheduling-policy and autoscaling-strategy identity. In light mode they are `#5e5d58` and `#b4b1a6`; in dark mode they are `#d4d1c6` and `#7a786f`. Charts are plain SVG drawn from small pure functions; there is no chart library. Panels with a pure `...View` component can be rendered in tests without a backend.

## 2. What MySQL stores

The table definitions are in [schema.prisma](../backend/prisma/schema.prisma). The repository has five additive migrations:

1. [Initial MySQL schema](../backend/prisma/migrations/20261005000000_mysql_initial/migration.sql): workload batches, jobs, workers, samples, allocations, executions, constraints, and the functional index that permits one live reservation per job.
2. [Preemption and requeue](../backend/prisma/migrations/20261021000000_preemption_and_requeue/migration.sql): `PREEMPTED` executions plus job preemption and retry counters.
3. [Reactive autoscaling](../backend/prisma/migrations/20261021120000_reactive_autoscaling/migration.sql): retired/autoscaled workers and `scaling_events`.
4. [Policy benchmarks](../backend/prisma/migrations/20261023000000_policy_benchmarks/migration.sql): benchmark suites, runs, metrics, and capacity records.
5. [Scaling comparisons](../backend/prisma/migrations/20261101000000_scaling_comparisons/migration.sql): Reactive-vs-ML comparisons, per-strategy runs, timelines, autoscaler settings, scaling actions, and fairness/forecast metrics.

The files show the intended schema history; whether a particular database has applied them is determined by that database's migration state.

| Table | What one row means |
| --- | --- |
| `workload_batches` | A saved group of generated jobs and the settings used to create them |
| `jobs` | One job, its resource needs, current state, timing, and result |
| `workers` | One logical worker's capacity, reserved resources, and state |
| `resource_allocations` | A job's CPU and memory reservation, including released history |
| `job_executions` | One attempt to run a job in a container |
| `worker_samples` | One worker's resource-use snapshot at a particular time |
| `scaling_events` | One autoscaler action, the worker it changed, and the signals behind it |
| `benchmark_suites` | One policy comparison: the workload settings and its overall outcome |
| `benchmark_runs` | One policy's run in a suite, the capacity it saw, and its measured metrics |
| `scaling_comparisons` | One Reactive-vs-ML comparison: the workload, the fixed settings, and its outcome |
| `scaling_comparison_runs` | One strategy's run: job metrics, scaling metrics, and its scaling actions |
| `scaling_comparison_samples` | One timeline point of a run: waiting jobs, workers, utilization, and the ML forecast |

The queue is saved in `jobs`. There is no second queue that must be kept in sync with MySQL.

Prisma is the library the backend uses for most database operations. Raw SQL is used where needed, including row locks and some monitoring calculations.

## 3. Jobs and states

Jobs created manually or by the generator start as `QUEUED`.

```text
QUEUED -> SCHEDULED -> RUNNING -> COMPLETED
  ^                       | -> FAILED --------+
  |                       | -> INTERRUPTED ---+--> (requeue) --> QUEUED
  |                       | -> CANCELLED
  +---- preempted or ----+
        auto-retried
Any unfinished job -> CANCELLED
```

| State | Meaning |
| --- | --- |
| `QUEUED` | Waiting to be chosen; its arrival time may still be in the future |
| `SCHEDULED` | Chosen by the scheduler; it may still need a worker or reservation |
| `RUNNING` | Execution has been claimed; the container is starting or running |
| `COMPLETED` | Finished successfully and returned a valid result |
| `FAILED` | Could not start, exited with an error, or did not return a valid result, and was not retried |
| `INTERRUPTED` | The system stopped the run after its time limit |
| `CANCELLED` | Cancelled by an operator at any unfinished stage, or by Kill all workloads |

Going back to `QUEUED` clears the job's scheduling, placement, and container fields so it goes through the whole pipeline again. Its arrival time and Round Robin round count are kept. Each attempt keeps its own execution row, so history is not lost. Jobs count requeues in two columns: `preemptionCount` for Round Robin evictions and `retryCount` for retries after a failed or interrupted run.

A job goes back to `QUEUED` in three ways:

- **Preemption.** A Round Robin quantum expired while another job was waiting (section 6).
- **Automatic retry.** The run was lost to an infrastructure fault. Either the container could not start, it vanished from Docker, or the execution never reached a container. These jobs are requeued up to `EXECUTION_MAX_RETRIES` times (default 2). Exit-code failures, out-of-memory kills, missing results, and timeouts are not retried automatically. Running the same deterministic workload with the same limits would fail the same way.
- **Manual requeue.** `POST /api/jobs/:id/requeue` sends a `FAILED` or `INTERRUPTED` job back to the queue.

Cancelling a queued, scheduled, or reserved job happens in one transaction that also releases its reservation. Cancelling a running job is different: the backend first stops the container, then records the cancellation and releases capacity together. If the container finishes or is preempted first, that outcome stands. The cancel then either acts on the new state, cancelling a requeued job, or reports that the job already finished.

`CREATED` and `WAITING` also exist in the allowed state model, but normal job creation currently starts at `QUEUED`. State-change rules live in `job.transitions.js`.

The dashboard also shows stages such as placed and reserved. These come from the job's worker and allocation records; they are not extra job-status values.

## 4. Logical workers and units

Workers are saved capacity budgets on the same computer. Their capacity values do not create extra physical hardware.

- **CPU:** 1000 millicores equals one logical core.
- **Memory:** 1024 MiB equals one GiB.

The setup script creates these workers if they are missing:

| Worker | CPU in millicores | Memory in MiB |
| --- | ---: | ---: |
| `worker-1` | 500 | 512 |
| `worker-2` | 1000 | 1024 |
| `worker-3` | 1500 | 1536 |

These built-in budgets total 3 GiB. They are scheduling limits, not preallocated physical memory or separate machines. Container memory limits are ceilings; actual Windows/WSL memory use includes other applications and the Docker VM. The dashboard reports free memory on the backend host separately from reservations. Setup and backend startup apply the budgets to idle default workers automatically; active reservations are preserved. Recovery also applies them when old executions finish.

New workers start `IDLE` with nothing reserved. A worker with a reservation becomes `BUSY`; it becomes `IDLE` again when its reserved CPU and memory reach zero. `RETIRED` marks an autoscaled worker taken out of service. The model also supports `STARTING`, `ACTIVE`, `STOPPING`, and `FAILED`.

### Autoscaling: reactive and ML strategies

The autoscaler (`backend/src/modules/autoscaler`) adds and removes extra logical workers named `auto-worker-N`. It never touches the three study workers or workers created through the API. Every few seconds (`AUTOSCALE_INTERVAL_SECONDS`, default 5) it reads one database snapshot, makes one decision, and applies at most one change. The decision rules are in `autoscaler.policy.js`.

| Decision | When |
| --- | --- |
| Scale up | At least 2 eligible jobs are queued **and** the schedulable workers are at least 75% reserved (the higher of CPU and memory) |
| Scale down | An autoscaled worker has held nothing and had no job planned on it for 30 seconds, fewer than 2 jobs wait, **and** the cluster would stay below 40% reserved without it |
| No change | Neither applies, the 15-second cooldown since the last change is still running, the `AUTOSCALE_MAX_WORKERS` limit (default 3) is reached, or one more worker would push the combined worker memory budgets past 75% of host memory |

The 75%/40% gap and the cooldown keep the cluster from flapping between sizes. These thresholds can be changed at runtime through `PATCH /api/autoscaler`. Runtime changes last until the backend restarts.

A new worker gets `AUTOSCALE_WORKER_CPU_MILLICORES` and `AUTOSCALE_WORKER_MEMORY_MIB` (default 1000m / 512 MiB). Scale-up reuses a retired autoscaled worker before creating a new one.

Scale-down marks a worker `RETIRED` rather than deleting it, because past jobs and executions still reference it. Retired workers are left out of placement, the dashboard, and monitoring totals and samples. A database check refuses any reservation counters on a retired worker.

Each change and its scaling event (the action, reason, waiting jobs, utilization, and resulting worker count) commit in one transaction to `scaling_events`. This keeps the history auditable.

Retirement rechecks the worker under its row lock. A job placed on it in the brief gap after that check is caught at reservation. Reservation refuses any worker that is not schedulable and withdraws the placement, so the job is placed again on its next pass.

#### Reactive and ML strategies

There are two strategies, and exactly one is active (`strategy`, default `REACTIVE`). They share everything above: the same rule, thresholds, cooldown, worker limit, host memory limit, and the same transactional scale-up and retirement. Only the load the rule tests differs, so the two can be compared on the same seeded workload.

| Strategy | Load the rule tests |
| --- | --- |
| Reactive | The waiting jobs and reserved utilization measured now |
| ML | The waiting jobs and reserved utilization predicted `mlLookAheadSeconds` (default 60) ahead |

The implementation is deliberately small and local. The autoscaler stores measured points as `{ at, queuedJobs, peak }` in an oldest-first in-memory `loadHistory`, trims it to `mlWindowPoints`, and fits two independent ordinary least-squares lines against elapsed seconds: one for eligible queue length and one for peak CPU/memory reservation. It extrapolates both to the newest point plus `mlLookAheadSeconds`, clamps jobs to zero or more and utilization to 0–1, and reports queue slope per minute. Zero or one point, or equal timestamps, produce a flat mean; the strategy requires at least three points before it can act.

Every autoscaler evaluation records measured load whichever strategy is active, so an ordinary switch from Reactive to ML can reuse recent observations. Shrinking the configured window trims history immediately. `resetHistory()` clears both the window and last decision; the controlled Reactive-vs-ML experiment invokes it before each strategy run. Runtime configuration and history disappear on backend restart. Persisted `scaling_events` are an audit trail, not model input, and comparison forecasts become durable only when a run's samples are committed. There is no separate training dataset, feature store, serialized model, validation split, retraining process, or model version.

ML scales up when the forecast crosses the scale-up line, which can happen before measured load does. It retires an idle worker only when current queue/capacity are quiet **and** the forecast remains below both thresholds. Reactive uses current measured queue and utilization for scale-up and current quietness for scale-down. Both strategies otherwise share the same limits, cooldown, host-memory ceiling, worker lifecycle, transactional actions, and one-change-per-evaluation rule.

Autoscaling starts off (`AUTOSCALE_ENABLED=false`) and is switched on with the separate **Autoscaling** On/Off control on the **Autoscaling** view. The **Reactive / ML-assisted** strategy selector chooses the strategy. Decisions are fully automatic; there is no manual evaluate button in the dashboard. While autoscaling is off, nothing is added, but idle autoscaled workers are still retired so the cluster drains back to its base size. Either controlled experiment pauses evaluation entirely until it ends.

## 5. Repeatable workload generation

The generator supports batches of exactly 10, 25, 50, or 100 jobs. A seed is a number that lets it repeat the same choices.

For the same generator version, seed, count, pattern, and custom settings, it produces the same job specifications and arrival offsets. New database IDs and default start times will still differ.

The current generator version is `v2`. Tests pin its output, so a deliberate change to its choices should use a new version. Historical batches keep their saved version and specifications.

All predefined profiles are small by design. Light uses 100-250m CPU, 64-128 MiB, and 2-6 second estimates; medium uses 250-500m, 96-192 MiB, and 4-8 seconds; heavy uses 500-1000m, 128-256 MiB, and 6-10 seconds. Heavy is relative to this study scale. Every job fits at least one built-in worker. Actual compute duration varies with hardware and container CPU limits.

| Pattern | Meaning |
| --- | --- |
| `IMMEDIATE` | All jobs are eligible together, using the medium resource profile |
| `LIGHT` | Small resource requests, with 20-40 second arrival gaps |
| `MEDIUM` | Medium requests, with 8-16 second gaps |
| `HEAVY` | Larger requests, with 2-6 second gaps |
| `CONSTANT` | Varied medium requests, with a fixed 10 second gap |
| `BURST` | Five jobs arrive together; the next group arrives 30 seconds later |
| `INCREASING` | Requests grow larger and arrivals get closer together |
| `DECREASING` | Requests become smaller and arrivals spread out |
| `PERIODIC` | Repeating request patterns and gaps of 2, 2, 2, then 20 seconds |
| `CUSTOM` | You choose allowed types, value ranges, and exact arrival offsets |

`SUDDEN_BURST` is accepted as another input name for `BURST`.

Each job has a type, size, CPU request, memory request, duration estimate, priority, and arrival time. The optional type selection applies to every predefined arrival pattern. Size is based on the duration and CPU estimate: seconds for sleep, iterations for CPU, elements for sorting, records for data, and dimension for matrix multiplication. Custom generation also enforces study limits, including a separate size ceiling for each selected type.

The batch and all its jobs are saved together. Reusing a batch copies its saved job specifications instead of generating new choices.

## 6. Scheduling: which job goes next?

Only `QUEUED` jobs whose arrival time has passed can be selected.

| Policy | How it chooses |
| --- | --- |
| `FCFS` | First arrival goes first; ties use creation time, batch position, then ID |
| `SJF` | Shortest estimated duration goes first; ties use arrival order |
| `PRIORITY` | Highest effective priority goes first; ties use arrival order |
| `ROUND_ROBIN` | Fewest previous scheduling rounds goes first; ties use arrival order |

Priority ranges from 1 to 10, with 10 highest. Waiting jobs gain one effective priority level per full minute waited, up to 10. This helps old jobs get a turn.

Round Robin records a time slice (quantum), normally 10 seconds, and increases the job's round count. The accepted time slice is 1-3600 seconds. Jobs with fewer rounds are chosen first.

The quantum is enforced while the container runs, like Kubernetes pod preemption. The backend waits on the container one quantum at a time. Each time a quantum expires, it checks two things: is another `QUEUED` job eligible, and is this job still under `ROUND_ROBIN_MAX_PREEMPTIONS` evictions (default 3)?

- If both are true, the container is stopped and discarded. The execution is recorded as `PREEMPTED`, and the job returns to the queue with its reservation released in the same transaction.
- If either is false, the job keeps running into the next quantum.

A preempted job restarts from the beginning on its next turn. Workloads are deterministic for their seed, so the result is identical. The cap stops a long job from being restarted forever. The overall execution time limit still applies to each attempt, and a run that finishes just as its quantum expires keeps its result. Setting the cap to 0 turns preemption off.

The scheduler changes a job only if it is still queued. This stops two simultaneous scheduling requests from both selecting the same job successfully.

## 7. Placement: which worker should receive it?

Placement chooses a worker for an already scheduled job. It saves the choice, strategy, and time. Reservation happens afterward.

A worker must be `IDLE`, `ACTIVE`, or `BUSY`, and its calculated free CPU and memory must both fit the job. Placement considers saved reservation counters plus scheduled/running assignments that do not hold a reservation. A reserved job is counted only once.

| Strategy | How it chooses |
| --- | --- |
| `FIRST_FIT` | First suitable worker in name order |
| `LEAST_LOADED` | Worker with the lowest current load, using the higher of CPU and memory usage |
| `RESOURCE_AWARE` | Worker that would have the best balance and lowest high usage after adding the job |

The Resource Aware score is `0.7 * peak + 0.3 * imbalance`. Here, peak is the higher of the expected CPU and memory usage fractions, and imbalance is their difference. Lower scores win. For Least Loaded and Resource Aware, equal scores prefer the worker with fewer saved job assignments, then worker name. This spreads short jobs across equally loaded workers even when each finishes before the next dispatch. The count includes retained finished jobs and survives backend restarts; clearing job history removes those jobs from the count. First Fit always keeps name order.

If no worker fits, placement reports insufficient resources. A saved placement is only a plan: reservation checks the real counters again before granting capacity.

## 8. Reservation: make the capacity claim real

Suppose a worker has 1000 millicores free and two jobs each ask for 700. Both jobs cannot be granted 700.

The reservation code starts a **transaction**, locks the worker's row, checks for an existing reservation, and reads its current free capacity. It then saves the allocation and updates the worker counters together. A competing request for that worker waits, then checks the updated values.

Reservation, release, idle-job cancellation, manual requeue, and execution claim/finalization use the shared `withDeadlockRetry` wrapper. It retries only Prisma `P2034`, which represents a transaction conflict/deadlock. `DEADLOCK_ATTEMPTS = 4` means four total executions: the initial transaction plus at most three retries. After failed attempts 1–3, the exact delay is `20 * attempt + Math.random() * 30` milliseconds: `[20, 50)`, `[40, 70)`, then `[60, 90)`. A non-`P2034` error, or the fourth `P2034`, is thrown immediately. Every retry invokes the callback again and therefore starts a fresh transaction after MySQL has rolled back the victim.

These interactive transactions use `maxWait: 15_000` ms to wait for a connection/transaction slot and `timeout: 20_000` ms for the transaction itself, including row-lock waits and writes. Autoscaler transactions use the same limits but do not use this retry wrapper; a failed autoscaler pass is logged and a later timer pass evaluates fresh state.

If anything fails, the transaction undoes its changes. The worker cannot be left with only half of the reservation saved.

MySQL also checks these rules:

- Reserved CPU and memory cannot be negative or exceed capacity.
- A job can have only one live `RESERVED` allocation.
- Older released or rolled-back allocations can remain as history.
- An execution must refer to an allocation with the same job and worker.

The one-live-reservation rule uses a functional unique index: it checks the job ID only for reserved rows and ignores historical rows for uniqueness. The SQL migration contains this rule because the Prisma schema cannot describe that index directly.

Releasing an allocation changes it to `RELEASED` and subtracts its CPU and memory from the worker. Repeating a completed release returns the existing result instead of subtracting again.

## 9. Docker execution

The backend runs the fixed image `orchestros/workload-runner:v1`. API callers choose from supported workload types; they cannot provide their own image, command, script, or container environment.

| Workload | What it does | Maximum work size |
| --- | --- | ---: |
| `CPU_INTENSIVE` | Repeated calculations | 50,000,000 iterations |
| `MATRIX_MULTIPLICATION` | Multiply matrices | Dimension 320 |
| `SORTING` | Sort generated values | 2,000,000 elements |
| `DATA_PROCESSING` | Process generated records | 2,000,000 records |
| `SLEEP` | Wait for a set time | 120 seconds |

The runner can reduce work further to fit its memory budget. It reports the size it actually used as `effectiveSize`.

The backend supplies four inputs: `ORCHESTROS_WORKLOAD_TYPE`, `ORCHESTROS_WORKLOAD_SIZE`, `ORCHESTROS_SEED`, and `ORCHESTROS_MEMORY_LIMIT_MIB`. The runner's seed comes from the job name. Reusing the same work can reproduce the same checksum; elapsed time is not part of that checksum.

Each container gets the job's reserved CPU and memory limits. It has no network, no host-folder mounts, a read-only root filesystem, restricted permissions, and a process-count limit.

The backend talks directly to Docker's API. In Compose, only the backend receives `/var/run/docker.sock`; the backend container itself is not declared `privileged`. Socket access nevertheless gives the backend root-equivalent control of the host Docker daemon. The API is bound to host loopback by default, but it has no authentication, so this is an explicit high-impact trust boundary suitable only for the local single-machine prototype. The browser never receives socket access.

Workload containers have a narrower privilege set: fixed image and environment, no network or bind mounts, exact CPU/memory and swap limits, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, PID limit 64, restart disabled, and `Privileged: false`. Runtime stop/remove operations target only OrchestrOS-managed labels.

When a run finishes, the backend saves the outcome and frees its resources in one database transaction. It then removes the container. A zero exit code counts as success only if the expected result is present. Errors are `FAILED`; a time limit is `INTERRUPTED`; a Round Robin eviction is `PREEMPTED`; an operator stop is `CANCELLED`. Monitoring counts `FAILED` and `INTERRUPTED` executions as failures. Preemptions are not counted as failures.

## 10. Monitoring

Current metrics are calculated from saved jobs, executions, allocations, and workers. Monitoring does not choose or start jobs.

Usage history needs its own records. The sampler saves one `worker_samples` row per worker every 15 seconds by default. Rows from one pass share a timestamp. Duplicate passes at that timestamp do not create duplicate samples. Samples older than 24 hours are removed by default.

The sampler starts in `server.js`, so importing the app in a test does not start a timer. Setting the interval to 0 disables automatic sampling; the API can still capture a sample on request.

| Timing | What it measures |
| --- | --- |
| `queueWait` | Planned arrival until scheduling |
| `placementDelay` | Scheduling until worker placement |
| `startDelay` | Placement until execution starts |
| `execution` | Execution start until completion |
| `turnaround` | Planned arrival until completion |

Each timing includes count, average, minimum, maximum, and p95. MySQL calculates the timestamp differences and the percentile. p95 uses a value between neighboring sorted measurements when needed. The API converts the database's numeric results into JavaScript numbers.

A stage with no data has count 0. Success rate is `null` when there are no completed outcomes to calculate it from. The API limits requested history to between 1 minute and 7 days.

## 11. Policy benchmark

The benchmark module (`backend/src/modules/benchmarks`) runs the same seeded workload once per scheduling policy and compares the results. It does not simulate anything: each run goes through the normal orchestrator, so scheduling, placement, the row-locked reservation, and Docker execution are the same code the console uses.

- **Same work every run.** The first run generates the batch. Every later run reuses it, so names, resources, workload seeds, and result checksums match. Only arrival times move to the start of each run.
- **One run at a time on a quiet cluster.** The scheduler considers every queued job, so a suite only starts with no unfinished jobs (`CLUSTER_NOT_IDLE`). While it runs, routes that would add, clear, or advance work return 409 `BENCHMARK_RUNNING`. Kill all workloads stays available as the emergency stop.
- **Fixed capacity.** The autoscaler is paused for the suite and resumed afterwards. Each run records the worker count and capacity it saw, and the comparison says when they differed.
- **Driving a run.** The runner calls the orchestrator every second with up to `jobsPerTick` jobs until every job in the batch is finished. A run that has not finished 15 minutes after its last arrival fails.

When a run ends, its metrics are copied into `benchmark_runs`, so clearing finished jobs later does not erase the comparison. Times cover completed jobs only:

| Metric | Definition |
| --- | --- |
| Turnaround | Completion minus planned arrival |
| Response | First container start minus planned arrival |
| Waiting | Turnaround minus time spent running, summed over every attempt |
| Makespan | First arrival to last completion |
| Throughput | Completed jobs per minute of makespan |

p95 values use the same interpolation as monitoring. A run's `checksumDigest` is a SHA-256 over every job's result checksum, set only when every job completed; equal digests show the runs did identical work. The comparison marks the best value per metric and treats values within a millisecond as a tie.

The suite runner lives in the backend process. A restart abandons it, and the next boot marks the suite as aborted.

### Autoscaling comparison: Reactive vs ML

The scaling-comparisons module (`backend/src/modules/scaling-comparisons`) answers one question: when load changes, does predicting it (ML) give jobs shorter waits than reacting to it, and how much extra worker time does that cost? It runs one seeded workload twice through the real pipeline, Reactive first and ML second. Only the autoscaling strategy changes.

- **Same everything else.** The second run reuses the first run's batch, so the work and result checksums match. Scheduling policy, placement, thresholds, limits, and cooldown are identical; the autoscaler settings are stored with the comparison.
- **Equal starts.** Before each run the autoscaler is paused, every extra worker is retired so the run starts on the base workers, any cooldown left from earlier scaling is waited out, and the ML load history is cleared. The ML run therefore needs about three checks before it can forecast, which is part of how it behaves.
- **A sampled timeline.** About every 2 seconds, subject to the time spent in database/orchestrator work, the runner records waiting jobs, workers in service, extra and idle extra workers, peak reserved utilization, and the ML forecast. It does not backfill missed intervals. Scaling actions during the run are copied from `scaling_events`. Live samples are process memory until the run closes; `finishRun` stores the aggregate, actions, and complete timeline transactionally.
- **Exclusive.** A policy benchmark and an autoscaling comparison refuse to start while the other runs, and the same routes are locked during either (`experiment.registry.js`). The autoscaler's on/off state and strategy are restored afterwards.

| Metric | Definition |
| --- | --- |
| Waiting, slowest 5% waiting, turnaround, makespan | As in the policy benchmark |
| Backlog begins (`pressureAt`) | The first sample where the reactive rule would fire: at least the scale-up threshold of jobs waiting on a cluster at or above the scale-up utilization |
| First extra worker (`reactionSeconds`) | First scale-up minus `pressureAt`. Negative means the worker came first. If a worker came and no backlog ever formed, the outcome is `BEFORE_ANY_BACKLOG`, which beats any measured reaction |
| Time with a backlog | Time at least the threshold of jobs were waiting |
| Extra worker time | Extra workers in service multiplied by seconds; the idle part is when they held nothing |
| Scaling changes, flaps | Workers added plus retired; a flap is a worker added within 60 s of a retirement |
| Forecast error | Each ML forecast compared with the queue measured `mlLookAheadSeconds` later; the mean absolute gap in jobs |

Time-weighted metrics treat each sample as holding until the next. Differences under 5% (or under 0.5 s, 5 worker-seconds, or half a change) count as a tie, because Docker timing varies a little between identical runs. The headline verdict combines waiting time and extra worker time: better on one without losing on the other is a win, better on one and worse on the other is a trade-off.

The fifth migration above adds the comparison tables. No single recorded experiment is an architectural guarantee; results depend on workload, thresholds, host load, Docker timing, and the accumulated samples in that controlled run.

## 12. Current limitations

- Workers, including autoscaled workers, are logical budgets on one host. Scaling does not provision physical machines.
- Worker heartbeat fields exist, but worker-failure detection is not implemented.
- The HTTP API has no authentication or authorization, while the backend holds root-equivalent Docker-socket access. Host-loopback binding limits default exposure but does not remove that trust boundary.
- Experiment ownership, route exclusion, active samples, and ML load history are process-local. Multiple backend replicas could each believe they own the cluster. A crash aborts experiments rather than resuming them and loses an active comparison run's uncommitted timeline.
- The ML strategy is two linear trends over queue length and peak reserved utilization. It has no persistent model, richer feature set, confidence estimate, anomaly handling, or training/model-version lifecycle.
- Autoscaling adds or retires at most one logical worker per evaluation, so its reaction speed is bounded by the timer and cooldown.
- Round Robin preemption discards the container and restarts deterministic work from the beginning; it cannot checkpoint or resume.
- Recovery cannot reconstruct output after a container disappears. It records an infrastructure failure and may requeue the job. Execution deadlines are not persisted; after restart, remaining time is recomputed from the current `EXECUTION_TIMEOUT_SECONDS` and the saved start/create time.
- A normal shutdown stops the recovery, monitoring, and autoscaler timers; cooperatively aborts and awaits both policy benchmarks and autoscaling comparisons; closes the listener; awaits tracked settlements; and disconnects Prisma. It does not proactively stop unrelated ordinary workloads and has no hard shutdown deadline, so open connections, Docker calls, or long settlements can delay exit.
- On startup, open executions are reconciled, study workers repaired, interrupted benchmark suites marked aborted, and interrupted autoscaling comparisons marked aborted with their unfinished jobs cancelled. Every 30 seconds, execution reconciliation and worker repair repeat. Policy-benchmark recovery marks the suite aborted but does not separately cancel its queued or scheduled leftovers, so they may need **Kill all** or individual cancellation before a new experiment.
- The Docker adapter intentionally supports a narrow API surface and caps its API version.

Closing the browser stops browser auto-run requests, but already started work continues while the backend runs. **Kill all** explicitly stops managed workload containers and cancels unfinished jobs. Manual execution recovery remains available through `POST /api/executions/:executionId/settle` and refuses a live container.

Read [the job flow](flow.md) for the steps in order, or [the design choices](decision.md) for why these decisions were made.
