import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
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
} from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { executionService } from "../executions/execution.service.js";
import { prismaPlacementRepository } from "../placement/placement.repository.js";
import { PlacementService } from "../placement/placement.service.js";
import { resourceService } from "../resources/resource.service.js";
import {
  prismaSchedulerRepository,
  type SchedulerRepository,
} from "../scheduler/scheduler.repository.js";
import { SchedulerService, schedulerService } from "../scheduler/scheduler.service.js";
import {
  prismaOrchestratorRepository,
  type OrchestratorRepository,
} from "./orchestrator.repository.js";
import { OrchestratorService, type ExecutionDriver } from "./orchestrator.service.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
const dockerTestsEnabled =
  process.env.RUN_DATABASE_TESTS === "true" && process.env.RUN_DOCKER_TESTS === "true";

/**
 * Execution needs Docker, so the database-only tests stop at reservation using a
 * driver that records the call instead of launching a container. Everything
 * before execution is the real service against real PostgreSQL.
 */
class RecordingExecutionDriver implements ExecutionDriver {
  readonly started: string[] = [];

  async start(jobId: string) {
    this.started.push(jobId);

    // The real service claims the job as its first step, moving it out of
    // SCHEDULED. Mirroring that here keeps the orchestrator's resume logic
    // behaving as it does in production without needing Docker.
    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.RUNNING, startedAt: new Date() },
    });

    return {
      execution: {
        id: randomUUID(),
        jobId,
        workerId: randomUUID(),
        allocationId: randomUUID(),
        attempt: 1,
        status: ExecutionStatus.RUNNING,
        containerId: null,
        startedAt: new Date(),
        completedAt: null,
        exitCode: null,
        stdout: null,
        stderr: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      job: await prisma.job.findUniqueOrThrow({ where: { id: jobId } }),
      container: {
        id: "f".repeat(64),
        name: `orchestros-exec-${jobId}`,
        image: "orchestros/workload-runner:v1",
        cpuMillicores: 0,
        memoryMiB: 0,
        seed: 1,
      },
      timeoutSeconds: 300,
    };
  }
}

/**
 * Both the scheduler and the orchestrator's resume lookup intentionally consider
 * every job in the database, so a leftover job from another run would be picked
 * ahead of this test's. These wrappers scope candidate discovery to the test's
 * own prefix while still exercising the real claim, placement, reservation, and
 * database writes, matching the pattern the scheduler integration tests use.
 */
function scopedScheduler(prefix: string): SchedulerService {
  const repository: SchedulerRepository = {
    async findEligible(now, limit) {
      const jobs = await prismaSchedulerRepository.findEligible(now, 500);
      return jobs.filter((job) => job.name.startsWith(prefix)).slice(0, limit);
    },
    claim: prismaSchedulerRepository.claim,
    findById: prismaSchedulerRepository.findById,
  };
  return new SchedulerService(repository);
}

/**
 * Placement also considers every worker in the database, so a worker created by
 * another test file could legitimately win. Scoping the candidate list keeps the
 * capacity assertions in this file about this file's own workers.
 */
function scopedPlacement(prefix: string): PlacementService {
  return new PlacementService({
    ...prismaPlacementRepository,
    async listWorkers() {
      const workers = await prismaPlacementRepository.listWorkers();
      return workers.filter((worker) => worker.name.startsWith(prefix));
    },
  });
}

function scopedRepository(prefix: string): OrchestratorRepository {
  return {
    ...prismaOrchestratorRepository,
    findResumableJob() {
      return prisma.job.findFirst({
        where: {
          status: JobStatus.SCHEDULED,
          name: { startsWith: prefix },
          executions: {
            none: { status: { in: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING] } },
          },
        },
        orderBy: [{ scheduledAt: "asc" }, { arrivalAt: "asc" }, { id: "asc" }],
      });
    },
  };
}

function serviceFor(prefix: string, execution: ExecutionDriver): OrchestratorService {
  return new OrchestratorService(
    scopedRepository(prefix),
    scopedScheduler(prefix),
    scopedPlacement(prefix),
    resourceService,
    execution,
  );
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}/api`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function makeWorker(prefix: string, cpu = 2_000, memory = 2_048) {
  return prisma.worker.create({
    data: {
      name: `${prefix}-worker-${randomUUID().slice(0, 6)}`,
      cpuCapacityMillicores: cpu,
      memoryCapacityMiB: memory,
      status: WorkerStatus.IDLE,
    },
  });
}

async function makeQueuedJob(
  prefix: string,
  overrides: Partial<Job> = {},
): Promise<Job> {
  return prisma.job.create({
    data: {
      name: `${prefix}-${randomUUID().slice(0, 6)}`,
      workloadType: overrides.workloadType ?? WorkloadType.SLEEP,
      workloadSize: overrides.workloadSize ?? 4,
      status: JobStatus.QUEUED,
      cpuRequiredMillicores: overrides.cpuRequiredMillicores ?? 800,
      memoryRequiredMiB: overrides.memoryRequiredMiB ?? 256,
      estimatedDurationSeconds: overrides.estimatedDurationSeconds ?? 4,
      priority: overrides.priority ?? 5,
      arrivalAt: overrides.arrivalAt ?? new Date(Date.now() - 1_000),
    },
  });
}

async function cleanup(prefix: string): Promise<void> {
  await prisma.jobExecution.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
  await prisma.resourceAllocation.deleteMany({
    where: { job: { name: { startsWith: prefix } } },
  });
  await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.workerSample.deleteMany({ where: { worker: { name: { startsWith: prefix } } } });
  await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
}

test(
  "one orchestrator call schedules, places, and reserves a queued job",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `orch-run-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const job = await makeQueuedJob(prefix);
      const execution = new RecordingExecutionDriver();

      const step = await serviceFor(prefix, execution).runNext({
        policy: SchedulingPolicy.FCFS,
        strategy: PlacementStrategy.LEAST_LOADED,
        maxJobs: 1,
      });

      assert.equal(step.advanced, true);
      assert.equal(step.jobId, job.id, "the queued job was selected");
      assert.equal(step.stoppedBecause, null);
      assert.deepEqual(
        step.stages.map((stage) => `${stage.stage}:${stage.status}`),
        ["SCHEDULE:OK", "PLACEMENT:OK", "RESERVATION:OK", "EXECUTION:OK"],
      );

      // The real services wrote real state.
      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(stored.status, JobStatus.RUNNING, "execution claimed the job");
      assert.equal(stored.schedulingPolicy, SchedulingPolicy.FCFS);
      assert.ok(stored.scheduledAt, "scheduling was recorded");
      assert.equal(stored.placementStrategy, PlacementStrategy.LEAST_LOADED);
      assert.equal(stored.assignedWorkerId, worker.id);

      const allocation = await prisma.resourceAllocation.findFirstOrThrow({
        where: { jobId: job.id },
      });
      assert.equal(allocation.status, AllocationStatus.RESERVED);
      assert.equal(allocation.cpuMillicores, 800);
      assert.equal(allocation.workerId, worker.id);

      const busy = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(busy.cpuAllocatedMillicores, 800, "the worker's counters moved");
      assert.equal(busy.memoryAllocatedMiB, 256);
      assert.equal(busy.status, WorkerStatus.BUSY);

      assert.deepEqual(execution.started, [job.id], "execution was invoked exactly once");
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "the orchestrator stops cleanly when no worker can fit the next job",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `orch-full-${randomUUID().slice(0, 8)}`;

    try {
      // A worker that fits exactly one of the two jobs.
      await makeWorker(prefix, 1_000, 1_024);
      await makeQueuedJob(prefix, { cpuRequiredMillicores: 800, memoryRequiredMiB: 256 });
      await makeQueuedJob(prefix, { cpuRequiredMillicores: 800, memoryRequiredMiB: 256 });

      const execution = new RecordingExecutionDriver();
      const result = await serviceFor(prefix, execution).run({
        policy: SchedulingPolicy.FCFS,
        strategy: PlacementStrategy.FIRST_FIT,
        maxJobs: 5,
      });

      assert.equal(
        result.stoppedBecause,
        "INSUFFICIENT_RESOURCES",
        "a full cluster is the stopping condition",
      );
      assert.equal(result.startedCount, 1, "only the job that fits was started");
      assert.equal(execution.started.length, 1);

      const reserved = await prisma.resourceAllocation.count({
        where: {
          status: AllocationStatus.RESERVED,
          job: { name: { startsWith: prefix } },
        },
      });
      assert.equal(reserved, 1, "capacity was committed once, not twice");

      const workers = await prisma.worker.findMany({
        where: { name: { startsWith: prefix } },
      });
      for (const worker of workers) {
        assert.ok(
          worker.cpuAllocatedMillicores <= worker.cpuCapacityMillicores,
          "the orchestrator cannot overcommit a worker",
        );
      }
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "a job left placed but unreserved is resumed rather than skipped",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `orch-resume-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const job = await makeQueuedJob(prefix);

      // Advance it halfway using the individual stage services, the way the
      // per-stage buttons in the dashboard do.
      await scopedScheduler(prefix).dispatch({ policy: SchedulingPolicy.SJF, count: 1 });
      await scopedPlacement(prefix).assign({
        jobId: job.id,
        strategy: PlacementStrategy.FIRST_FIT,
      });

      const halfway = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(halfway.status, JobStatus.SCHEDULED);
      assert.equal(halfway.assignedWorkerId, worker.id);
      assert.equal(
        await prisma.resourceAllocation.count({ where: { jobId: job.id } }),
        0,
        "no capacity committed yet",
      );

      const execution = new RecordingExecutionDriver();
      const step = await serviceFor(prefix, execution).runNext({
        policy: SchedulingPolicy.FCFS,
        strategy: PlacementStrategy.LEAST_LOADED,
        maxJobs: 1,
      });

      assert.equal(step.jobId, job.id, "the half-advanced job was resumed");
      assert.deepEqual(
        step.stages.map((stage) => `${stage.stage}:${stage.status}`),
        ["SCHEDULE:SKIPPED", "PLACEMENT:SKIPPED", "RESERVATION:OK", "EXECUTION:OK"],
        "completed stages are not repeated",
      );

      const reserved = await prisma.resourceAllocation.findFirstOrThrow({
        where: { jobId: job.id },
      });
      assert.equal(reserved.status, AllocationStatus.RESERVED);
      assert.equal(
        (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).placementStrategy,
        PlacementStrategy.FIRST_FIT,
        "the original placement decision is preserved",
      );
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "the state snapshot reports each job's real pipeline stage",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `orch-state-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const queued = await makeQueuedJob(prefix);
      const future = await makeQueuedJob(prefix, {
        arrivalAt: new Date(Date.now() + 120_000),
      });

      const service = serviceFor(prefix, new RecordingExecutionDriver());
      const before = await service.state({ limit: 200 });
      const queuedView = before.jobs.find((job) => job.id === queued.id);
      const futureView = before.jobs.find((job) => job.id === future.id);

      assert.equal(queuedView?.stage, "QUEUE");
      assert.equal(queuedView?.eligibleNow, true);
      assert.equal(futureView?.eligibleNow, false);
      assert.ok(
        (futureView?.secondsUntilEligible ?? 0) > 100,
        "a future arrival reports how long it still has to wait",
      );

      await service.runNext({
        policy: SchedulingPolicy.FCFS,
        strategy: PlacementStrategy.LEAST_LOADED,
        maxJobs: 1,
      });

      const after = await service.state({ limit: 200 });
      const advanced = after.jobs.find((job) => job.id === queued.id);
      assert.equal(advanced?.stage, "EXECUTION", "the job reached the execution stage");
      assert.equal(advanced?.assignedWorkerName, worker.name);
      assert.equal(
        advanced?.reservation?.cpuMillicores,
        800,
        "a running job still holds its committed capacity",
      );
      assert.equal(advanced?.schedulingPolicy, SchedulingPolicy.FCFS);
      assert.ok(after.stageCounts.EXECUTION >= 1);
      assert.ok(after.totals.activeReservations >= 1);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "clearing finished jobs leaves active work untouched",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `orch-clear-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const done = await makeQueuedJob(prefix);
      const active = await makeQueuedJob(prefix);

      await prisma.job.update({
        where: { id: done.id },
        data: { status: JobStatus.COMPLETED, completedAt: new Date() },
      });

      // Give the active job a live reservation so it must survive the clear.
      await scopedScheduler(prefix).dispatch({ policy: SchedulingPolicy.FCFS, count: 1 });
      await scopedPlacement(prefix).assign({
        jobId: active.id,
        strategy: PlacementStrategy.FIRST_FIT,
      });
      await resourceService.reserve({ jobId: active.id });

      const result = await serviceFor(prefix, new RecordingExecutionDriver()).clearFinished();
      assert.ok(result.deletedJobs >= 1, "the completed job was removed");

      assert.equal(
        await prisma.job.count({ where: { id: done.id } }),
        0,
        "finished work is gone",
      );
      const survivor = await prisma.job.findUniqueOrThrow({ where: { id: active.id } });
      assert.equal(survivor.status, JobStatus.SCHEDULED, "reserved work is untouched");
      assert.equal(
        await prisma.resourceAllocation.count({
          where: { jobId: active.id, status: AllocationStatus.RESERVED },
        }),
        1,
        "its reservation survives",
      );

      const stillBusy = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(
        stillBusy.cpuAllocatedMillicores,
        800,
        "worker counters are not corrupted by clearing history",
      );
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "orchestrator routes drive the pipeline and validate their input",
  { skip: !databaseTestsEnabled },
  async () => {
    try {
      await withServer(async (baseUrl) => {
        const post = (path: string, body: unknown) =>
          fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });

        const stateResponse = await fetch(`${baseUrl}/orchestrator/state`);
        const state = (await stateResponse.json()) as {
          jobs: unknown[];
          workers: unknown[];
          stageCounts: Record<string, number>;
        };
        assert.equal(stateResponse.status, 200);
        assert.ok(Array.isArray(state.jobs));
        assert.ok(Array.isArray(state.workers));
        assert.ok(
          Object.keys(state.stageCounts).includes("RESERVATION"),
          "every stage is reported so the pipeline view never has gaps",
        );

        assert.equal((await fetch(`${baseUrl}/orchestrator/state?limit=0`)).status, 400);
        assert.equal((await fetch(`${baseUrl}/orchestrator/state?nope=1`)).status, 400);

        const badPolicy = await post("/orchestrator/run", {
          policy: "ROUND_ROBBIN",
          strategy: "FIRST_FIT",
        });
        assert.equal(badPolicy.status, 400);

        const quantumMisuse = await post("/orchestrator/run", {
          policy: "FCFS",
          strategy: "FIRST_FIT",
          timeQuantumSeconds: 10,
        });
        assert.equal(quantumMisuse.status, 400, "a quantum is round-robin only");

        const picksJob = await post("/orchestrator/run", {
          policy: "FCFS",
          strategy: "FIRST_FIT",
          jobId: randomUUID(),
        });
        assert.equal(picksJob.status, 400, "a client cannot choose which job runs next");

        // A valid run against a possibly empty queue must still answer cleanly.
        const run = await post("/orchestrator/run", {
          policy: "FCFS",
          strategy: "LEAST_LOADED",
          maxJobs: 1,
        });
        const runBody = (await run.json()) as {
          steps: { stages: unknown[] }[];
          startedCount: number;
        };
        assert.equal(run.status, 202);
        assert.ok(Array.isArray(runBody.steps));
        assert.ok(runBody.startedCount >= 0);

        const cleared = await post("/orchestrator/clear-finished", {});
        const clearedBody = (await cleared.json()) as { deletedJobs: number };
        assert.equal(cleared.status, 200);
        assert.ok(clearedBody.deletedJobs >= 0);
      });
    } finally {
      await prisma.$disconnect();
    }
  },
);

test(
  "the orchestrator runs a real container end to end and releases its capacity",
  { skip: !dockerTestsEnabled },
  async () => {
    const prefix = `orch-docker-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix, 2_000, 1_024);
      const job = await makeQueuedJob(prefix, {
        workloadType: WorkloadType.SORTING,
        workloadSize: 120_000,
        cpuRequiredMillicores: 800,
        memoryRequiredMiB: 256,
        estimatedDurationSeconds: 5,
      });

      // The real execution service, so this exercises Docker for real, with
      // candidate discovery still scoped to this test's own jobs.
      const service = serviceFor(prefix, executionService);

      const step = await service.runNext({
        policy: SchedulingPolicy.FCFS,
        strategy: PlacementStrategy.LEAST_LOADED,
        maxJobs: 1,
      });

      assert.equal(step.stoppedBecause, null, step.stages.map((s) => s.detail).join(" | "));
      assert.ok(step.execution, "a container was started");
      assert.match(step.execution.containerId, /^[0-9a-f]{64}$/);

      await executionService.awaitPendingSettlements();

      const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(finished.status, JobStatus.COMPLETED, finished.failureReason ?? "");
      assert.ok(finished.completedAt);

      const released = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(released.cpuAllocatedMillicores, 0, "capacity came back");
      assert.equal(released.memoryAllocatedMiB, 0);
      assert.equal(released.status, WorkerStatus.IDLE);

      const allocation = await prisma.resourceAllocation.findFirstOrThrow({
        where: { jobId: job.id },
      });
      assert.equal(allocation.status, AllocationStatus.RELEASED);

      // The dashboard's snapshot should now show it as completed.
      const state = await service.state({ limit: 200 });
      const view = state.jobs.find((entry) => entry.id === job.id);
      assert.equal(view?.stage, "COMPLETED");
      assert.equal(view?.execution?.status, ExecutionStatus.COMPLETED);
      assert.equal(view?.execution?.exitCode, 0);
      assert.ok(view?.reservation === null, "a completed job holds no reservation");
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);
