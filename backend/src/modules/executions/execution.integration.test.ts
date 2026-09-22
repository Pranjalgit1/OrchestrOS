import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  WorkerStatus,
  WorkloadType,
  type Job,
  type Worker,
} from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { prismaResourceRepository } from "../resources/resource.repository.js";
import { WORKLOAD_IMAGE, parseRunnerResult } from "./execution.contract.js";
import { prismaExecutionRepository } from "./execution.repository.js";
import { DockerContainerRuntime } from "./execution.runtime.js";
import { ExecutionService } from "./execution.service.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
const dockerTestsEnabled =
  process.env.RUN_DATABASE_TESTS === "true" && process.env.RUN_DOCKER_TESTS === "true";

interface Fixture {
  worker: Worker;
  job: Job;
}

/** Creates a worker plus a job that is scheduled, placed, and already reserved. */
async function reservedFixture(
  prefix: string,
  overrides: {
    workloadType?: WorkloadType;
    workloadSize?: number;
    cpuMillicores?: number;
    memoryMiB?: number;
    estimatedDurationSeconds?: number;
  } = {},
): Promise<Fixture> {
  const cpuMillicores = overrides.cpuMillicores ?? 1_000;
  const memoryMiB = overrides.memoryMiB ?? 512;

  const worker = await prisma.worker.create({
    data: {
      name: `${prefix}-worker`,
      cpuCapacityMillicores: cpuMillicores * 2,
      memoryCapacityMiB: memoryMiB * 2,
      status: WorkerStatus.IDLE,
    },
  });

  const job = await prisma.job.create({
    data: {
      name: `${prefix}-job`,
      workloadType: overrides.workloadType ?? WorkloadType.SORTING,
      workloadSize: overrides.workloadSize ?? 50_000,
      status: JobStatus.SCHEDULED,
      cpuRequiredMillicores: cpuMillicores,
      memoryRequiredMiB: memoryMiB,
      estimatedDurationSeconds: overrides.estimatedDurationSeconds ?? 10,
      priority: 5,
      assignedWorkerId: worker.id,
      placementStrategy: "FIRST_FIT",
      placedAt: new Date(),
      schedulingPolicy: "FCFS",
      scheduledAt: new Date(),
    },
  });

  const reservation = await prismaResourceRepository.reserve({
    jobId: job.id,
    workerId: worker.id,
    cpuMillicores,
    memoryMiB,
  });
  assert.equal(reservation.status, "RESERVED", "the fixture must hold a live reservation");

  return { worker, job };
}

async function cleanup(prefix: string): Promise<void> {
  await prisma.jobExecution.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
  await prisma.resourceAllocation.deleteMany({
    where: { job: { name: { startsWith: prefix } } },
  });
  await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
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

test(
  "claiming an execution is exclusive and requires a live reservation",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `exec-claim-${randomUUID()}`;

    try {
      const { job, worker } = await reservedFixture(prefix);

      // Two concurrent starts race for the same job.
      const outcomes = await Promise.all([
        prismaExecutionRepository.claim({ jobId: job.id }),
        prismaExecutionRepository.claim({ jobId: job.id }),
      ]);

      assert.equal(
        outcomes.filter((outcome) => outcome.status === "CLAIMED").length,
        1,
        "only one caller may launch a container",
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "EXECUTION_ALREADY_CLAIMED").length,
        1,
        "the loser is told the job was already claimed, regardless of interleaving",
      );
      assert.equal(
        await prisma.jobExecution.count({ where: { jobId: job.id } }),
        1,
        "a lost claim leaves no execution row behind",
      );

      const running = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(running.status, JobStatus.RUNNING, "the claim is the RUNNING transition");
      assert.ok(running.startedAt, "claiming records when the job started");

      const reservation = await prisma.resourceAllocation.findFirstOrThrow({
        where: { jobId: job.id, status: AllocationStatus.RESERVED },
      });
      const execution = await prisma.jobExecution.findFirstOrThrow({ where: { jobId: job.id } });
      assert.equal(execution.attempt, 1);
      assert.equal(execution.status, ExecutionStatus.PENDING);
      assert.equal(execution.workerId, worker.id);
      assert.equal(
        execution.allocationId,
        reservation.id,
        "the execution is bound to the reservation it consumes",
      );

      // A placed job with no reservation cannot execute.
      const unreserved = await prisma.job.create({
        data: {
          name: `${prefix}-unreserved`,
          workloadType: WorkloadType.SLEEP,
          workloadSize: 1,
          status: JobStatus.SCHEDULED,
          cpuRequiredMillicores: 100,
          memoryRequiredMiB: 64,
          estimatedDurationSeconds: 1,
          priority: 5,
          assignedWorkerId: worker.id,
          placementStrategy: "FIRST_FIT",
          placedAt: new Date(),
        },
      });
      assert.equal(
        (await prismaExecutionRepository.claim({ jobId: unreserved.id })).status,
        "NO_RESERVATION",
      );
      assert.equal(
        (await prisma.job.findUniqueOrThrow({ where: { id: unreserved.id } })).status,
        JobStatus.SCHEDULED,
        "a refused claim leaves the job untouched",
      );

      // A queued job cannot execute either.
      const queued = await prisma.job.create({
        data: {
          name: `${prefix}-queued`,
          workloadType: WorkloadType.SLEEP,
          workloadSize: 1,
          status: JobStatus.QUEUED,
          cpuRequiredMillicores: 100,
          memoryRequiredMiB: 64,
          estimatedDurationSeconds: 1,
          priority: 5,
        },
      });
      assert.equal(
        (await prismaExecutionRepository.claim({ jobId: queued.id })).status,
        "JOB_NOT_RUNNABLE",
      );
      assert.equal(
        (await prismaExecutionRepository.claim({ jobId: randomUUID() })).status,
        "JOB_NOT_FOUND",
      );

      // A job left RUNNING with no live execution is an orphan from an
      // interrupted process, not a job someone else is currently running.
      const orphan = await prisma.job.create({
        data: {
          name: `${prefix}-orphan`,
          workloadType: WorkloadType.SLEEP,
          workloadSize: 1,
          status: JobStatus.RUNNING,
          cpuRequiredMillicores: 100,
          memoryRequiredMiB: 64,
          estimatedDurationSeconds: 1,
          priority: 5,
          assignedWorkerId: worker.id,
          placementStrategy: "FIRST_FIT",
          placedAt: new Date(),
          startedAt: new Date(),
        },
      });
      const orphanClaim = await prismaExecutionRepository.claim({ jobId: orphan.id });
      assert.equal(orphanClaim.status, "JOB_NOT_RUNNABLE");
      assert.equal(
        orphanClaim.status === "JOB_NOT_RUNNABLE" ? orphanClaim.jobStatus : null,
        JobStatus.RUNNING,
      );
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "finalizing an execution records the outcome and releases capacity in one transaction",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `exec-finalize-${randomUUID()}`;

    try {
      const { job, worker } = await reservedFixture(prefix, {
        cpuMillicores: 1_200,
        memoryMiB: 640,
      });

      const busy = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(busy.cpuAllocatedMillicores, 1_200);
      assert.equal(busy.status, WorkerStatus.BUSY);

      const claim = await prismaExecutionRepository.claim({ jobId: job.id });
      assert.ok(claim.status === "CLAIMED");
      const executionId = claim.claimed.execution.id;

      const containerId = "d".repeat(64);
      const started = await prismaExecutionRepository.markStarted(executionId, containerId);
      assert.equal(started.status, ExecutionStatus.RUNNING);
      assert.equal(started.containerId, containerId);
      assert.equal(
        (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).containerId,
        containerId,
        "the job mirrors its container id",
      );

      const finalized = await prismaExecutionRepository.finalize({
        executionId,
        executionStatus: ExecutionStatus.COMPLETED,
        exitCode: 0,
        stdout: '{"runner":"v1"}',
        stderr: null,
        failureReason: null,
        result: { runner: "v1", checksum: "abcdef01", operations: 50_000 },
        completedAt: new Date(),
      });

      assert.ok(finalized.status === "FINALIZED");
      assert.equal(finalized.released, true, "capacity is returned by the same transaction");
      assert.equal(finalized.job.status, JobStatus.COMPLETED);

      const releasedWorker = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(releasedWorker.cpuAllocatedMillicores, 0, "a finished job holds nothing");
      assert.equal(releasedWorker.memoryAllocatedMiB, 0);
      assert.equal(releasedWorker.status, WorkerStatus.IDLE);

      const allocation = await prisma.resourceAllocation.findFirstOrThrow({
        where: { jobId: job.id },
      });
      assert.equal(allocation.status, AllocationStatus.RELEASED);
      assert.ok(allocation.releasedAt);

      const storedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(
        (storedJob.result as { checksum?: string } | null)?.checksum,
        "abcdef01",
        "the runner result is persisted on the job",
      );
      assert.ok(storedJob.completedAt);

      // Finalizing again must not release a second time.
      const repeat = await prismaExecutionRepository.finalize({
        executionId,
        executionStatus: ExecutionStatus.FAILED,
        exitCode: 1,
        stdout: null,
        stderr: "late",
        failureReason: "should be ignored",
        result: null,
        completedAt: new Date(),
      });
      assert.equal(repeat.status, "ALREADY_FINALIZED");

      const afterRepeat = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(afterRepeat.cpuAllocatedMillicores, 0, "no double release");
      const unchanged = await prisma.jobExecution.findUniqueOrThrow({
        where: { id: executionId },
      });
      assert.equal(unchanged.status, ExecutionStatus.COMPLETED, "a recorded outcome is immutable");
      assert.equal(unchanged.exitCode, 0);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "a failed execution releases capacity just like a successful one",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `exec-failure-${randomUUID()}`;

    try {
      const { job, worker } = await reservedFixture(prefix, { memoryMiB: 256 });
      const claim = await prismaExecutionRepository.claim({ jobId: job.id });
      assert.ok(claim.status === "CLAIMED");

      const finalized = await prismaExecutionRepository.finalize({
        executionId: claim.claimed.execution.id,
        executionStatus: ExecutionStatus.FAILED,
        exitCode: 137,
        stdout: null,
        stderr: "killed",
        failureReason: "container exceeded its memory reservation",
        result: null,
        completedAt: new Date(),
      });

      assert.ok(finalized.status === "FINALIZED");
      assert.equal(finalized.job.status, JobStatus.FAILED);
      assert.equal(finalized.released, true, "a failure must not strand capacity");

      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0);
      assert.equal(freed.status, WorkerStatus.IDLE);
      assert.match(
        (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).failureReason ?? "",
        /memory reservation/,
      );

      // An orchestrator timeout is recorded as an interruption instead.
      const second = await reservedFixture(`${prefix}-b`, { memoryMiB: 256 });
      const secondClaim = await prismaExecutionRepository.claim({ jobId: second.job.id });
      assert.ok(secondClaim.status === "CLAIMED");
      const interrupted = await prismaExecutionRepository.finalize({
        executionId: secondClaim.claimed.execution.id,
        executionStatus: ExecutionStatus.INTERRUPTED,
        exitCode: 137,
        stdout: null,
        stderr: null,
        failureReason: "execution exceeded the 120s limit and the container was stopped",
        result: null,
        completedAt: new Date(),
      });
      assert.ok(interrupted.status === "FINALIZED");
      assert.equal(
        interrupted.job.status,
        JobStatus.INTERRUPTED,
        "an interrupted job stays eligible for a later requeue",
      );
      assert.equal(interrupted.released, true);
    } finally {
      await cleanup(`${prefix}-b`);
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "the database rejects execution records that violate the phase invariants",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `exec-constraints-${randomUUID()}`;

    try {
      const { job } = await reservedFixture(prefix);
      const claim = await prismaExecutionRepository.claim({ jobId: job.id });
      assert.ok(claim.status === "CLAIMED");
      const executionId = claim.claimed.execution.id;

      await assert.rejects(
        () =>
          prisma.jobExecution.update({
            where: { id: executionId },
            data: { stdout: "x".repeat(16_385) },
          }),
        "captured output is bounded by a CHECK constraint",
      );

      await assert.rejects(
        () =>
          prisma.jobExecution.update({
            where: { id: executionId },
            data: { exitCode: 999 },
          }),
        "an exit code outside a byte is rejected",
      );

      await assert.rejects(
        () =>
          prisma.jobExecution.update({
            where: { id: executionId },
            data: { containerId: "not-a-container-id", startedAt: new Date() },
          }),
        "container ids must look like daemon digests",
      );

      await assert.rejects(
        () =>
          prisma.jobExecution.update({
            where: { id: executionId },
            data: { status: ExecutionStatus.COMPLETED },
          }),
        "a terminal execution must record when it completed",
      );

      await assert.rejects(
        () =>
          prisma.jobExecution.update({
            where: { id: executionId },
            data: { containerId: "e".repeat(64) },
          }),
        "an execution with a container must record when it started",
      );

      const untouched = await prisma.jobExecution.findUniqueOrThrow({
        where: { id: executionId },
      });
      assert.equal(untouched.status, ExecutionStatus.PENDING);
      assert.equal(untouched.containerId, null);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "execution routes report runtime state and refuse unexecutable jobs",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `exec-api-${randomUUID()}`;

    try {
      const queued = await prisma.job.create({
        data: {
          name: `${prefix}-queued`,
          workloadType: WorkloadType.SLEEP,
          workloadSize: 1,
          status: JobStatus.QUEUED,
          cpuRequiredMillicores: 100,
          memoryRequiredMiB: 64,
          estimatedDurationSeconds: 1,
          priority: 5,
        },
      });

      await withServer(async (baseUrl) => {
        const runtimeResponse = await fetch(`${baseUrl}/executions/runtime`);
        const runtime = (await runtimeResponse.json()) as {
          image?: string;
          imageAvailable?: boolean;
          error?: { code: string };
        };

        if (runtimeResponse.status === 200) {
          assert.equal(runtime.image, WORKLOAD_IMAGE, "only one image is ever reported");
        } else {
          assert.equal(runtimeResponse.status, 503, "an absent daemon is a dependency failure");
          assert.equal(runtime.error?.code, "DOCKER_UNAVAILABLE");
        }

        const listResponse = await fetch(`${baseUrl}/executions?limit=5`);
        assert.equal(listResponse.status, 200);
        assert.ok(Array.isArray(await listResponse.json()));

        const badLimit = await fetch(`${baseUrl}/executions?limit=0`);
        assert.equal(badLimit.status, 400);

        const missing = await fetch(`${baseUrl}/executions/${randomUUID()}`);
        assert.equal(missing.status, 404);

        const post = (path: string, body: unknown) =>
          fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });

        const rejected = await post("/executions/start", {
          jobId: queued.id,
          image: "alpine",
        });
        assert.equal(rejected.status, 400, "an image field is rejected before anything runs");

        // Without Docker this is a 503; with Docker it is a 409 for a queued job.
        const notExecutable = await post("/executions/start", { jobId: queued.id });
        const notExecutableBody = (await notExecutable.json()) as { error: { code: string } };
        assert.ok(
          [409, 503].includes(notExecutable.status),
          `unexpected status ${notExecutable.status}`,
        );
        if (notExecutable.status === 409) {
          assert.equal(notExecutableBody.error.code, "JOB_NOT_EXECUTABLE");
        }

        assert.equal(
          (await prisma.job.findUniqueOrThrow({ where: { id: queued.id } })).status,
          JobStatus.QUEUED,
          "a refused start never changes the job",
        );
      });
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "a real container runs the controlled workload and returns its resources",
  { skip: !dockerTestsEnabled },
  async () => {
    const prefix = `exec-docker-${randomUUID()}`;
    const runtime = new DockerContainerRuntime();

    try {
      const description = await runtime.describe();
      assert.equal(description.image, WORKLOAD_IMAGE);
      assert.ok(
        description.imageAvailable,
        `build ${WORKLOAD_IMAGE} with \`npm run docker:images\` before running docker tests`,
      );

      const { job, worker } = await reservedFixture(prefix, {
        workloadType: WorkloadType.SORTING,
        workloadSize: 100_000,
        cpuMillicores: 1_000,
        memoryMiB: 256,
      });

      // A dedicated service instance so this test owns its background settlement.
      const service = new ExecutionService(prismaExecutionRepository, runtime, 120);
      const started = await service.start(job.id);

      assert.equal(started.container.image, WORKLOAD_IMAGE);
      assert.match(started.container.id, /^[0-9a-f]{64}$/);
      assert.equal(started.container.cpuMillicores, 1_000, "the container is capped at the reservation");
      assert.equal(started.container.memoryMiB, 256);
      assert.equal(started.execution.status, ExecutionStatus.RUNNING);

      await service.awaitPendingSettlements();

      const execution = await prisma.jobExecution.findUniqueOrThrow({
        where: { id: started.execution.id },
      });
      assert.equal(execution.status, ExecutionStatus.COMPLETED, execution.failureReason ?? "");
      assert.equal(execution.exitCode, 0);
      assert.ok(execution.completedAt);

      const runnerResult = parseRunnerResult(execution.stdout ?? "");
      assert.ok(runnerResult, "the runner's result line is captured verbatim");
      assert.equal(runnerResult?.workloadType, WorkloadType.SORTING);
      assert.equal(runnerResult?.seed, started.container.seed);
      assert.match(runnerResult?.checksum ?? "", /^[0-9a-f]{8}$/);

      const finishedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(finishedJob.status, JobStatus.COMPLETED);
      assert.equal(
        (finishedJob.result as { checksum?: string } | null)?.checksum,
        runnerResult?.checksum,
        "the job records the checksum the container actually produced",
      );

      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0, "executing a job returns its capacity");
      assert.equal(freed.memoryAllocatedMiB, 0);
      assert.equal(freed.status, WorkerStatus.IDLE);
      assert.ok(
        freed.cpuAllocatedMillicores <= freed.cpuCapacityMillicores,
        "capacity accounting stays within bounds",
      );

      assert.equal(
        (
          await prisma.resourceAllocation.findFirstOrThrow({ where: { jobId: job.id } })
        ).status,
        AllocationStatus.RELEASED,
      );

      // The container is removed once its outcome is committed.
      await assert.rejects(
        () => runtime.collect(started.container.id),
        "a settled execution leaves no container behind",
      );

      // Settling again is safe and changes nothing.
      const resettled = await service.settle(started.execution.id);
      assert.equal(resettled.alreadySettled, true);
      assert.equal(resettled.released, false);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "a workload that exhausts its memory reservation is recorded as a failure",
  { skip: !dockerTestsEnabled },
  async () => {
    const prefix = `exec-oom-${randomUUID()}`;
    const runtime = new DockerContainerRuntime();

    try {
      // A large sort inside a tiny reservation: the runner scales itself to the
      // limit, so this proves the limit is real rather than that it crashes.
      const { job, worker } = await reservedFixture(prefix, {
        workloadType: WorkloadType.SORTING,
        workloadSize: 100_000_000,
        cpuMillicores: 1_000,
        memoryMiB: 128,
      });

      const service = new ExecutionService(prismaExecutionRepository, runtime, 120);
      const started = await service.start(job.id);
      await service.awaitPendingSettlements();

      const execution = await prisma.jobExecution.findUniqueOrThrow({
        where: { id: started.execution.id },
      });
      assert.ok(
        execution.status === ExecutionStatus.COMPLETED ||
          execution.status === ExecutionStatus.FAILED,
        "the run reaches a terminal state either way",
      );

      if (execution.status === ExecutionStatus.COMPLETED) {
        const result = parseRunnerResult(execution.stdout ?? "");
        assert.ok(
          (result?.effectiveSize ?? 0) < 100_000_000,
          "the runner must scale the workload down to fit its reservation",
        );
      } else {
        assert.match(execution.failureReason ?? "", /memory|exited with code/);
      }

      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0, "capacity is returned either way");
      assert.equal(freed.status, WorkerStatus.IDLE);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);
