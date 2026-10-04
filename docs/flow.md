# What happens when you use the app

This guide follows a job from creation to completion. The backend makes the scheduling and resource decisions; the browser sends requests and displays the results.

## 1. Start the app

With the two-terminal setup, MySQL runs locally, one terminal runs the backend, and another runs the frontend.

With the full Compose setup, startup happens in this order:

1. Start MySQL and wait until a login and `SELECT 1` query succeed.
2. Run the database migration and create missing starting workers.
3. Start the backend and wait for its database health check.
4. Start the frontend.

The backend also starts the usage-history timer unless it has been disabled. The database health endpoint and Docker-runtime endpoint check different things.

## 2. Generate jobs

You choose a seed, job count, and pattern, then click Generate Workload.

1. The browser sends `POST /api/workloads/generate`.
2. The backend rejects missing, unknown, or out-of-range inputs.
3. The generator chooses each job's type, size, resources, priority, duration estimate, and arrival offset.
4. The backend chooses the batch start time, unless you supplied one.
5. Each job gets an arrival time based on that start time plus its offset.
6. The backend saves the batch and all jobs in one transaction.
7. The jobs appear as `QUEUED` in the dashboard.

The same generation settings reproduce the same job specifications. Their database IDs can differ.

A custom batch must provide one arrival offset per job, in order from smallest to largest. The browser's Immediate preset uses ten or more zero offsets, so every generated job is eligible immediately. Its Sleep preset chooses small durations that are easy to watch.

## 3. Reuse an existing batch

`POST /api/workloads/:id/reuse` copies the saved job specifications into a new batch with new queued job records. It can use a new start time.

It copies stored specifications rather than calling the generator again. That preserves the old workload choices even if the generator changes later.

## 4. Ask the orchestrator to run work

Run Next, Run N, and auto mode call `POST /api/orchestrator/run` with the chosen policy and placement strategy.

For each job, the backend:

1. Looks for an already scheduled job that needs its next step completed.
2. If there is none, asks the scheduler to choose an eligible queued job.
3. Chooses a worker if the job does not have one yet.
4. Reserves resources if they are not reserved yet.
5. Starts the execution.
6. Reports which steps succeeded and where it stopped, if any.

A call can advance up to 25 jobs. It does not wait for every container to finish. If there is no eligible work or the next job cannot fit, it reports that outcome instead of pretending a container started.

Auto mode is a browser timer that repeats run requests. Pausing it or closing the page stops those requests. It does not cancel containers already running.

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

The monitoring panel reads resource use and job timing summaries. It does not make scheduling decisions.

The sampler separately saves one usage snapshot per worker at the configured interval. Rows from the same pass share a timestamp. A repeated pass at that timestamp does not add duplicates. Old samples are removed according to the retention setting.

The Capture sample button requests a sample immediately, even when the timer is disabled.

## 11. Manage individual records

- Create one job with `POST /api/jobs`; it starts queued.
- Cancel a queued job with `POST /api/jobs/:id/cancel`.
- Create a logical worker with `POST /api/workers`; it starts idle with no resources reserved.
- Read job, worker, allocation, and execution records through their GET endpoints.
- Use the selected-job stage buttons to inspect or advance a step when demonstrating how the system works.

Cancelling a running container from the UI is not implemented yet.

## 12. Clear finished jobs

The dashboard calls `POST /api/orchestrator/clear-finished`.

The backend selects jobs in `COMPLETED`, `FAILED`, `INTERRUPTED`, or `CANCELLED` states. In one transaction it removes their execution records, allocations, and job records, then removes empty batches that are no longer referenced by reused batches.

Queued, scheduled, and running jobs are not selected for this cleanup. Workers and sampled usage history remain. Since finished records are removed, later summaries based on those records will change.

## 13. Errors and shutdown

Input errors return a readable error code and message. Invalid JSON returns HTTP 400; a request body over 16 KB returns HTTP 413. Unknown URLs return HTTP 404. The [API guide](api.md) explains the normal request format.

On a normal shutdown signal, the server stops its sampler, closes its listener, waits for pending execution-result work, and disconnects from MySQL.

A forced stop or crash can still leave a job marked running. Once its container has finished, `POST /api/executions/:executionId/settle` can save the outcome and release resources. It refuses to settle a container that is still running. If the container is missing, it records an explicit failure rather than inventing a result. Automatic crash recovery is planned.
