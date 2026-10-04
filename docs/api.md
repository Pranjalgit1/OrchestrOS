# API guide

The dashboard normally calls these URLs for you. Use this guide when testing the backend directly or learning how each stage works.

For local development, the base URL is **http://localhost:4000/api**. All paths below start after `/api`.

Send JSON with `Content-Type: application/json` for requests that have a body. Replace sample ID placeholders with IDs returned by the app. Requests reject unknown fields and values outside the allowed ranges.

## 1. Main browser actions

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/workloads/generate` | Create a batch of queued jobs |
| POST | `/orchestrator/run` | Advance jobs through scheduling, placement, reservation, and execution |
| GET | `/orchestrator/state` | Read jobs, workers, and their current stages |
| POST | `/orchestrator/clear-finished` | Remove finished job records and their related execution/allocation records |

Example run request:

```json
{
  "policy": "FCFS",
  "strategy": "FIRST_FIT",
  "maxJobs": 1
}
```

`maxJobs` accepts 1-25 and defaults to 1. `policy` and `strategy` are required. Round Robin can also supply `timeQuantumSeconds` from 1-3600. That field is rejected for other policies.

State accepts `limit` from 1-200, default 60. A run response reports which steps happened; it does not mean all started containers have finished.

## 2. Job and worker records

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/jobs` | Create one queued job |
| GET | `/jobs` | List jobs, optionally filtered by `status` |
| GET | `/jobs/:id` | Read one job |
| POST | `/jobs/:id/cancel` | Cancel a queued job |
| POST | `/workers` | Create one logical worker |
| GET | `/workers` | List workers |
| GET | `/workers/:id` | Read one worker |

Example job:

```json
{
  "name": "sleep-demo",
  "workloadType": "SLEEP",
  "workloadSize": 5,
  "cpuRequiredMillicores": 500,
  "memoryRequiredMiB": 256,
  "estimatedDurationSeconds": 5,
  "priority": 5
}
```

| Job field | Allowed values |
| --- | --- |
| `name` | 1-100 characters after trimming spaces |
| `workloadType` | `CPU_INTENSIVE`, `MATRIX_MULTIPLICATION`, `SORTING`, `DATA_PROCESSING`, or `SLEEP` |
| `workloadSize` | Integer 1-100,000,000; defaults to 1 |
| `cpuRequiredMillicores` | Integer 100-64,000 |
| `memoryRequiredMiB` | Integer 64-131,072 |
| `estimatedDurationSeconds` | Integer 1-86,400 |
| `priority` | Integer 1-10; defaults to 5, with 10 highest |

The workload runner applies its own smaller work limits, described in [the architecture guide](architecture.md). An estimate is not a promise about actual duration.

Job lists accept `limit` from 1-100, default 50.

Example worker:

```json
{
  "name": "worker-demo",
  "cpuCapacityMillicores": 2000,
  "memoryCapacityMiB": 2048
}
```

Worker names allow letters, numbers, hyphens, and underscores, start with a letter or number, and are 1-64 characters long. CPU accepts 100-64,000 millicores. Memory accepts 128-131,072 MiB. New workers start idle with nothing reserved.

## 3. Workload batches

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/workloads/generate` | Generate and save a batch and its jobs together |
| GET | `/workloads/:id` | Read a batch and its jobs in sequence |
| POST | `/workloads/:id/reuse` | Copy saved specifications into a new batch |

Example generation request:

```json
{
  "seed": 12345,
  "count": 10,
  "pattern": "BURST"
}
```

The seed is an integer from 0-2,147,483,647. Counts are exactly 10, 25, 50, or 100. Patterns are listed in [the architecture guide](architecture.md).

`startAt` is optional. If omitted, the backend uses the request time. To supply it, use an ISO timestamp with a timezone, such as `2026-10-05T10:00:00+05:30`. Arrival times are calculated from that starting point.

A custom request includes all these fields:

```json
{
  "seed": 42,
  "count": 10,
  "pattern": "CUSTOM",
  "custom": {
    "workloadTypes": ["SLEEP"],
    "workloadSize": { "min": 4, "max": 10 },
    "cpuRequiredMillicores": { "min": 500, "max": 1000 },
    "memoryRequiredMiB": { "min": 128, "max": 256 },
    "estimatedDurationSeconds": { "min": 4, "max": 10 },
    "priority": { "min": 1, "max": 10 },
    "arrivalOffsetsSeconds": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  }
}
```

Each range uses `min` and `max`, with `min <= max`, within the job limits above. Arrival offsets are integers from 0-86,400. There must be one offset per job, and they must be in nondecreasing order. `custom` is required only for `CUSTOM` and rejected for other patterns.

A reuse request can be `{}` or contain only `startAt`. It copies stored specifications, not the source jobs' current states or results.

## 4. Individual scheduling and placement steps

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/scheduler/preview?policy=SJF&limit=20` | Show the selection order without changing jobs |
| POST | `/scheduler/dispatch` | Mark selected queued jobs as scheduled |
| GET | `/placement/capacity` | Read each worker's calculated free capacity |
| GET | `/placement/preview?jobId=JOB_ID&strategy=LEAST_LOADED` | Show worker candidates and the proposed choice |
| POST | `/placement/assign` | Save the chosen worker on a scheduled job |

Scheduling policies are `FCFS`, `SJF`, `PRIORITY`, and `ROUND_ROBIN`. Dispatch accepts `count` from 1-100, default 1. Preview accepts `limit` from 1-100, default 20.

Example dispatch:

```json
{
  "policy": "ROUND_ROBIN",
  "count": 5,
  "timeQuantumSeconds": 15
}
```

Placement strategies are `FIRST_FIT`, `LEAST_LOADED`, and `RESOURCE_AWARE`.

Example assignment, after replacing the placeholder with a real job ID:

```json
{
  "jobId": "JOB_ID",
  "strategy": "RESOURCE_AWARE"
}
```

Scheduling alone does not pick a worker. Placement alone does not reserve resources.

## 5. Reservations and executions

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/resources/reserve` | Reserve a placed job's CPU and memory |
| POST | `/resources/release` | Release that job's reservation |
| GET | `/resources/allocations` | Read allocation history |
| GET | `/executions/runtime` | Check Docker and the fixed workload image |
| POST | `/executions/start` | Start a reserved job's container |
| POST | `/executions/:executionId/settle` | Record the outcome of a finished execution |
| GET | `/executions` | List execution records |
| GET | `/executions/:executionId` | Read one execution and its saved output |

Reserve, release, and start each take a real job ID:

```json
{ "jobId": "JOB_ID" }
```

The backend takes the worker and resource amounts from the job. You cannot override them in these requests. You also cannot supply a Docker image, command, arbitrary environment, or per-request timeout.

Allocation lists accept optional `jobId`, `workerId`, and `status`. Execution lists use the same filter names for execution records. Both accept `limit` from 1-100, default 50.

A successful start returns HTTP 202: the run has started, but it has not necessarily finished. Settling a container that is still running returns a conflict. Settling an already recorded outcome returns that outcome without releasing resources again.

## 6. Monitoring

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/monitoring/overview` | Read workers, resource use, queue counts, and running executions |
| GET | `/monitoring/jobs?windowMinutes=60` | Read job timing summaries, throughput, and success rate |
| GET | `/monitoring/samples?windowMinutes=60` | Read sampled usage history |
| GET | `/monitoring/config` | Read the sampling interval and retention settings |
| POST | `/monitoring/sample` | Save a sample immediately |

`windowMinutes` accepts 1-10,080, default 60. Samples also accept `workerId` and `limit` from 1-5000, default 500.

These reads do not change job scheduling or resource reservations. Capturing a sample writes monitoring history only.

## 7. Basic checks and errors

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | Basic API information |
| GET | `/health` | Check the main application tables can be read |

Errors include a code and readable message, for example:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "issues": []
  }
}
```

| HTTP status | Usual meaning |
| --- | --- |
| 400 | Invalid input or malformed JSON |
| 404 | Record or route not found |
| 409 | The requested action conflicts with the current state |
| 413 | Request body exceeds 16 KB |
| 503 | A required dependency, such as Docker or the workload image, is unavailable |

Use [the run guide](running.md) for common setup problems and [the job flow](flow.md) to understand when each endpoint is called.
