import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  PlacementStrategy,
  SchedulingPolicy,
  WorkerStatus,
  WorkloadType,
  type Job,
  type JobExecution,
  type ResourceAllocation,
  type Worker,
} from "@prisma/client";

import { ConflictError } from "../../errors/app-error.js";
import type { DispatchResult } from "../scheduler/scheduler.service.js";
import type { AssignmentResult } from "../placement/placement.service.js";
import type { ReservationResult } from "../resources/resource.service.js";
import type { StartExecutionResult } from "../executions/execution.service.js";
import {
  derivePipelineStage,
  isEligibleNow,
  secondsUntilEligible,
} from "./orchestrator.pipeline.js";
import type {
  JobStateRow,
  OrchestratorRepository,
} from "./orchestrator.repository.js";
import {
  orchestratorStateQuerySchema,
  runOrchestratorSchema,
} from "./orchestrator.schemas.js";
import {
  OrchestratorService,
  type ExecutionDriver,
  type PlacementDriver,
  type ResourceDriver,
  type SchedulerDriver,
} from "./orchestrator.service.js";

const now = new Date("2026-09-23T12:00:00.000Z");

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    name: "job-1",
    workloadType: WorkloadType.SLEEP,
    workloadSize: 5,
    status: JobStatus.QUEUED,
    cpuRequiredMillicores: 800,
    memoryRequiredMiB: 256,
    estimatedDurationSeconds: 5,
    priority: 5,
    workloadBatchId: null,
    batchSequence: null,
    arrivalOffsetSeconds: 0,
    arrivalAt: now,
    schedulingPolicy: null,
    scheduledAt: null,
    timeQuantumSeconds: null,
    schedulingRounds: 0,
    placementStrategy: null,
    placedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    assignedWorkerId: null,
    containerId: null,
    result: null,
    failureReason: null,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    name: "worker-1",
    cpuCapacityMillicores: 2_000,
    memoryCapacityMiB: 2_048,
    cpuAllocatedMillicores: 0,
    memoryAllocatedMiB: 0,
    status: WorkerStatus.IDLE,
    lastHeartbeat: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAllocation(overrides: Partial<ResourceAllocation> = {}): ResourceAllocation {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    workerId: randomUUID(),
    cpuMillicores: 800,
    memoryMiB: 256,
    status: AllocationStatus.RESERVED,
    reservedAt: now,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<JobExecution> = {}): JobExecution {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    workerId: randomUUID(),
    allocationId: randomUUID(),
    attempt: 1,
    status: ExecutionStatus.RUNNING,
    containerId: "a".repeat(64),
    startedAt: now,
    completedAt: null,
    exitCode: null,
    stdout: null,
    stderr: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Repository fake. Only what the orchestrator asks for. */
class StubRepository implements OrchestratorRepository {
  reservationLookups: string[] = [];

  constructor(
    private readonly options: {
      resumable?: Job | null;
      reserved?: boolean;
      rows?: JobStateRow[];
      workers?: Worker[];
      statusCounts?: Record<string, number>;
    } = {},
  ) {}

  async findResumableJob(): Promise<Job | null> {
    return this.options.resumable ?? null;
  }

  async listJobStates(): Promise<JobStateRow[]> {
    return this.options.rows ?? [];
  }

  async listWorkers(): Promise<Worker[]> {
    return this.options.workers ?? [];
  }

  async countJobsByStatus(): Promise<Record<string, number>> {
    return this.options.statusCounts ?? {};
  }

  async findJobById(): Promise<Job | null> {
    return null;
  }

  async hasActiveReservation(jobId: string): Promise<boolean> {
    this.reservationLookups.push(jobId);
    return this.options.reserved ?? false;
  }

  async deleteFinishedJobs(): Promise<{ deletedJobs: number; deletedExecutions: number }> {
    return { deletedJobs: 0, deletedExecutions: 0 };
  }
}

class StubScheduler implements SchedulerDriver {
  calls: unknown[] = [];

  constructor(private readonly result: DispatchResult) {}

  async dispatch(input: unknown): Promise<DispatchResult> {
    this.calls.push(input);
    return this.result;
  }
}

class StubPlacement implements PlacementDriver {
  calls: unknown[] = [];

  constructor(
    private readonly worker: Worker | null,
    private readonly error?: Error,
  ) {}

  async assign(input: unknown): Promise<AssignmentResult> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return {
      strategy: PlacementStrategy.LEAST_LOADED,
      candidates: [],
      selected: this.worker
        ? {
            workerId: this.worker.id,
            name: this.worker.name,
            status: this.worker.status,
            cpuCapacityMillicores: this.worker.cpuCapacityMillicores,
            memoryCapacityMiB: this.worker.memoryCapacityMiB,
            cpuReservedMillicores: 0,
            memoryReservedMiB: 0,
            cpuAssignedMillicores: 0,
            memoryAssignedMiB: 0,
            cpuAvailableMillicores: this.worker.cpuCapacityMillicores,
            memoryAvailableMiB: this.worker.memoryCapacityMiB,
            cpuUtilization: 0,
            memoryUtilization: 0,
            schedulable: true,
          }
        : null,
      job: makeJob({ status: JobStatus.SCHEDULED, assignedWorkerId: this.worker?.id ?? null }),
    };
  }
}

class StubResources implements ResourceDriver {
  calls: unknown[] = [];

  constructor(
    private readonly worker: Worker,
    private readonly error?: Error,
  ) {}

  async reserve(input: unknown): Promise<ReservationResult> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return {
      allocation: makeAllocation({ workerId: this.worker.id }),
      worker: {
        ...this.worker,
        cpuAllocatedMillicores: 800,
        memoryAllocatedMiB: 256,
        status: WorkerStatus.BUSY,
      },
      lockWaitMs: 3,
    };
  }
}

class StubExecutions implements ExecutionDriver {
  calls: string[] = [];

  constructor(private readonly error?: Error) {}

  async start(jobId: string): Promise<StartExecutionResult> {
    this.calls.push(jobId);
    if (this.error) throw this.error;
    return {
      execution: makeExecution({ jobId }),
      job: makeJob({ id: jobId, status: JobStatus.RUNNING }),
      container: {
        id: "b".repeat(64),
        name: `orchestros-exec-${jobId}`,
        image: "orchestros/workload-runner:v1",
        cpuMillicores: 800,
        memoryMiB: 256,
        seed: 12345,
      },
      timeoutSeconds: 300,
    };
  }
}

function dispatchResult(jobs: Job[], eligibleCount = jobs.length): DispatchResult {
  return {
    policy: SchedulingPolicy.FCFS,
    timeQuantumSeconds: null,
    requested: 1,
    eligibleCount,
    scheduledCount: jobs.length,
    scheduled: jobs,
  };
}

const runInput = {
  policy: SchedulingPolicy.FCFS,
  strategy: PlacementStrategy.LEAST_LOADED,
  maxJobs: 1,
};

/* ------------------------------------------------------------------ */
/* Pure pipeline helpers                                               */
/* ------------------------------------------------------------------ */

test("a job's pipeline stage is derived from its persisted state", () => {
  assert.equal(
    derivePipelineStage({
      status: JobStatus.QUEUED,
      assignedWorkerId: null,
      hasActiveReservation: false,
      executionStatus: null,
    }),
    "QUEUE",
  );

  assert.equal(
    derivePipelineStage({
      status: JobStatus.SCHEDULED,
      assignedWorkerId: null,
      hasActiveReservation: false,
      executionStatus: null,
    }),
    "SCHEDULER",
    "scheduled but unplaced is still at the scheduler",
  );

  assert.equal(
    derivePipelineStage({
      status: JobStatus.SCHEDULED,
      assignedWorkerId: "worker",
      hasActiveReservation: false,
      executionStatus: null,
    }),
    "PLACEMENT",
    "placed without a reservation has not committed capacity yet",
  );

  assert.equal(
    derivePipelineStage({
      status: JobStatus.SCHEDULED,
      assignedWorkerId: "worker",
      hasActiveReservation: true,
      executionStatus: null,
    }),
    "RESERVATION",
    "capacity committed but no container started",
  );

  assert.equal(
    derivePipelineStage({
      status: JobStatus.RUNNING,
      assignedWorkerId: "worker",
      hasActiveReservation: true,
      executionStatus: ExecutionStatus.RUNNING,
    }),
    "EXECUTION",
  );

  assert.equal(
    derivePipelineStage({
      status: JobStatus.COMPLETED,
      assignedWorkerId: "worker",
      hasActiveReservation: false,
      executionStatus: ExecutionStatus.COMPLETED,
    }),
    "COMPLETED",
  );

  for (const status of [JobStatus.FAILED, JobStatus.INTERRUPTED, JobStatus.CANCELLED]) {
    assert.equal(
      derivePipelineStage({
        status,
        assignedWorkerId: null,
        hasActiveReservation: false,
        executionStatus: null,
      }),
      "TERMINATED",
      `${status} is a terminal stage`,
    );
  }
});

test("eligibility follows the planned arrival time", () => {
  const future = new Date(now.getTime() + 30_000);
  const past = new Date(now.getTime() - 30_000);

  assert.equal(isEligibleNow(JobStatus.QUEUED, past, now), true);
  assert.equal(isEligibleNow(JobStatus.QUEUED, future, now), false);
  assert.equal(isEligibleNow(JobStatus.QUEUED, now, now), true, "arrival exactly now is eligible");
  assert.equal(
    isEligibleNow(JobStatus.SCHEDULED, past, now),
    false,
    "an already scheduled job is not waiting in the queue",
  );

  assert.equal(secondsUntilEligible(future, now), 30);
  assert.equal(secondsUntilEligible(past, now), 0, "a passed arrival never reports a wait");
});

/* ------------------------------------------------------------------ */
/* runNext                                                             */
/* ------------------------------------------------------------------ */

test("running the next job drives schedule, placement, reservation, and execution", async () => {
  const worker = makeWorker();
  const queued = makeJob({ name: "job-alpha" });
  const scheduler = new StubScheduler(dispatchResult([queued], 4));
  const placement = new StubPlacement(worker);
  const resources = new StubResources(worker);
  const executions = new StubExecutions();

  const service = new OrchestratorService(
    new StubRepository(),
    scheduler,
    placement,
    resources,
    executions,
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.advanced, true);
  assert.equal(step.jobId, queued.id);
  assert.equal(step.jobName, "job-alpha");
  assert.equal(step.stoppedBecause, null);
  assert.deepEqual(
    step.stages.map((stage) => [stage.stage, stage.status]),
    [
      ["SCHEDULE", "OK"],
      ["PLACEMENT", "OK"],
      ["RESERVATION", "OK"],
      ["EXECUTION", "OK"],
    ],
    "all four stages ran in order",
  );

  assert.match(step.stages[0]?.detail ?? "", /FCFS.*4 eligible/);
  assert.match(step.stages[1]?.detail ?? "", /LEAST_LOADED chose worker-1/);
  assert.match(step.stages[2]?.detail ?? "", /800m CPU and 256MiB on worker-1/);
  assert.match(step.stages[2]?.detail ?? "", /row lock \(waited 3ms\)/);
  assert.match(step.stages[3]?.detail ?? "", /orchestros\/workload-runner:v1/);

  assert.equal(step.worker?.name, "worker-1");
  assert.equal(step.reservation?.cpuMillicores, 800);
  assert.equal(step.reservation?.lockWaitMs, 3);
  assert.equal(step.execution?.image, "orchestros/workload-runner:v1");
  assert.equal(step.execution?.timeoutSeconds, 300);

  // Each service received the decision the caller asked for.
  assert.deepEqual(scheduler.calls, [{ policy: "FCFS", count: 1 }]);
  assert.deepEqual(placement.calls, [{ jobId: queued.id, strategy: "LEAST_LOADED" }]);
  assert.deepEqual(resources.calls, [{ jobId: queued.id }]);
  assert.deepEqual(executions.calls, [queued.id]);
});

test("an empty queue reports nothing eligible instead of failing", async () => {
  const placement = new StubPlacement(makeWorker());
  const executions = new StubExecutions();
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([], 0)),
    placement,
    new StubResources(makeWorker()),
    executions,
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.advanced, false);
  assert.equal(step.jobId, null);
  assert.equal(step.stoppedBecause, "NOTHING_ELIGIBLE");
  assert.equal(step.stages[0]?.status, "SKIPPED");
  assert.match(step.stages[0]?.detail ?? "", /planned arrival/);
  assert.equal(placement.calls.length, 0, "nothing downstream is attempted");
  assert.equal(executions.calls.length, 0);
});

test("a job left half-advanced is resumed instead of a new one being pulled", async () => {
  const worker = makeWorker();
  const placed = makeJob({
    name: "job-resume",
    status: JobStatus.SCHEDULED,
    schedulingPolicy: SchedulingPolicy.SJF,
    assignedWorkerId: worker.id,
  });
  const scheduler = new StubScheduler(dispatchResult([makeJob({ name: "job-other" })]));
  const placement = new StubPlacement(worker);
  const service = new OrchestratorService(
    new StubRepository({ resumable: placed, reserved: true }),
    scheduler,
    placement,
    new StubResources(worker),
    new StubExecutions(),
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.jobName, "job-resume");
  assert.equal(scheduler.calls.length, 0, "the queue is not touched while work is unfinished");
  assert.deepEqual(
    step.stages.map((stage) => [stage.stage, stage.status]),
    [
      ["SCHEDULE", "SKIPPED"],
      ["PLACEMENT", "SKIPPED"],
      ["RESERVATION", "SKIPPED"],
      ["EXECUTION", "OK"],
    ],
    "already-completed stages are skipped, not repeated",
  );
  assert.match(step.stages[0]?.detail ?? "", /SJF/);
  assert.equal(placement.calls.length, 0, "a placed job is not placed again");
});

test("a full cluster stops the step as a normal outcome, not an error", async () => {
  const worker = makeWorker();
  const scheduler = new StubScheduler(dispatchResult([makeJob({ name: "job-big" })]));
  const resources = new StubResources(worker);
  const executions = new StubExecutions();

  const service = new OrchestratorService(
    new StubRepository(),
    scheduler,
    new StubPlacement(
      null,
      new ConflictError(
        "No worker has enough available CPU and memory for this job",
        "INSUFFICIENT_RESOURCES",
      ),
    ),
    resources,
    executions,
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.advanced, true, "a job was claimed, so the step did advance");
  assert.equal(step.stoppedBecause, "INSUFFICIENT_RESOURCES");
  assert.equal(step.execution, null);
  const placementStage = step.stages.find((stage) => stage.stage === "PLACEMENT");
  assert.equal(placementStage?.status, "FAILED");
  assert.equal(placementStage?.code, "INSUFFICIENT_RESOURCES");
  assert.equal(resources.calls.length, 0, "reservation is never attempted after placement fails");
  assert.equal(executions.calls.length, 0);
});

test("a failed reservation stops before any container is created", async () => {
  const worker = makeWorker();
  const executions = new StubExecutions();
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([makeJob()])),
    new StubPlacement(worker),
    new StubResources(
      worker,
      new ConflictError("Worker no longer has capacity", "INSUFFICIENT_RESOURCES"),
    ),
    executions,
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.stoppedBecause, "INSUFFICIENT_RESOURCES");
  assert.equal(step.reservation, null);
  assert.equal(
    step.stages.find((stage) => stage.stage === "RESERVATION")?.status,
    "FAILED",
  );
  assert.equal(executions.calls.length, 0, "no container is started without committed capacity");
});

test("a failed execution is reported with its code and keeps the reservation facts", async () => {
  const worker = makeWorker();
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([makeJob()])),
    new StubPlacement(worker),
    new StubResources(worker),
    new StubExecutions(
      new ConflictError("Another request already started this job", "EXECUTION_ALREADY_STARTED"),
    ),
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.stoppedBecause, "EXECUTION_ALREADY_STARTED");
  assert.equal(step.execution, null);
  assert.equal(
    step.reservation?.cpuMillicores,
    800,
    "what already succeeded is still reported",
  );
  const stage = step.stages.find((entry) => entry.stage === "EXECUTION");
  assert.equal(stage?.status, "FAILED");
  assert.equal(stage?.code, "EXECUTION_ALREADY_STARTED");
});

test("an unexpected failure is reported without leaking a stack trace", async () => {
  const worker = makeWorker();
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([makeJob()])),
    new StubPlacement(worker),
    new StubResources(worker),
    new StubExecutions(new Error("socket hang up")),
    () => now,
  );

  const step = await service.runNext(runInput);

  assert.equal(step.stoppedBecause, "INTERNAL_ERROR");
  assert.equal(
    step.stages.find((stage) => stage.stage === "EXECUTION")?.detail,
    "socket hang up",
  );
});

test("the round robin quantum is passed through only when it is set", async () => {
  const worker = makeWorker();
  const scheduler = new StubScheduler(dispatchResult([makeJob()]));
  const service = new OrchestratorService(
    new StubRepository(),
    scheduler,
    new StubPlacement(worker),
    new StubResources(worker),
    new StubExecutions(),
    () => now,
  );

  await service.runNext({
    policy: SchedulingPolicy.ROUND_ROBIN,
    strategy: PlacementStrategy.FIRST_FIT,
    maxJobs: 1,
    timeQuantumSeconds: 15,
  });

  assert.deepEqual(scheduler.calls, [
    { policy: "ROUND_ROBIN", count: 1, timeQuantumSeconds: 15 },
  ]);
});

/* ------------------------------------------------------------------ */
/* run (batch)                                                         */
/* ------------------------------------------------------------------ */

test("a batch run advances several jobs and counts the containers it started", async () => {
  const worker = makeWorker();
  const executions = new StubExecutions();
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([makeJob({ name: "batch-job" })])),
    new StubPlacement(worker),
    new StubResources(worker),
    executions,
    () => now,
  );

  const result = await service.run({ ...runInput, maxJobs: 3 });

  assert.equal(result.requested, 3);
  assert.equal(result.startedCount, 3);
  assert.equal(result.steps.length, 3);
  assert.equal(result.stoppedBecause, null);
  assert.equal(executions.calls.length, 3);
  assert.equal(result.policy, SchedulingPolicy.FCFS);
  assert.equal(result.strategy, PlacementStrategy.LEAST_LOADED);
});

test("a batch run stops at the first step that cannot finish", async () => {
  const worker = makeWorker();
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([makeJob()])),
    new StubPlacement(
      null,
      new ConflictError("No worker has enough capacity", "INSUFFICIENT_RESOURCES"),
    ),
    new StubResources(worker),
    new StubExecutions(),
    () => now,
  );

  const result = await service.run({ ...runInput, maxJobs: 10 });

  assert.equal(result.steps.length, 1, "it does not keep retrying a full cluster");
  assert.equal(result.startedCount, 0);
  assert.equal(result.stoppedBecause, "INSUFFICIENT_RESOURCES");
});

test("a batch run against an empty queue stops immediately", async () => {
  const service = new OrchestratorService(
    new StubRepository(),
    new StubScheduler(dispatchResult([], 0)),
    new StubPlacement(makeWorker()),
    new StubResources(makeWorker()),
    new StubExecutions(),
    () => now,
  );

  const result = await service.run({ ...runInput, maxJobs: 25 });

  assert.equal(result.steps.length, 1);
  assert.equal(result.startedCount, 0);
  assert.equal(result.stoppedBecause, "NOTHING_ELIGIBLE");
});

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

test("the state snapshot groups jobs by stage and attaches workers and containers", async () => {
  const worker = makeWorker({
    name: "worker-2",
    cpuCapacityMillicores: 4_000,
    cpuAllocatedMillicores: 800,
    memoryCapacityMiB: 4_096,
    memoryAllocatedMiB: 256,
    status: WorkerStatus.BUSY,
  });

  const runningJob = makeJob({
    name: "running-job",
    status: JobStatus.RUNNING,
    assignedWorkerId: worker.id,
    placementStrategy: PlacementStrategy.FIRST_FIT,
    schedulingPolicy: SchedulingPolicy.FCFS,
  });
  const waitingJob = makeJob({
    name: "waiting-job",
    arrivalAt: new Date(now.getTime() + 45_000),
  });
  const doneJob = makeJob({
    name: "done-job",
    status: JobStatus.COMPLETED,
    result: { checksum: "abcd1234" },
  });

  const rows: JobStateRow[] = [
    {
      job: runningJob,
      workerName: worker.name,
      hasActiveReservation: true,
      reservation: {
        id: randomUUID(),
        cpuMillicores: 800,
        memoryMiB: 256,
        reservedAt: now,
      },
      execution: {
        id: randomUUID(),
        status: ExecutionStatus.RUNNING,
        attempt: 1,
        containerId: "c".repeat(64),
        startedAt: new Date(now.getTime() - 7_000),
        completedAt: null,
        exitCode: null,
        failureReason: null,
      },
    },
    {
      job: waitingJob,
      workerName: null,
      hasActiveReservation: false,
      reservation: null,
      execution: null,
    },
    {
      job: doneJob,
      workerName: null,
      hasActiveReservation: false,
      reservation: null,
      execution: null,
    },
  ];

  const service = new OrchestratorService(
    new StubRepository({
      rows,
      workers: [worker],
      statusCounts: { QUEUED: 1, RUNNING: 1, COMPLETED: 1 },
    }),
    new StubScheduler(dispatchResult([])),
    new StubPlacement(worker),
    new StubResources(worker),
    new StubExecutions(),
    () => now,
  );

  const state = await service.state({ limit: 60 });

  assert.equal(state.capturedAt, now.toISOString());
  assert.equal(state.stageCounts.EXECUTION, 1);
  assert.equal(state.stageCounts.QUEUE, 1);
  assert.equal(state.stageCounts.COMPLETED, 1);
  assert.equal(state.totals.jobs, 3);
  assert.equal(state.totals.activeReservations, 1);
  assert.equal(state.totals.runningContainers, 1);
  assert.equal(state.totals.waitingForArrival, 1, "a future arrival is counted as waiting");
  assert.equal(state.totals.eligibleNow, 0);

  const running = state.jobs.find((job) => job.name === "running-job");
  assert.ok(running);
  assert.equal(running.stage, "EXECUTION");
  assert.equal(running.assignedWorkerName, "worker-2");
  assert.equal(running.reservation?.cpuMillicores, 800);
  assert.equal(running.execution?.containerShortId, "c".repeat(12));
  assert.equal(running.execution?.elapsedSeconds, 7, "elapsed time is measured from startedAt");

  const waiting = state.jobs.find((job) => job.name === "waiting-job");
  assert.equal(waiting?.eligibleNow, false);
  assert.equal(waiting?.secondsUntilEligible, 45);

  const done = state.jobs.find((job) => job.name === "done-job");
  assert.deepEqual(done?.result, { checksum: "abcd1234" });

  const reportedWorker = state.workers[0];
  assert.ok(reportedWorker);
  assert.equal(reportedWorker.cpuUtilization, 0.2, "800 of 4000 millicores");
  assert.equal(reportedWorker.memoryUtilization, 0.0625);
  assert.deepEqual(reportedWorker.runningJobs, [
    { jobId: runningJob.id, jobName: "running-job", containerShortId: "c".repeat(12) },
  ]);
});

test("a completed execution reports its measured duration, not a growing one", async () => {
  const worker = makeWorker();
  const job = makeJob({ status: JobStatus.COMPLETED, assignedWorkerId: worker.id });
  const service = new OrchestratorService(
    new StubRepository({
      workers: [worker],
      rows: [
        {
          job,
          workerName: worker.name,
          hasActiveReservation: false,
          reservation: null,
          execution: {
            id: randomUUID(),
            status: ExecutionStatus.COMPLETED,
            attempt: 1,
            containerId: "d".repeat(64),
            startedAt: new Date(now.getTime() - 60_000),
            completedAt: new Date(now.getTime() - 48_000),
            exitCode: 0,
            failureReason: null,
          },
        },
      ],
    }),
    new StubScheduler(dispatchResult([])),
    new StubPlacement(worker),
    new StubResources(worker),
    new StubExecutions(),
    () => now,
  );

  const state = await service.state({ limit: 10 });
  assert.equal(
    state.jobs[0]?.execution?.elapsedSeconds,
    12,
    "duration is completedAt minus startedAt once finished",
  );
  assert.equal(state.totals.runningContainers, 0);
});

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

test("orchestrator run input is strictly validated", () => {
  assert.equal(
    runOrchestratorSchema.safeParse({ policy: "FCFS", strategy: "FIRST_FIT" }).data?.maxJobs,
    1,
    "a single step is the default",
  );
  assert.equal(
    runOrchestratorSchema.safeParse({ policy: "NOPE", strategy: "FIRST_FIT" }).success,
    false,
  );
  assert.equal(
    runOrchestratorSchema.safeParse({ policy: "FCFS", strategy: "BEST_FIT" }).success,
    false,
  );
  assert.equal(runOrchestratorSchema.safeParse({ policy: "FCFS" }).success, false);
  assert.equal(
    runOrchestratorSchema.safeParse({ policy: "FCFS", strategy: "FIRST_FIT", maxJobs: 0 })
      .success,
    false,
  );
  assert.equal(
    runOrchestratorSchema.safeParse({ policy: "FCFS", strategy: "FIRST_FIT", maxJobs: 500 })
      .success,
    false,
    "a run is bounded so one call cannot start unlimited containers",
  );
  assert.equal(
    runOrchestratorSchema.safeParse({
      policy: "FCFS",
      strategy: "FIRST_FIT",
      timeQuantumSeconds: 10,
    }).success,
    false,
    "a quantum only applies to round robin",
  );
  assert.equal(
    runOrchestratorSchema.safeParse({
      policy: "ROUND_ROBIN",
      strategy: "FIRST_FIT",
      timeQuantumSeconds: 10,
    }).success,
    true,
  );
  assert.equal(
    runOrchestratorSchema.safeParse({
      policy: "FCFS",
      strategy: "FIRST_FIT",
      jobId: randomUUID(),
    }).success,
    false,
    "clients cannot choose which job runs next",
  );

  assert.equal(orchestratorStateQuerySchema.safeParse({}).data?.limit, 60);
  assert.equal(orchestratorStateQuerySchema.safeParse({ limit: "25" }).success, true);
  assert.equal(orchestratorStateQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(orchestratorStateQuerySchema.safeParse({ limit: 999 }).success, false);
  assert.equal(orchestratorStateQuerySchema.safeParse({ unknown: 1 }).success, false);
});
