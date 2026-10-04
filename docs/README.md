# Project documentation

These guides explain the current project in simple language. Start at the top and read further when you need more detail.

| You want to know... | Read this |
| --- | --- |
| How do I start the app? | [Running and testing](running.md) |
| What does each part do? | [Project structure](architecture.md) |
| What happens to a job after I click Run? | [A job's journey](flow.md) |
| Why were these design choices made? | [Design choices](decision.md) |
| How do I call the backend directly? | [API guide](api.md) |
| What work was completed during the migration? | [Change record](changes.md) |

The [main README](../Readme.md) gives a short overview and the everyday startup commands.

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
| p95 | A timing value near the slow end of the measurements: about 95% of measurements fall at or below it |
| MiB | A memory unit; 1024 MiB is one GiB |
| Millicores | A CPU unit; 1000 millicores is one logical CPU core |

## What the docs describe

The app uses JavaScript/JSX and MySQL. It runs on one development computer. Docker runs real workloads; the workers shown on the dashboard are logical capacity records.

Features described as planned are not implemented yet. The old academic proposal files remain in the numbered folder under `docs/`; use these Markdown guides for the current implementation.
