import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  JobStatus,
  SchedulingPolicy,
  WorkloadType,
  type Job,
} from "@prisma/client";

import {
  effectivePriority,
  isEligible,
  orderByPolicy,
  selectNextJob,
} from "./scheduler.policies.js";
import type { ScheduleClaim, SchedulerRepository } from "./scheduler.repository.js";
import { dispatchSchema, previewQuerySchema } from "./scheduler.schemas.js";
import { SchedulerService } from "./scheduler.service.js";

const now = new Date("2026-09-21T12:00:00.000Z");

function secondsBefore(seconds: number): Date {
  return new Date(now.getTime() - seconds * 1_000);
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const created = secondsBefore(600);

  return {
    id: randomUUID(),
    name: "scheduler-job",
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
    arrivalAt: secondsBefore(60),
    schedulingPolicy: null,
    scheduledAt: null,
    timeQuantumSeconds: null,
    schedulingRounds: 0,
    placementStrategy: null,
    placedAt: null,
    createdAt: created,
    updatedAt: created,
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

class InMemorySchedulerRepository implements SchedulerRepository {
  readonly claims: ScheduleClaim[] = [];
  lostClaimIds = new Set<string>();

  constructor(private readonly jobs: Job[]) {}

  async findEligible(currentTime: Date, limit: number): Promise<Job[]> {
    return this.jobs
      .filter((job) => job.status === JobStatus.QUEUED && job.arrivalAt <= currentTime)
      .slice(0, limit);
  }

  async claim(claim: ScheduleClaim): Promise<boolean> {
    if (this.lostClaimIds.has(claim.jobId)) {
      return false;
    }

    const index = this.jobs.findIndex(
      (job) => job.id === claim.jobId && job.status === JobStatus.QUEUED,
    );
    if (index === -1) {
      return false;
    }

    const existing = this.jobs[index];
    if (!existing) {
      return false;
    }

    this.claims.push(claim);
    this.jobs[index] = {
      ...existing,
      status: JobStatus.SCHEDULED,
      schedulingPolicy: claim.policy,
      scheduledAt: claim.scheduledAt,
      timeQuantumSeconds: claim.timeQuantumSeconds,
      schedulingRounds: existing.schedulingRounds + 1,
    };
    return true;
  }

  async findById(id: string): Promise<Job | null> {
    return this.jobs.find((job) => job.id === id) ?? null;
  }
}

test("only queued jobs whose planned arrival has passed are eligible", () => {
  assert.equal(isEligible(makeJob(), now), true);
  assert.equal(isEligible(makeJob({ arrivalAt: new Date(now.getTime() + 60_000) }), now), false);
  assert.equal(isEligible(makeJob({ status: JobStatus.SCHEDULED }), now), false);
  assert.equal(isEligible(makeJob({ status: JobStatus.CANCELLED }), now), false);
  assert.equal(isEligible(makeJob({ status: JobStatus.COMPLETED }), now), false);
});

test("FCFS runs jobs in planned arrival order", () => {
  const third = makeJob({ name: "third", arrivalAt: secondsBefore(10) });
  const first = makeJob({ name: "first", arrivalAt: secondsBefore(300) });
  const second = makeJob({ name: "second", arrivalAt: secondsBefore(120) });

  const ordered = orderByPolicy([third, first, second], SchedulingPolicy.FCFS, now);

  assert.deepEqual(ordered.map((job) => job.name), ["first", "second", "third"]);
  assert.equal(selectNextJob([third, first, second], SchedulingPolicy.FCFS, now)?.name, "first");
});

test("SJF prefers the shortest estimate and breaks ties by arrival", () => {
  const long = makeJob({ name: "long", estimatedDurationSeconds: 90 });
  const shortLate = makeJob({
    name: "short-late",
    estimatedDurationSeconds: 5,
    arrivalAt: secondsBefore(30),
  });
  const shortEarly = makeJob({
    name: "short-early",
    estimatedDurationSeconds: 5,
    arrivalAt: secondsBefore(200),
  });

  const ordered = orderByPolicy([long, shortLate, shortEarly], SchedulingPolicy.SJF, now);

  assert.deepEqual(ordered.map((job) => job.name), ["short-early", "short-late", "long"]);
});

test("priority prefers higher numbers and aging prevents starvation", () => {
  const urgent = makeJob({ name: "urgent", priority: 9, arrivalAt: secondsBefore(10) });
  const low = makeJob({ name: "low", priority: 3, arrivalAt: secondsBefore(30) });

  assert.deepEqual(
    orderByPolicy([low, urgent], SchedulingPolicy.PRIORITY, now).map((job) => job.name),
    ["urgent", "low"],
  );

  // After ten minutes of waiting the low-priority job ages past the newcomer.
  const starved = makeJob({ name: "starved", priority: 3, arrivalAt: secondsBefore(600) });
  assert.equal(effectivePriority(starved, now), 10);
  assert.equal(effectivePriority(urgent, now), 9);
  assert.deepEqual(
    orderByPolicy([urgent, starved], SchedulingPolicy.PRIORITY, now).map((job) => job.name),
    ["starved", "urgent"],
  );
});

test("round robin rotates jobs that already consumed a quantum to the back", () => {
  const rotated = makeJob({ name: "rotated", schedulingRounds: 1, arrivalAt: secondsBefore(300) });
  const fresh = makeJob({ name: "fresh", schedulingRounds: 0, arrivalAt: secondsBefore(60) });

  assert.deepEqual(
    orderByPolicy([rotated, fresh], SchedulingPolicy.ROUND_ROBIN, now).map((job) => job.name),
    ["fresh", "rotated"],
  );
});

test("dispatch records the scheduling decision and respects the requested count", async () => {
  const jobs = [
    makeJob({ name: "a", arrivalAt: secondsBefore(300) }),
    makeJob({ name: "b", arrivalAt: secondsBefore(200) }),
    makeJob({ name: "c", arrivalAt: secondsBefore(100) }),
  ];
  const repository = new InMemorySchedulerRepository(jobs);
  const service = new SchedulerService(repository, () => now);

  const result = await service.dispatch({ policy: SchedulingPolicy.FCFS, count: 2 });

  assert.equal(result.scheduledCount, 2);
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.timeQuantumSeconds, null);
  assert.deepEqual(result.scheduled.map((job) => job.name), ["a", "b"]);

  for (const job of result.scheduled) {
    assert.equal(job.status, JobStatus.SCHEDULED);
    assert.equal(job.schedulingPolicy, SchedulingPolicy.FCFS);
    assert.equal(job.scheduledAt?.toISOString(), now.toISOString());
    assert.equal(job.schedulingRounds, 1);
  }

  assert.equal(jobs[2]?.status, JobStatus.QUEUED);
});

test("round robin dispatch applies a default quantum and rejects it for other policies", async () => {
  const repository = new InMemorySchedulerRepository([makeJob()]);
  const service = new SchedulerService(repository, () => now);

  const result = await service.dispatch({ policy: SchedulingPolicy.ROUND_ROBIN, count: 1 });
  assert.equal(result.timeQuantumSeconds, 10);
  assert.equal(result.scheduled[0]?.timeQuantumSeconds, 10);

  assert.equal(
    dispatchSchema.safeParse({ policy: "ROUND_ROBIN", timeQuantumSeconds: 25 }).success,
    true,
  );
  assert.equal(dispatchSchema.safeParse({ policy: "FCFS", timeQuantumSeconds: 25 }).success, false);
  assert.equal(dispatchSchema.safeParse({ policy: "NOPE" }).success, false);
  assert.equal(dispatchSchema.safeParse({ policy: "FCFS", count: 0 }).success, false);
  assert.equal(dispatchSchema.safeParse({ policy: "SJF", status: "RUNNING" }).success, false);
  assert.equal(previewQuerySchema.safeParse({ policy: "PRIORITY", limit: "5" }).success, true);
});

test("dispatch skips jobs claimed concurrently and never overschedules", async () => {
  const contested = makeJob({ name: "contested", arrivalAt: secondsBefore(300) });
  const available = makeJob({ name: "available", arrivalAt: secondsBefore(200) });
  const repository = new InMemorySchedulerRepository([contested, available]);
  repository.lostClaimIds.add(contested.id);
  const service = new SchedulerService(repository, () => now);

  const result = await service.dispatch({ policy: SchedulingPolicy.FCFS, count: 2 });

  assert.equal(result.scheduledCount, 1);
  assert.deepEqual(result.scheduled.map((job) => job.name), ["available"]);
});

test("preview never changes job state and an empty queue schedules nothing", async () => {
  const pending = makeJob({ arrivalAt: new Date(now.getTime() + 60_000) });
  const repository = new InMemorySchedulerRepository([pending]);
  const service = new SchedulerService(repository, () => now);

  const preview = await service.preview({ policy: SchedulingPolicy.SJF, limit: 20 });
  assert.equal(preview.eligibleCount, 0);
  assert.equal(preview.jobs.length, 0);

  const result = await service.dispatch({ policy: SchedulingPolicy.SJF, count: 5 });
  assert.equal(result.scheduledCount, 0);
  assert.equal(repository.claims.length, 0);
  assert.equal(pending.status, JobStatus.QUEUED);
});
