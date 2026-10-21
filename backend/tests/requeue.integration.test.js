import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  WorkerStatus,
  WorkloadType,
} from "@prisma/client";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { prismaExecutionRepository } from "../src/modules/executions/execution.repository.js";
import { DockerContainerRuntime } from "../src/modules/executions/execution.runtime.js";
import { ExecutionService } from "../src/modules/executions/execution.service.js";
import { prismaJobRepository } from "../src/modules/jobs/job.repository.js";
import { JobService } from "../src/modules/jobs/job.service.js";
import { prismaResourceRepository } from "../src/modules/resources/resource.repository.js";
const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
const dockerTestsEnabled =
  databaseTestsEnabled && process.env.RUN_DOCKER_TESTS === "true";
async function makeWorker(prefix, cpu = 2_000, memory = 1_024) {
  return prisma.worker.create({
    data: {
      name: `${prefix}-worker`,
      cpuCapacityMillicores: cpu,
      memoryCapacityMiB: memory,
      status: WorkerStatus.IDLE,
    },
  });
}
/** Takes a queued job through scheduling, placement, and reservation. */
async function scheduleAndReserve(jobId, worker, { quantum = null } = {}) {
  const job = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.SCHEDULED,
      schedulingPolicy: quantum ? "ROUND_ROBIN" : "FCFS",
      scheduledAt: new Date(),
      timeQuantumSeconds: quantum,
      schedulingRounds: { increment: 1 },
      assignedWorkerId: worker.id,
      placementStrategy: "FIRST_FIT",
      placedAt: new Date(),
    },
  });
  const reserved = await prismaResourceRepository.reserve({
    jobId,
    workerId: worker.id,
    cpuMillicores: job.cpuRequiredMillicores,
    memoryMiB: job.memoryRequiredMiB,
  });
  assert.equal(reserved.status, "RESERVED");
  return job;
}
function createJob(prefix, suffix, overrides = {}) {
  return prisma.job.create({
    data: {
      name: `${prefix}-${suffix}`,
      workloadType: WorkloadType.SLEEP,
      workloadSize: 1,
      status: JobStatus.QUEUED,
      cpuRequiredMillicores: 500,
      memoryRequiredMiB: 128,
      estimatedDurationSeconds: 5,
      priority: 5,
      ...overrides,
    },
  });
}
function finalizeRequest(executionId, overrides = {}) {
  return {
    executionId,
    executionStatus: ExecutionStatus.FAILED,
    exitCode: null,
    stdout: null,
    stderr: null,
    failureReason: "container could not be started: daemon hiccup",
    result: null,
    completedAt: new Date(),
    ...overrides,
  };
}
async function cleanup(prefix) {
  await prisma.jobExecution.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
  await prisma.resourceAllocation.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
}
async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
test("a preempted execution returns its job to the queue and frees capacity atomically",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `rq-preempt-${randomUUID()}`;
    try {
      const worker = await makeWorker(prefix);
      const created = await createJob(prefix, "job");
      await scheduleAndReserve(created.id, worker, { quantum: 5 });
      const claim = await prismaExecutionRepository.claim({ jobId: created.id });
      assert.equal(claim.status, "CLAIMED");
      const first = claim.claimed.execution;
      await prismaExecutionRepository.markStarted(first.id, "a".repeat(64));
      const finalized = await prismaExecutionRepository.finalize(finalizeRequest(first.id, {
        executionStatus: ExecutionStatus.PREEMPTED,
        exitCode: 137,
        failureReason: "Round Robin quantum of 5s expired",
      }));
      assert.equal(finalized.status, "FINALIZED");
      assert.equal(finalized.requeued, true);
      assert.equal(finalized.released, true);
      const job = await prisma.job.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(job.status, JobStatus.QUEUED);
      assert.equal(job.preemptionCount, 1);
      assert.equal(job.retryCount, 0);
      assert.equal(job.schedulingRounds, 1, "the round count survives so Round Robin rotates");
      for (const field of ["assignedWorkerId", "placementStrategy", "placedAt",
        "schedulingPolicy", "scheduledAt", "timeQuantumSeconds", "containerId", "completedAt"]) {
        assert.equal(job[field], null, `${field} is cleared for the next attempt`);
      }
      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0);
      assert.equal(freed.status, WorkerStatus.IDLE);
      const stored = await prisma.jobExecution.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(stored.status, ExecutionStatus.PREEMPTED);
      assert.ok(stored.completedAt);
      // The next attempt gets a new reservation and execution row.
      await scheduleAndReserve(created.id, worker, { quantum: 5 });
      const second = await prismaExecutionRepository.claim({ jobId: created.id });
      assert.equal(second.status, "CLAIMED");
      assert.equal(second.claimed.execution.attempt, 2);
      assert.notEqual(second.claimed.execution.allocationId, first.allocationId);
      assert.equal(await prisma.resourceAllocation.count({
        where: { jobId: created.id, status: AllocationStatus.RESERVED } }), 1);
      // The database enforces completion timestamps for the new terminal status.
      await assert.rejects(() => prisma.jobExecution.update({
        where: { id: second.claimed.execution.id },
        data: { status: ExecutionStatus.PREEMPTED },
      }));
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("automatic retries stop at the retry budget and the last failure is final",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `rq-retry-${randomUUID()}`;
    try {
      const worker = await makeWorker(prefix);
      const created = await createJob(prefix, "job");
      const outcomes = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await scheduleAndReserve(created.id, worker);
        const claim = await prismaExecutionRepository.claim({ jobId: created.id });
        assert.equal(claim.status, "CLAIMED");
        outcomes.push(await prismaExecutionRepository.finalize(finalizeRequest(
          claim.claimed.execution.id, { requeue: "RETRY", maxRetries: 1 })));
      }
      assert.deepEqual(outcomes.map((outcome) => outcome.requeued), [true, false]);
      const job = await prisma.job.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(job.status, JobStatus.FAILED);
      assert.equal(job.retryCount, 1);
      assert.match(job.failureReason, /could not be started/);
      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0, "every attempt released its capacity");
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("a scheduled, reserved job is cancelled with its reservation released",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `rq-cancel-${randomUUID()}`;
    try {
      const worker = await makeWorker(prefix);
      const created = await createJob(prefix, "job");
      await scheduleAndReserve(created.id, worker);
      const service = new JobService(prismaJobRepository);
      const [first, second] = await Promise.all([
        service.cancel(created.id), service.cancel(created.id)]);
      assert.equal(first.status, JobStatus.CANCELLED);
      assert.equal(second.status, JobStatus.CANCELLED);
      assert.ok(first.cancelledAt);
      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0);
      assert.equal(freed.memoryAllocatedMiB, 0);
      assert.equal(await prisma.resourceAllocation.count({
        where: { jobId: created.id, status: AllocationStatus.RESERVED } }), 0);
      // A job with a live execution is handed to the runtime instead.
      const live = await createJob(prefix, "live");
      await scheduleAndReserve(live.id, worker);
      const claim = await prismaExecutionRepository.claim({ jobId: live.id });
      assert.equal(claim.status, "CLAIMED");
      const outcome = await prismaJobRepository.cancelIdle(live.id, new Date(), "test");
      assert.equal(outcome.status, "HAS_OPEN_EXECUTION");
      assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: live.id } })).status,
        JobStatus.RUNNING);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("failed and interrupted jobs can be requeued over HTTP; others are refused",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `rq-http-${randomUUID()}`;
    try {
      const worker = await makeWorker(prefix);
      const failed = await createJob(prefix, "failed", {
        status: JobStatus.FAILED, failureReason: "exit 70", completedAt: new Date(),
        schedulingPolicy: "FCFS", scheduledAt: new Date(), assignedWorkerId: worker.id,
        placementStrategy: "FIRST_FIT", placedAt: new Date(),
      });
      const completed = await createJob(prefix, "done", { status: JobStatus.COMPLETED });
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/jobs/${failed.id}/requeue`, { method: "POST" });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, JobStatus.QUEUED);
        assert.equal(body.retryCount, 1);
        assert.equal(body.assignedWorkerId, null);
        assert.equal(body.failureReason, null);
        const refused = await fetch(`${baseUrl}/jobs/${completed.id}/requeue`, { method: "POST" });
        assert.equal(refused.status, 409);
        assert.equal((await refused.json()).error.code, "JOB_NOT_REQUEUEABLE");
        const missing = await fetch(`${baseUrl}/jobs/${randomUUID()}/requeue`, { method: "POST" });
        assert.equal(missing.status, 404);
        const finished = await fetch(`${baseUrl}/jobs/${completed.id}/cancel`, { method: "POST" });
        assert.equal(finished.status, 409);
      });
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
async function startedService(prefix, quantum, { waiting = false } = {}) {
  const worker = await makeWorker(prefix);
  const created = await createJob(prefix, "sleeper", { workloadSize: 30, memoryRequiredMiB: 64,
    cpuRequiredMillicores: 100 });
  if (waiting) await createJob(prefix, "waiting");
  await scheduleAndReserve(created.id, worker, { quantum });
  const service = new ExecutionService(prismaExecutionRepository, new DockerContainerRuntime(),
    60, { maxPreemptions: 3, maxRetries: 0 });
  const started = await service.start(created.id);
  return { service, job: created, worker, started };
}
test("a real container is evicted when its quantum expires and another job waits",
  { skip: !dockerTestsEnabled, timeout: 60_000 }, async () => {
    const prefix = `rq-docker-rr-${randomUUID().slice(0, 8)}`;
    try {
      const { service, job, worker, started } = await startedService(prefix, 1, { waiting: true });
      await service.awaitPendingSettlements();
      const execution = await prisma.jobExecution.findUniqueOrThrow({
        where: { id: started.execution.id } });
      assert.equal(execution.status, ExecutionStatus.PREEMPTED);
      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(stored.status, JobStatus.QUEUED);
      assert.equal(stored.preemptionCount, 1);
      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0);
      const runtime = new DockerContainerRuntime();
      await assert.rejects(runtime.isRunning(started.container.id), { statusCode: 404 },
        "the evicted container is removed");
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("cancelling a real running job stops and removes its container",
  { skip: !dockerTestsEnabled, timeout: 60_000 }, async () => {
    const prefix = `rq-docker-cancel-${randomUUID().slice(0, 8)}`;
    try {
      const { service, job, worker, started } = await startedService(prefix, null);
      const jobs = new JobService(prismaJobRepository, service);
      const cancelled = await jobs.cancel(job.id);
      assert.equal(cancelled.status, JobStatus.CANCELLED);
      await service.awaitPendingSettlements();
      const execution = await prisma.jobExecution.findUniqueOrThrow({
        where: { id: started.execution.id } });
      assert.equal(execution.status, ExecutionStatus.CANCELLED);
      assert.equal(execution.failureReason, "Cancelled by operator");
      const freed = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(freed.cpuAllocatedMillicores, 0);
      await assert.rejects(new DockerContainerRuntime().isRunning(started.container.id),
        { statusCode: 404 });
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
