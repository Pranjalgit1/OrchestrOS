import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { JobStatus, WorkloadType } from "@prisma/client";
import { AppError } from "../src/errors/app-error.js";
import { createJobSchema } from "../src/modules/jobs/job.schemas.js";
import { JobService } from "../src/modules/jobs/job.service.js";
import { canTransitionJob } from "../src/modules/jobs/job.transitions.js";
function makeJob(overrides = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    name: "test-job",
    workloadType: WorkloadType.SORTING,
    workloadSize: 10_000,
    status: JobStatus.QUEUED,
    cpuRequiredMillicores: 500,
    memoryRequiredMiB: 256,
    estimatedDurationSeconds: 10,
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
class InMemoryJobRepository {
  jobs = new Map();
  insert(job) {
    this.jobs.set(job.id, job);
  }
  async create(data) {
    const job = makeJob({
      name: data.name,
      workloadType: data.workloadType,
      workloadSize: data.workloadSize ?? 1,
      status: data.status ?? JobStatus.QUEUED,
      cpuRequiredMillicores: data.cpuRequiredMillicores,
      memoryRequiredMiB: data.memoryRequiredMiB,
      estimatedDurationSeconds: data.estimatedDurationSeconds,
      priority: data.priority ?? 5,
    });
    this.insert(job);
    return job;
  }
  async findAll(status, limit) {
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort(
        (left, right) =>
          left.arrivalAt.getTime() - right.arrivalAt.getTime() ||
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
  }
  async findById(id) {
    return this.jobs.get(id) ?? null;
  }
  /** Job ids whose execution is still live, as the execution table would say. */
  openExecutions = new Set();
  async cancelIdle(id, cancelledAt, reason) {
    const job = this.jobs.get(id);
    if (!job) return { status: "JOB_NOT_FOUND" };
    if (job.status === JobStatus.CANCELLED) {
      return { status: "ALREADY_CANCELLED", job };
    }
    if ([JobStatus.COMPLETED, JobStatus.FAILED].includes(job.status)) {
      return { status: "NOT_CANCELLABLE", job };
    }
    if (this.openExecutions.has(id)) return { status: "HAS_OPEN_EXECUTION", job };
    const cancelled = { ...job, status: JobStatus.CANCELLED, cancelledAt,
      completedAt: cancelledAt, failureReason: reason, updatedAt: cancelledAt };
    this.jobs.set(id, cancelled);
    return { status: "CANCELLED", job: cancelled, released: false };
  }
  async requeue(id) {
    const job = this.jobs.get(id);
    if (!job) return { status: "JOB_NOT_FOUND" };
    if (![JobStatus.FAILED, JobStatus.INTERRUPTED].includes(job.status)) {
      return { status: "NOT_REQUEUEABLE", job };
    }
    const requeued = { ...job, status: JobStatus.QUEUED, assignedWorkerId: null,
      retryCount: (job.retryCount ?? 0) + 1 };
    this.jobs.set(id, requeued);
    return { status: "REQUEUED", job: requeued };
  }
}
/** Stands in for the execution service: stopping a container ends the run. */
class StubExecutions {
  cancelled = [];
  constructor(repository, outcome = JobStatus.CANCELLED) {
    this.repository = repository;
    this.outcome = outcome;
  }
  async cancel(jobId) {
    this.cancelled.push(jobId);
    this.repository.openExecutions.delete(jobId);
    const job = { ...this.repository.jobs.get(jobId), status: this.outcome };
    this.repository.jobs.set(jobId, job);
    return { cancelled: this.outcome === JobStatus.CANCELLED, job };
  }
}
const validJobInput = {
  name: "sorting-1",
  workloadType: WorkloadType.SORTING,
  workloadSize: 25_000,
  cpuRequiredMillicores: 1_000,
  memoryRequiredMiB: 512,
  estimatedDurationSeconds: 20,
  priority: 7,
};
test("job schema accepts controlled input and rejects unsafe or unknown fields", () => {
  assert.equal(createJobSchema.safeParse(validJobInput).success, true);
  assert.equal(
    createJobSchema.safeParse({ ...validJobInput, command: "rm -rf /" })
      .success,
    false,
  );
  assert.equal(
    createJobSchema.safeParse({ ...validJobInput, status: JobStatus.RUNNING })
      .success,
    false,
  );
  assert.equal(
    createJobSchema.safeParse({ ...validJobInput, cpuRequiredMillicores: 0 })
      .success,
    false,
  );
});
test("job transition policy permits required paths and rejects invalid terminal transitions", () => {
  assert.equal(canTransitionJob(JobStatus.CREATED, JobStatus.QUEUED), true);
  assert.equal(canTransitionJob(JobStatus.QUEUED, JobStatus.SCHEDULED), true);
  assert.equal(canTransitionJob(JobStatus.WAITING, JobStatus.QUEUED), true);
  assert.equal(canTransitionJob(JobStatus.SCHEDULED, JobStatus.RUNNING), true);
  assert.equal(canTransitionJob(JobStatus.RUNNING, JobStatus.COMPLETED), true);
  assert.equal(
    canTransitionJob(JobStatus.RUNNING, JobStatus.INTERRUPTED),
    true,
  );
  assert.equal(canTransitionJob(JobStatus.INTERRUPTED, JobStatus.QUEUED), true);
  assert.equal(canTransitionJob(JobStatus.QUEUED, JobStatus.RUNNING), false);
  assert.equal(
    canTransitionJob(JobStatus.RUNNING, JobStatus.QUEUED),
    true,
    "preemption and automatic retry return a running job to the queue",
  );
  assert.equal(
    canTransitionJob(JobStatus.FAILED, JobStatus.QUEUED),
    true,
    "an operator can requeue a failed job",
  );
  for (const target of Object.values(JobStatus)) {
    if (target === JobStatus.QUEUED) continue;
    assert.equal(canTransitionJob(JobStatus.FAILED, target), false, `FAILED -> ${target}`);
  }
  for (const terminal of [
    JobStatus.COMPLETED,
    JobStatus.CANCELLED,
  ]) {
    for (const target of Object.values(JobStatus)) {
      assert.equal(
        canTransitionJob(terminal, target),
        false,
        `${terminal} -> ${target}`,
      );
    }
  }
});
test("job service creates queued jobs and lists deterministically", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository);
  const created = await service.create(validJobInput);
  assert.equal(created.status, JobStatus.QUEUED);
  assert.equal(created.name, validJobInput.name);
  assert.equal(created.assignedWorkerId, null);
  const listed = await service.list({ limit: 50 });
  assert.deepEqual(
    listed.map((job) => job.id),
    [created.id],
  );
});
test("queued job cancellation is atomic and idempotent", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository);
  const job = await service.create(validJobInput);
  const [first, second] = await Promise.all([
    service.cancel(job.id),
    service.cancel(job.id),
  ]);
  assert.equal(first.status, JobStatus.CANCELLED);
  assert.equal(second.status, JobStatus.CANCELLED);
  assert.ok(first.cancelledAt);
  assert.equal(
    second.cancelledAt?.toISOString(),
    first.cancelledAt.toISOString(),
  );
});
test("cancellation rejects missing and already finished jobs", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository, new StubExecutions(repository));
  const completed = makeJob({ status: JobStatus.COMPLETED });
  repository.insert(completed);
  await assert.rejects(
    () => service.cancel(randomUUID()),
    (error) => error instanceof AppError && error.statusCode === 404,
  );
  await assert.rejects(
    () => service.cancel(completed.id),
    (error) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === "JOB_NOT_CANCELLABLE",
  );
});
test("a scheduled job is cancelled without touching the runtime", async () => {
  const repository = new InMemoryJobRepository();
  const executions = new StubExecutions(repository);
  const service = new JobService(repository, executions);
  const scheduled = makeJob({ status: JobStatus.SCHEDULED, assignedWorkerId: randomUUID() });
  repository.insert(scheduled);
  const cancelled = await service.cancel(scheduled.id);
  assert.equal(cancelled.status, JobStatus.CANCELLED);
  assert.match(cancelled.failureReason, /operator/);
  assert.deepEqual(executions.cancelled, []);
});
test("a running job has its container stopped before it is reported cancelled", async () => {
  const repository = new InMemoryJobRepository();
  const executions = new StubExecutions(repository);
  const service = new JobService(repository, executions);
  const running = makeJob({ status: JobStatus.RUNNING });
  repository.insert(running);
  repository.openExecutions.add(running.id);
  const cancelled = await service.cancel(running.id);
  assert.equal(cancelled.status, JobStatus.CANCELLED);
  assert.deepEqual(executions.cancelled, [running.id]);
});
test("a run that completes before it can be stopped is not reported as cancelled", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository, new StubExecutions(repository, JobStatus.COMPLETED));
  const running = makeJob({ status: JobStatus.RUNNING });
  repository.insert(running);
  repository.openExecutions.add(running.id);
  await assert.rejects(
    () => service.cancel(running.id),
    (error) => error instanceof AppError && error.code === "JOB_NOT_CANCELLABLE",
  );
  assert.equal(repository.jobs.get(running.id).status, JobStatus.COMPLETED);
});
test("only failed or interrupted jobs can be requeued", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository, new StubExecutions(repository));
  const failed = makeJob({ status: JobStatus.FAILED, retryCount: 0 });
  const interrupted = makeJob({ status: JobStatus.INTERRUPTED, retryCount: 1 });
  const completed = makeJob({ status: JobStatus.COMPLETED });
  for (const job of [failed, interrupted, completed]) repository.insert(job);
  const requeued = await service.requeue(failed.id);
  assert.equal(requeued.status, JobStatus.QUEUED);
  assert.equal(requeued.retryCount, 1);
  assert.equal((await service.requeue(interrupted.id)).retryCount, 2);
  await assert.rejects(
    () => service.requeue(completed.id),
    (error) => error instanceof AppError && error.code === "JOB_NOT_REQUEUEABLE",
  );
  await assert.rejects(
    () => service.requeue(randomUUID()),
    (error) => error instanceof AppError && error.statusCode === 404,
  );
});
