# How the project is built

OrchestrOS runs computing jobs on one development computer. It combines a browser dashboard, a JavaScript backend, MySQL, and Docker.

The browser asks for work to happen. The backend makes the decisions. MySQL stores what happened. Docker runs each workload.

```text
Browser: React dashboard
          |
          | API requests
          v
Backend: Express application
          |                 |
          v                 v
       MySQL          Docker containers
   saved records       actual workloads
```

## 1. Main parts

| Part | Main job | Where to look |
| --- | --- | --- |
| Dashboard | Show controls, jobs, workers, results, and graphs | `frontend/src/` |
| API setup | Connect routes, validate request bodies, and report errors | `backend/src/app.js` |
| Server | Listen for requests, start monitoring, and handle shutdown | `backend/src/server.js` |
| Orchestrator | Call scheduling, placement, reservation, and execution in order | `backend/src/modules/orchestrator/` |
| Jobs and workers | Create and read their database records | `backend/src/modules/jobs/`, `backend/src/modules/workers/` |
| Workload generator | Create repeatable batches of job specifications | `backend/src/modules/workloads/` |
| Scheduler | Choose the next job | `backend/src/modules/scheduler/` |
| Placement | Choose a worker | `backend/src/modules/placement/` |
| Resources | Reserve and release CPU and memory | `backend/src/modules/resources/` |
| Executions | Start Docker containers and record results | `backend/src/modules/executions/` |
| Monitoring | Read current values and save usage history | `backend/src/modules/monitoring/` |
| Workload program | Do the actual calculation inside a container | `workload-runner/run.js` |

Most backend features use the same file pattern:

| File ending | Purpose |
| --- | --- |
| `.routes.js` | Connect an API URL to its handler |
| `.schemas.js` | Check that incoming values are allowed |
| `.service.js` | Apply the feature's rules |
| `.repository.js` | Read and change database records |
| `.test.js` | Check behavior with controlled inputs |
| `.integration.test.js` | Check behavior using a real database or container |

Some features also have calculation-only files, such as `scheduler.policies.js` and `placement.accounting.js`. These are easier to test because they do not need a server or database.

## 2. What MySQL stores

The table definitions are in [schema.prisma](../backend/prisma/schema.prisma). The initial SQL is in [the MySQL migration](../backend/prisma/migrations/20261005000000_mysql_initial/migration.sql).

| Table | What one row means |
| --- | --- |
| `workload_batches` | A saved group of generated jobs and the settings used to create them |
| `jobs` | One job, its resource needs, current state, timing, and result |
| `workers` | One logical worker's capacity, reserved resources, and state |
| `resource_allocations` | A job's CPU and memory reservation, including released history |
| `job_executions` | One attempt to run a job in a container |
| `worker_samples` | One worker's resource-use snapshot at a particular time |

The queue is saved in `jobs`. There is no second queue that must be kept in sync with MySQL.

Prisma is the library the backend uses for most database operations. Raw SQL is used where needed, including row locks and some monitoring calculations.

## 3. Jobs and states

Jobs created manually or by the generator start as `QUEUED`.

```text
QUEUED -> SCHEDULED -> RUNNING -> COMPLETED
   |                       | -> FAILED
   |                       | -> INTERRUPTED
   v
CANCELLED
```

| State | Meaning |
| --- | --- |
| `QUEUED` | Waiting to be chosen; its arrival time may still be in the future |
| `SCHEDULED` | Chosen by the scheduler; it may still need a worker or reservation |
| `RUNNING` | Execution has been claimed; the container is starting or running |
| `COMPLETED` | Finished successfully and returned a valid result |
| `FAILED` | Could not start, exited with an error, or did not return a valid result |
| `INTERRUPTED` | The system stopped the run after its time limit |
| `CANCELLED` | Cancelled while queued |

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

New workers start `IDLE` with nothing reserved. A worker with a reservation becomes `BUSY`; it becomes `IDLE` again when its reserved CPU and memory reach zero. The model also supports `STARTING`, `ACTIVE`, `STOPPING`, and `FAILED`.

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

Round Robin records a time slice, normally 10 seconds, and increases the job's round count. The accepted time slice is 1-3600 seconds. Actually pausing and resuming a running container is still planned.

The scheduler changes a job only if it is still queued. This stops two simultaneous scheduling requests from both selecting the same job successfully.

## 7. Placement: which worker should receive it?

Placement chooses a worker for an already scheduled job. It saves the choice, strategy, and time. Reservation happens afterward.

A worker must be `IDLE`, `ACTIVE`, or `BUSY`, and its calculated free CPU and memory must both fit the job. Placement considers saved reservation counters and the requirements of jobs already assigned in scheduled/running states.

| Strategy | How it chooses |
| --- | --- |
| `FIRST_FIT` | First suitable worker in name order |
| `LEAST_LOADED` | Worker with the lowest current load, using the higher of CPU and memory usage |
| `RESOURCE_AWARE` | Worker that would have the best balance and lowest high usage after adding the job |

The Resource Aware score is `0.7 * peak + 0.3 * imbalance`. Here, peak is the higher of the expected CPU and memory usage fractions, and imbalance is their difference. Lower scores win. Worker names break ties.

If no worker fits, placement reports insufficient resources. A saved placement is only a plan: reservation checks the real counters again before granting capacity.

## 8. Reservation: make the capacity claim real

Suppose a worker has 1000 millicores free and two jobs each ask for 700. Both jobs cannot be granted 700.

The reservation code starts a **transaction**, locks the worker's row, checks for an existing reservation, and reads its current free capacity. It then saves the allocation and updates the worker counters together. A competing request for that worker waits, then checks the updated values.

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

The backend talks directly to Docker's API. In Compose, only the backend receives the Docker socket. This gives it control over the host Docker engine, so this setup is intended for a local development machine.

When a run finishes, the backend saves the outcome and frees its resources in one database transaction. It then removes the container. A zero exit code counts as success only if the expected result is present. Errors are `FAILED`; a time limit is `INTERRUPTED`.

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

## 11. What is unfinished

Automatic scaling, worker-level failure recovery, individual runtime cancellation, actual Round Robin preemption, machine learning, and full experiment comparison are still planned. Closing the browser stops its auto-run requests, but already started work continues while the backend runs. Kill all workloads explicitly stops the app's workload containers and cancels pending jobs.

After a backend crash, startup recovery and a 30-second reconciliation pass settle untracked exited/missing containers and resume tracking live executions against their original deadline. The manual settle endpoint remains available. Completion uses the Docker finish timestamp when available, so stale recovery does not inflate execution duration.

Read [the job flow](flow.md) for the steps in order, or [the design choices](decision.md) for why these decisions were made.
