# OrchestrOS guide

These guides describe the current implementation:

| You want to know... | Read this |
| --- | --- |
| How do I start and test the app? | [Running OrchestrOS](running.md) |
| What does each part do? | [Project structure](architecture.md) |
| What happens to a job? | [A job's journey](flow.md) |
| Why were these design choices made? | [Design choices](decision.md) |
| How do I call the backend? | [API guide](api.md) |
| What changed, and when? | [Change record](changes.md) |

The [main README](../Readme.md) gives a short overview and everyday startup commands.

## The interface at a glance

A top bar shows OrchestrOS, service status, and the light/dark theme selector. The **Workloads** sidebar keeps the selected view in the URL, such as `#monitoring`; keys 1–4 also switch views when focus is not in a form control.

| View | What it is for |
| --- | --- |
| **Run workload** | Choose scheduling and placement settings, generate work, and use **Run orchestrator** or **Pause**. It also shows the six-stage pipeline, workers, activity, job queue, and job-details drawer |
| **Autoscaling** | Turn autoscaling on or off, select **Reactive** or **ML-assisted**, edit thresholds, and inspect the current decision, forecast, scaling history, and workers |
| **Comparison** | Run either **Autoscaling: Reactive vs ML** or **Scheduling policies** against controlled, repeatable workloads and compare measured results |
| **Monitoring** | Inspect cluster state, reserved capacity, queue, 60-minute throughput, running work, recorded CPU and memory reservations, and lifecycle timings |

The orchestrator stays mounted and continues running when another view is open. A live marker appears beside **Run workload** in the sidebar.

Pipeline stages use numbered tags: **01 Job queue**, **02 Scheduler**, **03 Placement**, **04 Reservation**, **05 Docker execution**, and **06 Completed**. Terminated jobs have no stage number.

The interface uses warm cream surfaces, charcoal text, and terracotta primary actions. Stop and kill controls are outlined with red warning treatment. CPU and memory use neutral gray tones. Coral/lavender strategy colors and per-policy colors appear only in comparison charts, lines, dots, and chips.

## Autoscaling and ML

Exactly one autoscaling strategy is active at a time. Both strategies use the same thresholds, cooldown, worker limits, host-memory guard, and worker lifecycle:

- **Reactive** evaluates the measured queue and reserved utilization.
- **ML-assisted** predicts queue length and peak reserved utilization, then evaluates the prediction. Scale-down also requires the measured and predicted load to be quiet.

The ML implementation is JavaScript in the backend. It applies ordinary least squares (OLS) separately to queued jobs and peak reserved utilization over an oldest-first, in-memory sliding history, then projects both series by the configured look-ahead. It needs at least three samples. The history and runtime settings reset when the backend restarts; applied scaling events remain in MySQL.

The Reactive-vs-ML comparison runs Reactive first and ML second with the same seeded workload, scheduling policy, placement strategy, thresholds, limits, and worker capacity. It resets extra workers and the in-memory load history before each run and waits out any remaining cooldown.

## Words used in this project

| Word | Simple meaning |
| --- | --- |
| Job | One task for the system to run |
| Workload | The work a job performs, such as sorting numbers |
| Batch | A group of jobs created together |
| Queue | Jobs saved in MySQL that are waiting to be chosen |
| Worker | A logical group with a CPU and memory budget |
| Scheduling | Choosing which job goes next |
| Placement | Choosing the worker for a job |
| Reservation | Recording that a job has claimed some CPU and memory |
| Execution | One attempt to run a job in a Docker container |
| Container | A separate environment where Docker runs a program |
| API | URLs the frontend calls to ask the backend to do something |
| Schema | The description of the database tables and their fields |
| Migration | A saved SQL file that creates or changes the database structure |
| Seed | Either a number used to repeat generated workloads, or the setup script that creates starting workers; context distinguishes them |
| Transaction | A group of database changes that all succeed together or are all undone |
| Row lock | A temporary lock that makes competing changes to one database record wait |
| Constraint | A rule the database checks before accepting a change |
| Idempotent | Safe to repeat without applying the same change twice |
| Checksum | A small value used to compare workload results |
| Quantum | The time slice a Round Robin job may run before another waiting job gets a turn |
| Preemption | Stopping a running Round Robin job when its quantum expires, so it returns to the queue |
| Requeue | Sending a failed or interrupted job back to the queue for another attempt |
| Autoscaling | Adding or retiring extra logical workers automatically when the cluster is busy or idle |
| Autoscaling comparison | Running the same workload once with Reactive and once with ML-assisted autoscaling |
| Scheduling-policy comparison | Running the same workload once per selected scheduling policy |
| Turnaround | Time from a job's planned arrival until it completes |
| Waiting time | Turnaround minus the time the job spent running |
| Response time | Time from a job's planned arrival until its container first starts |
| Makespan | Time from the first job's arrival until the last job completes |
| p95 | A value near the slow end: about 95% of measurements fall at or below it |
| MiB | A memory unit; 1024 MiB is one GiB |
| Millicores | A CPU unit; 1000 millicores is one logical CPU core |

## Implementation scope

The app uses JavaScript/JSX and MySQL on one development computer. Docker runs real workloads; dashboard workers are logical capacity records. Worker-level failure detection through heartbeats is not implemented. Round Robin preemption restarts a job from the beginning instead of pausing and resuming its container. The old academic proposal files remain in the numbered folder under `docs/`; use these Markdown guides for the current implementation.
