import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  JobStatus,
  PlacementStrategy,
  WorkerStatus,
  WorkloadType,
  type Job,
  type Worker,
} from "@prisma/client";

import { AppError } from "../../errors/app-error.js";
import {
  buildSnapshot,
  evaluateEligibility,
  evaluatePlacement,
  scoreCandidate,
  type WorkerLoad,
} from "./placement.accounting.js";
import type {
  PlacementAssignment,
  PlacementRepository,
} from "./placement.repository.js";
import { assignPlacementSchema } from "./placement.schemas.js";
import { PlacementService } from "./placement.service.js";

const now = new Date("2026-09-21T12:00:00.000Z");
const noLoad: WorkerLoad = { cpuMillicores: 0, memoryMiB: 0 };

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    name: "worker-test",
    cpuCapacityMillicores: 4_000,
    memoryCapacityMiB: 4_096,
    cpuAllocatedMillicores: 0,
    memoryAllocatedMiB: 0,
    status: WorkerStatus.IDLE,
    lastHeartbeat: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    name: "placement-job",
    workloadType: WorkloadType.SORTING,
    workloadSize: 10_000,
    status: JobStatus.SCHEDULED,
    cpuRequiredMillicores: 1_000,
    memoryRequiredMiB: 512,
    estimatedDurationSeconds: 20,
    priority: 5,
    workloadBatchId: null,
    batchSequence: null,
    arrivalOffsetSeconds: 0,
    arrivalAt: now,
    schedulingPolicy: null,
    scheduledAt: now,
    timeQuantumSeconds: null,
    schedulingRounds: 1,
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

class InMemoryPlacementRepository implements PlacementRepository {
  readonly assignments: PlacementAssignment[] = [];
  failAssign = false;

  constructor(
    private readonly jobs: Job[],
    private readonly workers: Worker[],
    private readonly loads: Map<string, WorkerLoad> = new Map(),
  ) {}

  async findJobById(jobId: string): Promise<Job | null> {
    return this.jobs.find((job) => job.id === jobId) ?? null;
  }

  async listWorkers(): Promise<Worker[]> {
    return [...this.workers];
  }

  async assignedLoadByWorker(): Promise<Map<string, WorkerLoad>> {
    return this.loads;
  }

  async assign(assignment: PlacementAssignment): Promise<boolean> {
    if (this.failAssign) {
      return false;
    }

    const index = this.jobs.findIndex(
      (job) =>
        job.id === assignment.jobId &&
        job.status === JobStatus.SCHEDULED &&
        job.assignedWorkerId === null,
    );
    const existing = this.jobs[index];
    if (index === -1 || !existing) {
      return false;
    }

    this.assignments.push(assignment);
    this.jobs[index] = {
      ...existing,
      assignedWorkerId: assignment.workerId,
      placementStrategy: assignment.strategy,
      placedAt: assignment.placedAt,
    };
    return true;
  }
}

test("available capacity subtracts persisted reservations and advisory assignments", () => {
  const snapshot = buildSnapshot(
    makeWorker({ cpuAllocatedMillicores: 1_000, memoryAllocatedMiB: 1_024 }),
    { cpuMillicores: 500, memoryMiB: 512 },
  );

  assert.equal(snapshot.cpuReservedMillicores, 1_000);
  assert.equal(snapshot.cpuAssignedMillicores, 500);
  assert.equal(snapshot.cpuAvailableMillicores, 4_000 - 1_500);
  assert.equal(snapshot.memoryAvailableMiB, 4_096 - 1_536);
  assert.equal(snapshot.cpuUtilization, 1_500 / 4_000);
  assert.equal(snapshot.memoryUtilization, 1_536 / 4_096);
  assert.equal(snapshot.schedulable, true);
});

test("eligibility rejects insufficient CPU, insufficient memory, and unusable workers", () => {
  const job = makeJob({ cpuRequiredMillicores: 2_000, memoryRequiredMiB: 2_048 });

  const exactFit = evaluateEligibility(
    buildSnapshot(makeWorker({ cpuCapacityMillicores: 2_000, memoryCapacityMiB: 2_048 }), noLoad),
    job,
  );
  assert.equal(exactFit.eligible, true, "a worker that exactly fits must be eligible");

  const lowCpu = evaluateEligibility(
    buildSnapshot(makeWorker({ cpuCapacityMillicores: 1_999 }), noLoad),
    job,
  );
  assert.equal(lowCpu.eligible, false);
  assert.match(lowCpu.reasons.join(" "), /Insufficient CPU/);

  const lowMemory = evaluateEligibility(
    buildSnapshot(makeWorker({ memoryCapacityMiB: 2_047 }), noLoad),
    job,
  );
  assert.equal(lowMemory.eligible, false);
  assert.match(lowMemory.reasons.join(" "), /Insufficient memory/);

  for (const status of [WorkerStatus.FAILED, WorkerStatus.STOPPING, WorkerStatus.STARTING]) {
    const result = evaluateEligibility(buildSnapshot(makeWorker({ status }), noLoad), job);
    assert.equal(result.eligible, false, `${status} must not accept work`);
    assert.match(result.reasons.join(" "), /cannot accept work/);
  }

  for (const status of [WorkerStatus.IDLE, WorkerStatus.ACTIVE, WorkerStatus.BUSY]) {
    const result = evaluateEligibility(buildSnapshot(makeWorker({ status }), noLoad), job);
    assert.equal(result.eligible, true, `${status} must accept work when resources fit`);
  }
});

test("a job larger than every worker has no eligible placement", () => {
  const snapshots = [
    buildSnapshot(makeWorker({ name: "worker-1", cpuCapacityMillicores: 2_000 }), noLoad),
    buildSnapshot(makeWorker({ name: "worker-2", cpuCapacityMillicores: 4_000 }), noLoad),
  ];
  const oversized = makeJob({ cpuRequiredMillicores: 8_000, memoryRequiredMiB: 1_024 });

  const evaluation = evaluatePlacement(snapshots, oversized, PlacementStrategy.FIRST_FIT);

  assert.equal(evaluation.selected, null);
  assert.equal(evaluation.candidates.every((candidate) => !candidate.eligible), true);
});

test("FIRST_FIT picks the first eligible worker in stable name order", () => {
  const snapshots = [
    buildSnapshot(makeWorker({ name: "worker-3", cpuAllocatedMillicores: 0 }), noLoad),
    buildSnapshot(makeWorker({ name: "worker-1", cpuCapacityMillicores: 500 }), noLoad),
    buildSnapshot(makeWorker({ name: "worker-2" }), noLoad),
  ];
  const job = makeJob({ cpuRequiredMillicores: 1_000, memoryRequiredMiB: 512 });

  const evaluation = evaluatePlacement(snapshots, job, PlacementStrategy.FIRST_FIT);

  assert.deepEqual(
    evaluation.candidates.map((candidate) => candidate.worker.name),
    ["worker-1", "worker-2", "worker-3"],
  );
  assert.equal(evaluation.candidates[0]?.eligible, false, "worker-1 is too small");
  assert.equal(evaluation.selected?.name, "worker-2");
});

test("LEAST_LOADED picks the lowest current peak utilization", () => {
  const snapshots = [
    buildSnapshot(makeWorker({ name: "worker-1" }), { cpuMillicores: 3_000, memoryMiB: 0 }),
    buildSnapshot(makeWorker({ name: "worker-2" }), { cpuMillicores: 400, memoryMiB: 256 }),
    buildSnapshot(makeWorker({ name: "worker-3" }), { cpuMillicores: 2_000, memoryMiB: 2_048 }),
  ];
  const job = makeJob({ cpuRequiredMillicores: 500, memoryRequiredMiB: 256 });

  const evaluation = evaluatePlacement(snapshots, job, PlacementStrategy.LEAST_LOADED);

  assert.equal(evaluation.selected?.name, "worker-2");
});

test("RESOURCE_AWARE looks at the resulting fit, not just current load", () => {
  // worker-a is the least loaded right now (10% peak), but it is CPU-small, so
  // this job would push it to 90% CPU and leave it badly imbalanced.
  const smallCpu = buildSnapshot(
    makeWorker({ name: "worker-a", cpuCapacityMillicores: 1_000, memoryCapacityMiB: 4_096 }),
    { cpuMillicores: 100, memoryMiB: 400 },
  );
  // worker-b starts busier (25% peak) but absorbs the job evenly.
  const roomy = buildSnapshot(
    makeWorker({ name: "worker-b", cpuCapacityMillicores: 4_000, memoryCapacityMiB: 4_096 }),
    { cpuMillicores: 1_000, memoryMiB: 1_024 },
  );
  const cpuHeavy = makeJob({ cpuRequiredMillicores: 800, memoryRequiredMiB: 256 });

  const leastLoaded = evaluatePlacement([smallCpu, roomy], cpuHeavy, PlacementStrategy.LEAST_LOADED);
  const resourceAware = evaluatePlacement(
    [smallCpu, roomy],
    cpuHeavy,
    PlacementStrategy.RESOURCE_AWARE,
  );

  assert.equal(leastLoaded.selected?.name, "worker-a", "least loaded uses current utilization");
  assert.equal(resourceAware.selected?.name, "worker-b", "resource aware uses post-placement fit");
  assert.ok(
    scoreCandidate(roomy, cpuHeavy, PlacementStrategy.RESOURCE_AWARE) <
      scoreCandidate(smallCpu, cpuHeavy, PlacementStrategy.RESOURCE_AWARE),
  );
});

test("assignment persists the advisory decision without reserving resources", async () => {
  const job = makeJob({ cpuRequiredMillicores: 1_000, memoryRequiredMiB: 512 });
  const worker = makeWorker({ name: "worker-1" });
  const repository = new InMemoryPlacementRepository([job], [worker]);
  const service = new PlacementService(repository, () => now);

  const result = await service.assign({
    jobId: job.id,
    strategy: PlacementStrategy.LEAST_LOADED,
  });

  assert.equal(result.job.assignedWorkerId, worker.id);
  assert.equal(result.job.placementStrategy, PlacementStrategy.LEAST_LOADED);
  assert.equal(result.job.placedAt?.toISOString(), now.toISOString());
  assert.equal(result.job.status, JobStatus.SCHEDULED, "placement is not a lifecycle transition");
  assert.equal(worker.cpuAllocatedMillicores, 0, "placement must not reserve CPU");
  assert.equal(worker.memoryAllocatedMiB, 0, "placement must not reserve memory");
});

test("placement is refused when no worker has enough resources", async () => {
  const job = makeJob({ cpuRequiredMillicores: 8_000, memoryRequiredMiB: 512 });
  const repository = new InMemoryPlacementRepository(
    [job],
    [makeWorker({ name: "worker-1", cpuCapacityMillicores: 2_000 })],
  );
  const service = new PlacementService(repository, () => now);

  await assert.rejects(
    () => service.assign({ jobId: job.id, strategy: PlacementStrategy.FIRST_FIT }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === "INSUFFICIENT_RESOURCES",
  );
  assert.equal(job.assignedWorkerId, null);
  assert.equal(repository.assignments.length, 0);
});

test("advisory load from earlier placements prevents overcommitting one worker", async () => {
  const worker = makeWorker({ name: "worker-1", cpuCapacityMillicores: 2_000 });
  const first = makeJob({ cpuRequiredMillicores: 1_500, memoryRequiredMiB: 512 });
  const second = makeJob({ cpuRequiredMillicores: 1_000, memoryRequiredMiB: 512 });
  const loads = new Map<string, WorkerLoad>();
  const repository = new InMemoryPlacementRepository([first, second], [worker], loads);
  const service = new PlacementService(repository, () => now);

  await service.assign({ jobId: first.id, strategy: PlacementStrategy.FIRST_FIT });
  // Simulate the repository projection once the first job occupies the worker.
  loads.set(worker.id, { cpuMillicores: 1_500, memoryMiB: 512 });

  await assert.rejects(
    () => service.assign({ jobId: second.id, strategy: PlacementStrategy.FIRST_FIT }),
    (error: unknown) => error instanceof AppError && error.code === "INSUFFICIENT_RESOURCES",
  );
});

test("placement rejects unknown, unscheduled, already placed, and contested jobs", async () => {
  const queued = makeJob({ status: JobStatus.QUEUED });
  const placed = makeJob({ assignedWorkerId: randomUUID(), placementStrategy: PlacementStrategy.FIRST_FIT, placedAt: now });
  const contested = makeJob();
  const repository = new InMemoryPlacementRepository(
    [queued, placed, contested],
    [makeWorker({ name: "worker-1" })],
  );
  const service = new PlacementService(repository, () => now);

  await assert.rejects(
    () => service.assign({ jobId: randomUUID(), strategy: PlacementStrategy.FIRST_FIT }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
  await assert.rejects(
    () => service.assign({ jobId: queued.id, strategy: PlacementStrategy.FIRST_FIT }),
    (error: unknown) => error instanceof AppError && error.code === "JOB_NOT_PLACEABLE",
  );
  await assert.rejects(
    () => service.assign({ jobId: placed.id, strategy: PlacementStrategy.FIRST_FIT }),
    (error: unknown) => error instanceof AppError && error.code === "JOB_ALREADY_PLACED",
  );

  repository.failAssign = true;
  await assert.rejects(
    () => service.assign({ jobId: contested.id, strategy: PlacementStrategy.FIRST_FIT }),
    (error: unknown) => error instanceof AppError && error.code === "PLACEMENT_CONFLICT",
  );
});

test("preview reports reasons without changing state and input is strictly validated", async () => {
  const job = makeJob({ cpuRequiredMillicores: 3_000, memoryRequiredMiB: 512 });
  const repository = new InMemoryPlacementRepository(
    [job],
    [
      makeWorker({ name: "worker-1", cpuCapacityMillicores: 2_000 }),
      makeWorker({ name: "worker-2", cpuCapacityMillicores: 4_000 }),
    ],
  );
  const service = new PlacementService(repository, () => now);

  const preview = await service.preview({
    jobId: job.id,
    strategy: PlacementStrategy.RESOURCE_AWARE,
  });

  assert.equal(preview.selected?.name, "worker-2");
  assert.equal(preview.candidates[0]?.eligible, false);
  assert.ok((preview.candidates[0]?.reasons.length ?? 0) > 0);
  assert.equal(job.assignedWorkerId, null);
  assert.equal(repository.assignments.length, 0);

  assert.equal(
    assignPlacementSchema.safeParse({ jobId: job.id, strategy: "FIRST_FIT" }).success,
    true,
  );
  assert.equal(assignPlacementSchema.safeParse({ jobId: "nope", strategy: "FIRST_FIT" }).success, false);
  assert.equal(assignPlacementSchema.safeParse({ jobId: job.id, strategy: "BEST" }).success, false);
  assert.equal(
    assignPlacementSchema.safeParse({ jobId: job.id, strategy: "FIRST_FIT", workerId: randomUUID() })
      .success,
    false,
  );
});
