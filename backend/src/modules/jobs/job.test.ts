import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  JobStatus,
  WorkloadType,
  type Job,
  type Prisma,
} from "@prisma/client";

import { AppError } from "../../errors/app-error.js";
import type { JobRepository } from "./job.repository.js";
import { createJobSchema } from "./job.schemas.js";
import { JobService } from "./job.service.js";
import { canTransitionJob } from "./job.transitions.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date();

  return {
    id: randomUUID(),
    name: "test-job",
    workloadType: WorkloadType.SORTING,
    status: JobStatus.QUEUED,
    cpuRequiredMillicores: 500,
    memoryRequiredMiB: 256,
    estimatedDurationSeconds: 10,
    priority: 5,
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

class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, Job>();

  insert(job: Job): void {
    this.jobs.set(job.id, job);
  }

  async create(data: Prisma.JobUncheckedCreateInput): Promise<Job> {
    const job = makeJob({
      name: data.name,
      workloadType: data.workloadType,
      status: data.status ?? JobStatus.QUEUED,
      cpuRequiredMillicores: data.cpuRequiredMillicores,
      memoryRequiredMiB: data.memoryRequiredMiB,
      estimatedDurationSeconds: data.estimatedDurationSeconds,
      priority: data.priority ?? 5,
    });
    this.insert(job);
    return job;
  }

  async findAll(status: JobStatus | undefined, limit: number): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, limit);
  }

  async findById(id: string): Promise<Job | null> {
    return this.jobs.get(id) ?? null;
  }

  async cancelQueued(id: string, cancelledAt: Date): Promise<boolean> {
    const job = this.jobs.get(id);

    if (!job || job.status !== JobStatus.QUEUED) {
      return false;
    }

    this.jobs.set(id, {
      ...job,
      status: JobStatus.CANCELLED,
      cancelledAt,
      updatedAt: cancelledAt,
    });
    return true;
  }
}

const validJobInput = {
  name: "sorting-1",
  workloadType: WorkloadType.SORTING,
  cpuRequiredMillicores: 1_000,
  memoryRequiredMiB: 512,
  estimatedDurationSeconds: 20,
  priority: 7,
} as const;

test("job schema accepts controlled input and rejects unsafe or unknown fields", () => {
  assert.equal(createJobSchema.safeParse(validJobInput).success, true);
  assert.equal(
    createJobSchema.safeParse({ ...validJobInput, command: "rm -rf /" }).success,
    false,
  );
  assert.equal(
    createJobSchema.safeParse({ ...validJobInput, status: JobStatus.RUNNING }).success,
    false,
  );
  assert.equal(
    createJobSchema.safeParse({ ...validJobInput, cpuRequiredMillicores: 0 }).success,
    false,
  );
});

test("job transition policy permits required paths and rejects invalid terminal transitions", () => {
  assert.equal(canTransitionJob(JobStatus.CREATED, JobStatus.QUEUED), true);
  assert.equal(canTransitionJob(JobStatus.QUEUED, JobStatus.SCHEDULED), true);
  assert.equal(canTransitionJob(JobStatus.WAITING, JobStatus.QUEUED), true);
  assert.equal(canTransitionJob(JobStatus.SCHEDULED, JobStatus.RUNNING), true);
  assert.equal(canTransitionJob(JobStatus.RUNNING, JobStatus.COMPLETED), true);
  assert.equal(canTransitionJob(JobStatus.RUNNING, JobStatus.INTERRUPTED), true);
  assert.equal(canTransitionJob(JobStatus.INTERRUPTED, JobStatus.QUEUED), true);
  assert.equal(canTransitionJob(JobStatus.QUEUED, JobStatus.RUNNING), false);

  for (const terminal of [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]) {
    for (const target of Object.values(JobStatus)) {
      assert.equal(canTransitionJob(terminal, target), false, `${terminal} -> ${target}`);
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
  assert.deepEqual(listed.map((job) => job.id), [created.id]);
});

test("queued job cancellation is atomic and idempotent", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository);
  const job = await service.create(validJobInput);

  const [first, second] = await Promise.all([service.cancel(job.id), service.cancel(job.id)]);

  assert.equal(first.status, JobStatus.CANCELLED);
  assert.equal(second.status, JobStatus.CANCELLED);
  assert.ok(first.cancelledAt);
  assert.equal(second.cancelledAt?.toISOString(), first.cancelledAt.toISOString());
});

test("cancellation rejects missing and non-cancellable jobs", async () => {
  const repository = new InMemoryJobRepository();
  const service = new JobService(repository);
  const running = makeJob({ status: JobStatus.RUNNING });
  repository.insert(running);

  await assert.rejects(
    () => service.cancel(randomUUID()),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
  await assert.rejects(
    () => service.cancel(running.id),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === "JOB_NOT_CANCELLABLE",
  );
});
