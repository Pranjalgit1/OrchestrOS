# Why the project works this way

This is a plain-language summary of the current design choices. It includes the early project decisions and the JavaScript/MySQL update completed on 5 October 2026.

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

The seed script looks up workers by name. It creates `worker-1`, `worker-2`, and `worker-3` if they are missing and leaves existing records unchanged.

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

The job is updated only if it is still queued, so competing requests cannot both claim it. Priority aging helps long-waiting jobs get a turn. Actual Round Robin pause/resume behavior remains future work.

## 10. Account for planned worker load

Placement includes saved reservations and the requirements of jobs already assigned to workers. This helps avoid repeatedly choosing the same worker before execution begins.

First Fit chooses the first suitable worker. Least Loaded checks current usage. Resource Aware estimates usage after adding the new job and prefers lower, more balanced CPU and memory usage. Its formula is visible in the code rather than hidden in a model.

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

Manual settle exists for finished work that was not recorded correctly after an interruption. Automatic recovery still needs to be built.

## 14. Calculate current metrics from the actual records

Job counts, current reservations, and outcomes come from the same records the application uses. There is no separate set of monitoring counters to keep updated.

History is different: current counters cannot tell us what usage was an hour ago. The sampler saves timestamped worker snapshots for that purpose. It writes only monitoring history, not job or reservation state.

A repeated pass at the same timestamp does not create duplicates. Each pass also removes expired history. Query windows have limits so one dashboard request cannot ask for unlimited history.

## 15. Make empty results honest

An unmeasured timing stage has count 0. A success rate with no outcomes is `null`, meaning there is not enough data yet.

MySQL calculates timing differences and p95. JavaScript converts the returned numeric values into numbers the API can send as JSON. Small charts use the existing frontend tools without a chart-library dependency.

## 16. Let the browser control the backend workflow

The dashboard is the normal demonstration interface. It calls the orchestrator API rather than making users run four separate API commands for each job.

The backend still owns all decisions. Per-stage buttons remain useful for learning and debugging. Browser auto mode repeats run requests; pausing it does not kill running work.

The Immediate demo uses a valid custom batch with all arrival offsets set to zero. It does not need a separate demo-only backend path.

Clear finished jobs is a backend transaction that removes finished job records and their related history in the required order. It leaves queued and running jobs out of the selection.

## 17. Use both small tests and real-system tests

Services can receive simple in-memory replacements for database or Docker operations. This lets small tests check their rules quickly.

Separate integration tests use real MySQL and Docker to check constraints, concurrent requests, rollback, resource release, and actual container results. Test files run one at a time because some operations work across the whole test database.

The migration's full verification passed 130 tests. See [the change record](changes.md) for the tested setup and [the run guide](running.md) for the commands.
