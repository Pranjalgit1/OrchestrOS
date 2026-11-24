# What happens when you use the app

This guide follows a job from creation to completion. The backend makes the scheduling and resource decisions; the browser sends requests and displays the results.

For a side-by-side code walkthrough, start with these files:

| Change | Where to read |
| --- | --- |
| Application shell: sticky top bar, fixed desktop sidebar, exact Run workload / Autoscaling / Comparison / Monitoring views, URL hashes, keys 1–4, service status, and theme | [App.jsx](../frontend/src/App.jsx), [ui.css](../frontend/src/ui.css) |
| Theme tokens, responsive layout, and locally hosted Inter / Roboto Mono fonts | [theme.css](../frontend/src/theme.css), [styles.css](../frontend/src/styles.css), [ui.css](../frontend/src/ui.css), [main.jsx](../frontend/src/main.jsx) |
| Non-sticky Run actions/settings and Workload generation/cleanup panel | [ControlPanel.jsx](../frontend/src/components/ControlPanel.jsx) |
| Run/Pause browser timer, demo generation, unfinished-job actions, state polling, and job drawer | [OrchestratorConsole.jsx](../frontend/src/OrchestratorConsole.jsx) |
| Numbered pipeline and matching job-stage tags | [PipelineView.jsx](../frontend/src/components/PipelineView.jsx), [JobQueue.jsx](../frontend/src/components/JobQueue.jsx), [JobDetail.jsx](../frontend/src/components/JobDetail.jsx) |
| Reactive/ML-assisted strategy control, On/Off switch, thresholds, forecast, and scaling history | [AutoscalerPanel.jsx](../frontend/src/components/AutoscalerPanel.jsx) |
| Comparison mode switch | [ComparisonTab.jsx](../frontend/src/components/ComparisonTab.jsx) |
| Reactive-vs-ML setup, polling, timelines, results, history, rerun, stop, and export | [ScalingComparisonPanel.jsx](../frontend/src/components/ScalingComparisonPanel.jsx), [ScalingSetup.jsx](../frontend/src/components/ScalingSetup.jsx), [ScalingInsights.jsx](../frontend/src/components/ScalingInsights.jsx), [ScalingChart.jsx](../frontend/src/components/ScalingChart.jsx), [scaling.chart.js](../frontend/src/scaling.chart.js) |
| Scheduling-policy form and table-based results with inline bars | [BenchmarkPanel.jsx](../frontend/src/components/BenchmarkPanel.jsx), [benchmark.chart.js](../frontend/src/benchmark.chart.js) |
| Worker table/cards with reservations, running containers, and finished attempts | [WorkerGrid.jsx](../frontend/src/components/WorkerGrid.jsx) |
| Browser API requests | [api.js](../frontend/src/api.js) |
| Built-in worker capacities and safe setup | [worker.defaults.js](../backend/src/modules/workers/worker.defaults.js) |
| Small resource profiles and type-specific work sizes | [workload.generator.js](../backend/src/modules/workloads/workload.generator.js) |
| Limits on custom generation requests | [workload.schemas.js](../backend/src/modules/workloads/workload.schemas.js) |
| Neutral CPU / memory reservation rings used by workers and monitoring | [CapacityGauge.jsx](../frontend/src/components/CapacityGauge.jsx), [theme.css](../frontend/src/theme.css) |
| Live metrics, utilization history, and lifecycle timings | [MonitoringPanel.jsx](../frontend/src/MonitoringPanel.jsx) |

## 1. Start the app

With the two-terminal setup, MySQL runs locally, one terminal runs the backend, and another runs the frontend.

With the full Compose setup, startup happens in this order:

1. Start MySQL and wait until a login and `SELECT 1` query succeed.
2. Run the database migration and create missing starting workers.
3. Start the backend and wait for its database health check.
4. Start the frontend.

The backend also starts the usage-history timer unless it has been disabled. The database health endpoint and Docker-runtime endpoint check different things.

## 2. Generate jobs

The top bar stays visible and shows the OrchestrOS brand, “Workload orchestrator”, combined API/MySQL/Docker status, and the Light/Dark selector. The desktop sidebar is headed **Workloads** and has four exact view names: **Run workload** (`#run`), **Autoscaling** (`#autoscaling`), **Comparison** (`#comparison`), and **Monitoring** (`#monitoring`). On narrow screens it becomes a horizontal navigation strip. Keys 1–4 select those views unless focus is in a form field. Legacy `#console`, `#pipeline`, and `#job-queue` links open **Run workload**; `#benchmark` opens **Comparison**.

On **Run workload**, click **Add workload** (the panel starts open on an empty cluster), choose a job count, arrival pattern, workload type, and seed, then click **Generate workload**. The panel closes afterwards. Clicking a job opens its details in a drawer on the right; Escape closes it. Resource sizes are automatic and small by default.

1. The browser sends `POST /api/workloads/generate`.
2. The backend rejects missing, unknown, or out-of-range inputs.
3. The generator chooses each job's type, size, resources, priority, duration estimate, and arrival offset.
4. The backend chooses the batch start time, unless you supplied one.
5. Each job gets an arrival time based on that start time plus its offset.
6. The backend saves the batch and all jobs in one transaction.
7. The jobs appear as `QUEUED` in the dashboard.

The same generation settings reproduce the same job specifications. Their database IDs can differ.

The job queue starts each row with a state icon; completed jobs have a check. Search by job name, type, worker, ID or container, combine status and worker filters, and click column headings to sort. **Latest updates** restores the default order. Counts and filters cover the loaded recent rows; the queue identifies when older jobs are outside that window. Age measures time since job creation. CPU and memory bars show requests relative to assigned worker capacity, including for finished jobs.

A custom API batch must provide one arrival offset per job, in order from smallest to largest. The browser sends the **IMMEDIATE** arrival pattern directly; the backend creates zero offsets so every job is eligible immediately. Sleep jobs take 2-10 seconds, depending on the resource profile. Compute jobs use bounded work units appropriate to their type.

## 3. Reuse an existing batch

`POST /api/workloads/:id/reuse` copies the saved job specifications into a new batch with new queued job records. It can use a new start time.

It copies stored specifications rather than calling the generator again. That preserves the old workload choices even if the generator changes later.

## 4. Ask the orchestrator to run work

The **Run workload** controls are part of the normal page flow; they do not stay fixed while you scroll. The page header has **Add workload**, **Kill all**, and **Run orchestrator** (which changes to **Pause** while browser auto-run is active). The settings row chooses FCFS, SJF, Priority, or Round Robin; First fit, Least loaded, or Resource-aware placement; and 1, 5, or 25 **Jobs started per tick**. The Round Robin quantum appears only for that policy.

**Run orchestrator** calls `POST /api/orchestrator/run` every two seconds with the chosen settings. **Try a demo · 10 jobs** generates ten small sleep jobs and starts that same timer. There are no separate single-job or batch-run buttons.

For each job, the backend:

1. Looks for an already scheduled job that needs its next step completed.
2. If there is none, asks the scheduler to choose an eligible queued job.
3. Chooses a worker if the job does not have one yet.
4. Reserves resources if they are not reserved yet.
5. Starts the execution.
6. Reports which steps succeeded and where it stopped, if any.

A call can advance up to 25 jobs. It does not wait for every container to finish. If there is no eligible work or the next job cannot fit, it reports that outcome instead of pretending a container started.

The pipeline and every job stage use matching two-digit tags: **01** Job queue, **02** Scheduler, **03** Placement, **04** Reservation, **05** Docker execution, and **06** Completed. Failed, interrupted, and cancelled jobs are grouped as **Ended early** without a seventh tag.

Auto mode is a browser timer that repeats run requests. `OrchestratorConsole` stays mounted when you change views, and a live dot beside **Run workload** shows that it is active elsewhere. Pausing it or closing the page stops requests but does not cancel containers already running. Auto mode stops once no unfinished job remains and the orchestrator reports nothing eligible.

## 5. Scheduling chooses the job

The scheduler looks for jobs that are still `QUEUED` and whose arrival time has passed. It orders them using the selected policy.

The chosen job becomes `SCHEDULED`. The policy, scheduling time, round count, and optional Round Robin time slice are saved.

The update requires the job to still be queued. If another request got there first, this request skips that job. Scheduling alone does not choose a worker or reserve any CPU or memory.

Preview scheduling shows the order without changing any records.

## 6. Placement chooses the worker

The backend reads worker capacities and current/planned load. It removes workers that cannot accept work or cannot fit both resource requests.

It then applies First Fit, Least Loaded, or Resource Aware and saves the chosen worker on the job. If no worker fits, it reports insufficient resources.

This is a plan, not a reservation. The worker's reserved counters have not changed yet. Preview placement shows candidates and reasons without saving a choice.

## 7. Reservation claims CPU and memory

For the selected worker, the backend:

1. Begins a database transaction.
2. Locks the worker record so another reservation must wait.
3. Checks whether this job already has a live reservation.
4. Reads the current free CPU and memory again.
5. If the job fits, creates a `RESERVED` allocation and increases the worker's reserved counters.
6. Sets the worker to `BUSY` and commits the changes together.

If there is not enough capacity, no reservation is created. If a database write fails, the transaction undoes its changes.

The job remains `SCHEDULED`. The allocation row is the record that its resources are reserved.

## 8. Execution starts the container

Before claiming execution, the backend checks Docker and the allowed workload image. A missing image produces an error asking you to build it; an unavailable Docker engine produces a separate error.

To start a job:

1. Lock the job record.
2. Check that it is scheduled, placed, and reserved.
3. Change the job to `RUNNING` and create an execution record.
4. Commit those database changes.
5. Create and start the workload container with the reserved CPU and memory limits.
6. Save the container ID.
7. Return a response while a backend task waits for the container to finish.

If creating or starting the container fails, the backend records the failure and releases the reservation through its normal finish-handling code.

## 9. Finish the run and release resources

When the container exits, the backend reads its result and capped output.

| What happened | Saved outcome |
| --- | --- |
| Exit code 0 and a valid result | `COMPLETED` |
| Non-zero exit, including running out of memory | `FAILED` |
| Exit code 0 but no valid expected result | `FAILED` |
| Stopped because it exceeded the time limit | `INTERRUPTED` |

One transaction saves the execution outcome, updates the job, changes the allocation to `RELEASED`, and subtracts its resources from the worker. If the worker has nothing reserved, it becomes `IDLE`.

The container is then removed. Saved output and results remain in MySQL until their records are cleared.

Repeating an already completed settle or release returns the saved outcome. It should not free the same resources twice.

## 10. Read current state and history

The dashboard regularly calls `GET /api/orchestrator/state` to display jobs, worker assignments, reservations, and execution progress.

The live job queue shows the most recently updated jobs first, including jobs that just started, finished, or were cancelled. This display order does not change the scheduler's policy. The response limit applies after sorting, so new changes remain visible even with a large job history. Pipeline counts, reservation totals, and worker running-job lists cover the whole database. Running-job details remain available from worker cards even when a job is outside the recent table. The orchestration endpoint reads these values from one repeatable database snapshot.

Worker cards on the **Run workload** and **Autoscaling** views also show each worker's finished attempts (completed and failed), using the same counts as monitoring.

The **Monitoring** view reads resource use and job timing summaries. It shows reserved capacity, the queue, throughput, and running containers in a 2 × 2 block, then the history chart and lifecycle timings. It does not make scheduling decisions.

Panels refresh independently. Job metrics show a loading or unavailable state until a successful read arrives; a returned zero is a measured zero. Failed refreshes retain the last successful values and their read time. API/database health is rechecked ten seconds after each completed check, with a ten-second request timeout; a recovered check clears the earlier error.

The sampler separately saves one usage snapshot per worker at the configured interval. Rows from the same pass share a timestamp. A repeated pass at that timestamp does not add duplicates. Old samples are removed according to the retention setting.

The collapsed **Monitoring tools** section contains **Refresh now** (read current metrics without saving anything) and **Save snapshot** (record one chart snapshot per worker immediately, even when the timer is disabled). Both are optional during normal automatic monitoring. The chart's saved-worker-snapshot count is historical observations, not completed jobs or an ML training dataset. CPU values use millicores: `1000m = 1 core`.

The history chart shows CPU and memory reservations as percentages of worker capacity. Sample positions use their actual timestamps, and the axis labels show the returned start/end times rather than assuming a full hour of data. Lines join recorded values; the time between samples is unmeasured. **Sample values** provides the timestamps and numerical percentages in a table. With no samples in the window, the dashboard points to Save snapshot without assuming periodic sampling is enabled.

## 11. Manage individual records

- Create one job with `POST /api/jobs`; it starts queued.
- Cancel any unfinished job in `CREATED`, `QUEUED`, `WAITING`, `SCHEDULED`, `RUNNING`, or `INTERRUPTED` from its drawer with **Cancel job** (`POST /api/jobs/:id/cancel`). For running work, the backend waits out an in-progress launch if needed, stops the managed container, lets its tracker settle, and records cancellation plus resource release transactionally. If completion or preemption wins the race, that outcome remains authoritative.
- Create a logical worker with `POST /api/workers`; it starts idle with no resources reserved.
- Read job, worker, allocation, and execution records through their GET endpoints.
- Click a job in the queue or a worker card to open its details drawer. It shows the job's resources, policy, worker, reservation, container, and recorded result. **Cancel job** (red) and **Requeue job** are at the top; **Advance one stage at a time** places, reserves, starts, or releases it one step at a time for demonstrations. Escape or the close button hides the drawer.

**Kill all** in the **Run workload** page header pauses browser auto-run, waits for in-flight launches, stops and removes only Docker containers labeled `orchestros.managed=true`, and cancels non-executing unfinished jobs. Active executions become `CANCELLED` and reservations are released transactionally. Failed stops are reported and their active execution reservations remain held. MySQL and unrelated Docker containers are kept.

The three default worker budgets are built in: 512/1024/1536 MiB and 500/1000/1500m CPU. Setup and backend startup configure idle workers automatically. Generated jobs use 64-256 MiB, 100-1000m CPU, and 2-10 second duration estimates. There is no lightweight toggle or preset button.

## 12. Clear finished jobs

On **Run workload**, open **Add workload**. The cleanup buttons are always visible at the bottom of that open panel; there is no separate expandable Cleanup section. Pause the orchestrator, then use **Clear generated workload** to call `POST /api/workloads/clear-generated`. This removes queued jobs linked to workload batches that have never been scheduled, including jobs whose arrival time is still in the future. The activity log reports the number removed and the dashboard refreshes the queue.

The delete checks job state in the database, so a job claimed by the scheduler is protected. Jobs with placement, allocations, or execution history are kept, including Round Robin jobs that returned to the queue. Manually created jobs are kept. Empty batches are removed only when no reused batch references them.

The dashboard calls `POST /api/orchestrator/clear-finished`.

The backend selects jobs in `COMPLETED`, `FAILED`, `INTERRUPTED`, or `CANCELLED` states. In one transaction it removes their execution records, allocations, and job records, then removes empty batches that are no longer referenced by reused batches.

Queued, scheduled, and running jobs are not selected for this cleanup. Workers and sampled usage history remain. Since finished records are removed, later summaries based on those records will change.

## 13. Compare scheduling policies

Open **Comparison**, choose **Scheduling policies**, select the policies and workload, and click **Run _n_ policies**. The form includes job count, arrival pattern, workload type, placement, seed, Round Robin quantum, and jobs started per tick. It displays the current unfinished-job count; every unfinished job must finish or be cancelled first. Use **Kill all** on **Run workload** or **Cancel job** in a job drawer when needed.

The browser calls `POST /api/benchmarks` and polls the benchmark list every 2 seconds while a suite runs.

1. The backend requires an idle cluster and the workload image, records one pending run per selected policy, and returns HTTP 202.
2. It pauses the autoscaler so every policy sees fixed capacity.
3. In FCFS, SJF, Priority, Round Robin order, it generates the first seeded batch and reuses its stored specifications thereafter. It records starting capacity and calls the normal orchestrator every second until the batch finishes. Round Robin uses the selected quantum.
4. It reads jobs and execution attempts, calculates metrics, and stores them on the run.
5. After completion, failure, or stop, it resumes the autoscaler, records the suite outcome, and marks runs that never started aborted.

**Stop benchmark** calls `POST /api/benchmarks/:id/abort`. The cooperative runner notices the request, calls Kill all, stores the partial current run as stopped, and skips the rest. The button reads **Stopping…** until that completes. Cancellation from elsewhere or a non-recoverable stage error stops the suite similarly.

The current result UI is table-based. A run table shows status, completed/failed counts, capacity, checksum/capacity comparability, progress, and early-stop details. One metrics table then gives each policy an inline horizontal bar, formatted value, difference from the first completed policy, and a **Better** result. Only the winning bar uses its policy colour and its value is bold. Equal values read **Both**, **All**, or **Tie**; values within one millisecond count as tied. Current policy colours are coral for FCFS, lavender for SJF, charcoal for Priority, and gray for Round Robin, with theme-adjusted dark values. Earlier suites remain available below the result.

## 14. Compare Reactive and ML-assisted autoscaling

Open **Comparison** and leave the default **Autoscaling: Reactive vs ML** mode selected. Click **New experiment**, then choose jobs, arrival pattern, workload type, scheduling policy, placement, seed, and Round Robin quantum where applicable. The experiment requires the autoscaler timer to be enabled, at least one allowed extra worker, an available workload image, and an idle cluster. Finish or cancel unfinished jobs before starting.

The browser calls `POST /api/scaling-comparisons`, then polls the list and active detail about every 2 seconds. The backend runs a controlled pair in a fixed order:

1. It saves the current autoscaler enabled state and strategy and records the shared thresholds, limits, cooldown, idle period, ML window, and look-ahead.
2. Before Reactive, it pauses autoscaling, retires every empty autoscaled worker, refuses to continue if an extra worker still holds work, and waits out cooldown from the latest saved scaling event.
3. It generates the seeded batch, clears the autoscaler's in-memory load history and last decision, enables Reactive, and drives jobs through the normal scheduler, placement, reservation, and Docker pipeline.
4. During the run it samples waiting jobs, workers, extra/idle workers, peak reservation, and forecast when applicable. Sampling targets 2-second intervals but slow work can delay it; missed intervals are not backfilled.
5. It pauses autoscaling at run close and stores job metrics, scaling actions, and the full timeline.
6. It resets the cluster and history again, reuses the first batch's saved job specifications, enables ML-assisted, and repeats the pipeline. The ML run therefore starts without inherited observations and must collect at least three autoscaler checks before forecasting.
7. Finally, it restores the prior enabled state and strategy, resumes autoscaling, and records the comparison outcome.

Reactive uses measured eligible queue length and peak reserved CPU/memory. ML-assisted fits independent linear trends to the rolling queue and peak-reservation observations and predicts them for the configured look-ahead. Both use the same thresholds, worker sizing, worker limit, host-memory ceiling, cooldown, lifecycle, and one-action-per-check rule. ML can add capacity before measured pressure crosses the line. It retires capacity only when both current and predicted load remain quiet.

The comparison page shows live progress; a shared timeline switch for utilization, queue, or workers; a takeaway; fairness warnings; the main result table; earlier comparisons; and detailed metrics, run records, scaling actions, and ML forecast accuracy. **Re-run** repeats the stored workload request with current autoscaler thresholds, and **Export** downloads the detailed result and timelines as JSON. Results are considered directly comparable only when both runs complete on the same base capacity with matching non-empty checksum digests.

**Stop comparison** calls `POST /api/scaling-comparisons/:id/abort`. The request returns before cancellation completes. The runner sees the flag on its next loop, calls Kill all, closes the current run as stopped, skips the remaining run, restores autoscaler state, and finalizes the comparison; the UI reads **Stopping…** meanwhile.

### ML data and clean controlled runs

There is no persistent training dataset. The autoscaler's ML input is an in-memory, oldest-first rolling window of measured `{ time, eligible queue, peak reserved utilization }` points. It is populated under either strategy, trimmed to the configured history-point count, and lost on backend restart. Normal manual switching from Reactive to ML can therefore reuse recent observations. Saved `scaling_events` are an audit history and monitoring `worker_samples` feed the monitoring chart; neither is loaded as ML input.

The supported clean-run reset is built into **Autoscaling: Reactive vs ML**: cluster reset and `resetHistory()` happen before each strategy. There is no UI/API button to erase ML history, scaling events, monitoring samples, or stored experiment history. **Clear generated workload** and **Clear finished jobs** affect job records only; clearing the browser Activity log affects only that list. Restarting the backend clears the ML window and runtime settings but leaves persisted actions and experiment records.

## 15. Control autoscaling

Open **Autoscaling**. Choose exactly one strategy with the **Reactive** or **ML-assisted** selector, then independently turn **Autoscaling** On or Off. Strategy selection PATCHes `strategy`; the switch PATCHes `enabled`.

The backend evaluates every `AUTOSCALE_INTERVAL_SECONDS` (default 5) when the loop is enabled. Reactive tests the current queue and reservations. ML-assisted predicts ahead from recent checks; until three points exist, its decision says it is collecting history. When ML is selected, the page shows predicted waiting jobs, predicted peak reservation, queue trend, recent points, look-ahead, and the forecast window. The signal cards show waiting jobs, CPU reserved, memory reserved, and workers in service, followed by the latest decision and reason.

**Rules and thresholds** changes queue/utilization thresholds, idle/cooldown timing, worker limits and size, and the ML history/look-ahead controls; it also provides a demo preset and defaults. **Scaling history** lists persisted scale changes and reasons. While either experiment owns the cluster, controls that would change its pipeline or autoscaler configuration are locked. Turning autoscaling off prevents additions but still lets eligible idle autoscaled workers retire; an experiment pause freezes all evaluation.

CPU and memory are intentionally neutral gray tones in gauges, bars, and chart lines. Coral/lavender identify policies or Reactive/ML-assisted rather than hardware resources.

## 16. Errors, shutdown, and recovery

Input errors return a readable error code and message. Invalid JSON returns HTTP 400; a request body over 16 KB returns HTTP 413. Unknown URLs return HTTP 404. The [API guide](api.md) explains the normal request format.

On SIGINT or SIGTERM, the server stops the recovery, monitoring, and autoscaler timers; requests cooperative abort of both an active scheduling-policy benchmark and an active Reactive-vs-ML comparison; closes its HTTP listener; awaits both experiment runners and pending execution settlements; disconnects Prisma; and exits. Either experiment's runner calls Kill all when it observes the abort, records the current run stopped, aborts runs that never started, and restores/resumes autoscaling. Ordinary workloads outside an experiment are not proactively cancelled, and shutdown has no hard deadline, so live work or an open operation can delay exit.

After a crash, startup recovery runs before the listener opens:

1. It reconciles open executions. A missing saved container ID is repaired from managed labels where possible. Exited containers settle; missing containers become infrastructure failures eligible for retry; live containers resume tracking for `current execution timeout - elapsed since saved start/create time`. The original deadline itself is not persisted.
2. It repairs the three study-worker definitions when safe.
3. It marks a persisted running scheduling-policy suite aborted. This recovery does not separately cancel that suite's queued/scheduled leftovers, so use **Kill all** or individual cancellation if they block the next experiment.
4. It marks persisted running Reactive-vs-ML comparisons and unfinished runs aborted and individually cancels unfinished jobs from their batches, releasing reservations.

Execution reconciliation and study-worker repair repeat every 30 seconds. Active experiment runners and ML history cannot resume because they lived in the old process. Completed experiment aggregates stay in MySQL; an active scaling run's timeline is lost if it had not yet been committed. Manual execution recovery remains available through `POST /api/executions/:executionId/settle`; it refuses a live container.
