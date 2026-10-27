# What happens when you use the app

This guide follows a job from creation to completion. The backend makes the scheduling and resource decisions; the browser sends requests and displays the results.

For a side-by-side code walkthrough, start with these files:

| Change | Where to read |
| --- | --- |
| Sticky header and the Run / Autoscaling / Policy comparison / Monitoring tabs (kept in the URL hash) | [App.jsx](../frontend/src/App.jsx) |
| Reference palette, responsive layout, and locally hosted Inter / Roboto Mono fonts | [theme.css](../frontend/src/theme.css), [styles.css](../frontend/src/styles.css), [main.jsx](../frontend/src/main.jsx) |
| Sticky run bar, and the Workload panel with seed and cleanup | [ControlPanel.jsx](../frontend/src/components/ControlPanel.jsx) |
| Run/Pause timer, Demo Mode, and the job details drawer; stays mounted so auto-run continues on every tab | [OrchestratorConsole.jsx](../frontend/src/OrchestratorConsole.jsx) |
| Autoscaling On/Off switch, signals, thresholds, and history | [AutoscalerPanel.jsx](../frontend/src/components/AutoscalerPanel.jsx) |
| Policy comparison form, results table, and per-policy coloured charts | [BenchmarkPanel.jsx](../frontend/src/components/BenchmarkPanel.jsx), [benchmark.chart.js](../frontend/src/benchmark.chart.js) |
| Worker cards with reservations, running containers, and finished attempts | [WorkerGrid.jsx](../frontend/src/components/WorkerGrid.jsx) |
| Browser API requests | [api.js](../frontend/src/api.js) |
| Built-in worker capacities and safe setup | [worker.defaults.js](../backend/src/modules/workers/worker.defaults.js) |
| Small resource profiles and type-specific work sizes | [workload.generator.js](../backend/src/modules/workloads/workload.generator.js) |
| Limits on custom generation requests | [workload.schemas.js](../backend/src/modules/workloads/workload.schemas.js) |
| Outer CPU (blue) / inner memory (green) reservation rings used by workers and monitoring | [CapacityGauge.jsx](../frontend/src/components/CapacityGauge.jsx) |
| Live metrics in a 2 × 2 block, utilization history, and lifecycle timings | [MonitoringPanel.jsx](../frontend/src/MonitoringPanel.jsx) |

## 1. Start the app

With the two-terminal setup, MySQL runs locally, one terminal runs the backend, and another runs the frontend.

With the full Compose setup, startup happens in this order:

1. Start MySQL and wait until a login and `SELECT 1` query succeed.
2. Run the database migration and create missing starting workers.
3. Start the backend and wait for its database health check.
4. Start the frontend.

The backend also starts the usage-history timer unless it has been disabled. The database health endpoint and Docker-runtime endpoint check different things.

## 2. Generate jobs

On the **Run** tab, open **Workload** (it starts open on an empty cluster), choose a job count, arrival pattern, workload type, and seed, then click Generate Workload. The panel folds away afterwards so the run bar and pipeline are in view. Clicking a job opens its details in a drawer on the right; Escape closes it. Resource sizes are automatic and small by default.

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

The run bar at the top of the **Run** tab stays in view while you scroll. **Run orchestrator** (green) calls `POST /api/orchestrator/run` every two seconds with the chosen policy and placement strategy. **Jobs started per tick** sets `maxJobs` for each call: 1 for a step-by-step demo, 5 for a steady load, or 25 to fill the cluster and trigger autoscaling. The Round Robin quantum field appears only when that policy is chosen. **Try a demo · 10 jobs** in the Workload panel generates ten small sleep jobs and starts the same orchestrator. There are no separate single-job or batch-run buttons.

For each job, the backend:

1. Looks for an already scheduled job that needs its next step completed.
2. If there is none, asks the scheduler to choose an eligible queued job.
3. Chooses a worker if the job does not have one yet.
4. Reserves resources if they are not reserved yet.
5. Starts the execution.
6. Reports which steps succeeded and where it stopped, if any.

A call can advance up to 25 jobs. It does not wait for every container to finish. If there is no eligible work or the next job cannot fit, it reports that outcome instead of pretending a container started.

Auto mode is a browser timer that repeats run requests. It keeps going when you switch tabs, and a green dot on the **Run** tab shows that it is active. Pausing it or closing the page stops those requests. It does not cancel containers already running. Auto mode stops by itself once the queue has drained and no container is left running.

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

Worker cards on the **Run** and **Autoscaling** tabs also show each worker's finished attempts (completed and failed), using the same counts as monitoring.

The **Monitoring** tab reads resource use and job timing summaries. It shows reserved capacity, the queue, throughput, and running containers in a 2 × 2 block, then the history chart and lifecycle timings. It does not make scheduling decisions.

Panels refresh independently. Job metrics show a loading or unavailable state until a successful read arrives; a returned zero is a measured zero. Failed refreshes retain the last successful values and their read time. API/database health is rechecked ten seconds after each completed check, with a ten-second request timeout; a recovered check clears the earlier error.

The sampler separately saves one usage snapshot per worker at the configured interval. Rows from the same pass share a timestamp. A repeated pass at that timestamp does not add duplicates. Old samples are removed according to the retention setting.

The collapsed **Monitoring tools** section contains **Refresh now** (read current metrics without saving anything) and **Save snapshot** (record one chart snapshot per worker immediately, even when the timer is disabled). Both are optional during normal automatic monitoring. The chart's saved-worker-snapshot count is historical observations, not completed jobs or an ML training dataset. CPU values use millicores: `1000m = 1 core`.

The history chart shows CPU and memory reservations as percentages of worker capacity. Sample positions use their actual timestamps, and the axis labels show the returned start/end times rather than assuming a full hour of data. Lines join recorded values; the time between samples is unmeasured. **Sample values** provides the timestamps and numerical percentages in a table. With no samples in the window, the dashboard points to Save snapshot without assuming periodic sampling is enabled.

## 11. Manage individual records

- Create one job with `POST /api/jobs`; it starts queued.
- Cancel a queued job with `POST /api/jobs/:id/cancel`.
- Create a logical worker with `POST /api/workers`; it starts idle with no resources reserved.
- Read job, worker, allocation, and execution records through their GET endpoints.
- Click a job in the queue or a worker card to open its details drawer. It shows the job's resources, policy, worker, reservation, container, and recorded result. **Cancel job** (red) and **Requeue job** are at the top; **Advance one stage at a time** places, reserves, starts, or releases it one step at a time for demonstrations. Escape or the close button hides the drawer.

**Kill all** (red, in the run bar) pauses browser auto-run, waits for in-flight launches, stops and removes only Docker containers labeled `orchestros.managed=true`, and cancels queued/scheduled jobs. Active executions become `CANCELLED` and reservations are released transactionally. Failed stops are reported and their active execution reservations remain held. MySQL and unrelated Docker containers are kept.

The three default worker budgets are built in: 512/1024/1536 MiB and 500/1000/1500m CPU. Setup and backend startup configure idle workers automatically. Generated jobs use 64-256 MiB, 100-1000m CPU, and 2-10 second duration estimates. There is no lightweight toggle or preset button.

## 12. Clear finished jobs

On the **Run** tab, open **Workload** and expand **Cleanup** for **Clear generated workload** and **Clear finished jobs**. Pause the orchestrator, then clear generated work to call `POST /api/workloads/clear-generated`. This removes queued jobs linked to workload batches that have never been scheduled, including jobs whose arrival time is still in the future. The activity log reports the number removed and the dashboard refreshes the queue.

The delete checks job state in the database, so a job claimed by the scheduler is protected. Jobs with placement, allocations, or execution history are kept, including Round Robin jobs that returned to the queue. Manually created jobs are kept. Empty batches are removed only when no reused batch references them.

The dashboard calls `POST /api/orchestrator/clear-finished`.

The backend selects jobs in `COMPLETED`, `FAILED`, `INTERRUPTED`, or `CANCELLED` states. In one transaction it removes their execution records, allocations, and job records, then removes empty batches that are no longer referenced by reused batches.

Queued, scheduled, and running jobs are not selected for this cleanup. Workers and sampled usage history remain. Since finished records are removed, later summaries based on those records will change.

## 13. Compare scheduling policies

Open the **Policy comparison** tab, choose the policies and workload, and press **Run**. The browser calls `POST /api/benchmarks` and then polls `GET /api/benchmarks` every 2 seconds while it runs.

1. The backend checks that no job is unfinished and that the workload image exists, records the suite with one pending run per policy, and returns 202.
2. It pauses the autoscaler.
3. For each policy in order (FCFS, SJF, Priority, Round Robin), it creates the batch (generated the first time, reused after that) and records the current capacity. It then calls the orchestrator every second with that policy until every job in the batch has finished. Round Robin uses the chosen quantum.
4. It reads the batch's jobs and execution attempts, calculates the metrics, and saves them on the run.
5. After the last run, or after a failure or stop, it resumes the autoscaler and records the suite's outcome. Runs that never started are marked aborted.

**Stop benchmark** calls `POST /api/benchmarks/:id/abort`. The runner stops all workloads, records the current run with what it measured so far, and skips the rest. A run whose jobs were cancelled from elsewhere, or that hits a stage error that will not clear by waiting (for example Docker being unavailable), ends the suite in the same way.

The results panel shows each run's status and capacity, a metrics table, and one bar chart per metric. Each policy keeps one colour everywhere (FCFS blue, SJF green, Priority amber, Round Robin purple), with a legend above the charts. The best value is outlined and marked ★ in the chart and labelled BEST in the table. If capacity or checksums differed, a note says the numbers are not directly comparable. Earlier comparisons stay listed under **Earlier benchmarks**.

## 14. Turn autoscaling on

Open the **Autoscaling** tab and press **Autoscaling: Off** (red); it turns green and reads **Autoscaling: On**. The browser sends `PATCH /api/autoscaler` with `{ "enabled": true }`.

From then on the backend checks the cluster every `AUTOSCALE_INTERVAL_SECONDS` (default 5) by itself. The four cards show the signals of the latest check: waiting jobs, CPU reserved, memory reserved, and workers in service. The line below them gives the decision and its reason. To see it scale up, generate 50 or 100 jobs and run with 25 jobs per tick; new `auto-worker-N` cards appear, and they are retired again once the cluster stays idle.

**Rules and thresholds** explains the current rule and lets you change the thresholds, use a quick demo preset, or restore defaults. **Scaling history** lists every change with its reason. While a policy comparison runs, a note says autoscaling is on hold.

## 15. Errors and shutdown

Input errors return a readable error code and message. Invalid JSON returns HTTP 400; a request body over 16 KB returns HTTP 413. Unknown URLs return HTTP 404. The [API guide](api.md) explains the normal request format.

On a normal shutdown signal, the server stops its sampler and autoscaler timer, stops a running benchmark and waits for it to record itself, closes its listener, waits for pending execution-result work, and disconnects from MySQL.

A forced stop or crash can leave a job marked running. On startup and every 30 seconds, the backend reconciles untracked open executions: it settles exited/missing containers and resumes tracking live containers using their original deadline. Missing outcomes are recorded as failures. Manual recovery remains available through `POST /api/executions/:executionId/settle`; it refuses a live container.
