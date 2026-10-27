# Project documentation

These guides explain the current project in simple language. Start at the top and read further when you need more detail.

| You want to know... | Read this |
| --- | --- |
| How do I start the app? | [Running and testing](running.md) |
| What does each part do? | [Project structure](architecture.md) |
| What happens to a job after I click Run? | [A job's journey](flow.md) |
| Why were these design choices made? | [Design choices](decision.md) |
| How do I call the backend directly? | [API guide](api.md) |
| What changed, and when? | [Change record](changes.md) |

The [main README](../Readme.md) gives a short overview and the everyday startup commands.

## The dashboard at a glance

The dashboard has four tabs under a sticky header. The tab is kept in the URL, for example `#monitoring`.

| Tab | What it is for |
| --- | --- |
| **Run** | A sticky run bar (policy, placement, jobs per tick, Run / Pause, Kill all), the Workload panel for generating jobs, the pipeline, worker cards, the job queue, and the activity log. Clicking a job opens its details in a drawer on the right |
| **Autoscaling** | The Autoscaling On/Off switch, the signals it decides on, its rules and thresholds, its history, and the worker cards so you can watch workers being added and retired |
| **Policy comparison** | Run the same workload under several scheduling policies and compare the measured results in a table and colour-coded charts |
| **Monitoring** | Reserved capacity, queue, throughput, and running containers in a 2 × 2 block, the reservation history chart, and lifecycle timings |

The orchestrator keeps running while another tab is open; a green dot on the **Run** tab shows that it is active.

Colour is used only where it means something: green buttons start an action and red buttons stop one, CPU is blue and memory is green in every ring, bar, and chart, and each scheduling policy has its own colour in comparisons.

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
| Seed | Either a number used to repeat generated workloads, or the setup script that creates starting workers; the surrounding text tells you which |
| Transaction | A group of database changes that all succeed together or are all undone |
| Row lock | A temporary lock that makes competing changes to one database record wait |
| Constraint | A rule the database itself checks before accepting a change |
| Idempotent | Safe to repeat without applying the same change twice |
| Checksum | A small value used to compare workload results |
| Quantum | The time slice a Round Robin job may run before another waiting job gets a turn |
| Preemption | Stopping a running Round Robin job when its quantum expires, so it goes back to the queue |
| Requeue | Sending a failed or interrupted job back to the queue for another attempt |
| Autoscaling | Adding or retiring extra logical workers automatically when the cluster is busy or idle |
| Policy comparison (benchmark) | Running the same workload once per scheduling policy and comparing the results |
| Turnaround | Time from a job's planned arrival until it completes |
| Waiting time | Turnaround minus the time the job actually spent running |
| Response time | Time from a job's planned arrival until its container first starts |
| Makespan | Time from the first job's arrival until the last job completes |
| p95 | A timing value near the slow end of the measurements: about 95% of measurements fall at or below it |
| MiB | A memory unit; 1024 MiB is one GiB |
| Millicores | A CPU unit; 1000 millicores is one logical CPU core |

## What the docs describe

The app uses JavaScript/JSX and MySQL. It runs on one development computer. Docker runs real workloads; the workers shown on the dashboard are logical capacity records.

Features described as planned are not implemented yet: worker-level failure detection (heartbeats) and machine-learning (predictive) autoscaling. Round Robin preemption restarts a job from the beginning rather than pausing and resuming its container. The old academic proposal files remain in the numbered folder under `docs/`; use these Markdown guides for the current implementation.
