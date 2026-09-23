import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AllocationStatus,
  JobStatus,
  WorkerStatus,
  WorkloadType,
  type Job,
  type ResourceAllocation,
  type Worker,
} from "@prisma/client";

import { AppError } from "../../errors/app-error.js";
import type {
  AllocationFilter,
  ReserveOutcome,
  ReserveRequest,
  ReleaseOutcome,
  ResourceRepository,
} from "./resource.repository.js";
import {
  listAllocationsQuerySchema,
  releaseResourcesSchema,
  reserveResourcesSchema,
} from "./resource.schemas.js";
import { ResourceService, type JobLookup } from "./resource.service.js";

const now = new Date("2026-09-22T12:00:00.000Z");

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    name: "worker-1",
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
    name: "reservation-job",
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
    placedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    assignedWorkerId: randomUUID(),
    containerId: null,
    result: null,
    failureReason: null,
    ...overrides,
  };
}

function makeAllocation(overrides: Partial<ResourceAllocation> = {}): ResourceAllocation {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    workerId: randomUUID(),
    cpuMillicores: 1_000,
    memoryMiB: 512,
    status: AllocationStatus.RESERVED,
    reservedAt: now,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class StubResourceRepository implements ResourceRepository {
  readonly requests: ReserveRequest[] = [];

  constructor(
    private readonly reserveOutcome: ReserveOutcome,
    private readonly releaseOutcome: ReleaseOutcome = { status: "NO_ALLOCATION" },
  ) {}

  async reserve(request: ReserveRequest): Promise<ReserveOutcome> {
    this.requests.push(request);
    return this.reserveOutcome;
  }

  async release(): Promise<ReleaseOutcome> {
    return this.releaseOutcome;
  }

  async listAllocations(_filter: AllocationFilter): Promise<ResourceAllocation[]> {
    return [];
  }
}

function lookup(jobs: Job[]): JobLookup {
  return {
    async findJobById(jobId) {
      return jobs.find((job) => job.id === jobId) ?? null;
    },
  };
}

test("reservation requests exactly the placed job's requirements", async () => {
  const job = makeJob({ cpuRequiredMillicores: 1_500, memoryRequiredMiB: 768 });
  const worker = makeWorker({
    id: job.assignedWorkerId ?? randomUUID(),
    cpuAllocatedMillicores: 1_500,
    memoryAllocatedMiB: 768,
    status: WorkerStatus.BUSY,
  });
  const allocation = makeAllocation({
    jobId: job.id,
    workerId: worker.id,
    cpuMillicores: 1_500,
    memoryMiB: 768,
  });
  const repository = new StubResourceRepository({
    status: "RESERVED",
    allocation,
    worker,
    lockWaitMs: 3,
  });
  const service = new ResourceService(repository, lookup([job]));

  const result = await service.reserve({ jobId: job.id });

  assert.deepEqual(repository.requests, [
    {
      jobId: job.id,
      workerId: job.assignedWorkerId,
      cpuMillicores: 1_500,
      memoryMiB: 768,
    },
  ]);
  assert.equal(result.allocation.status, AllocationStatus.RESERVED);
  assert.equal(result.worker.cpuAllocatedMillicores, 1_500);
  assert.equal(result.worker.status, WorkerStatus.BUSY);
  assert.equal(result.lockWaitMs, 3);
});

test("reservation is refused when the locked recheck finds no capacity", async () => {
  const job = makeJob({ cpuRequiredMillicores: 2_000 });
  const repository = new StubResourceRepository({
    status: "INSUFFICIENT_RESOURCES",
    lockWaitMs: 12,
    cpuAvailableMillicores: 500,
    memoryAvailableMiB: 4_096,
  });
  const service = new ResourceService(repository, lookup([job]));

  await assert.rejects(
    () => service.reserve({ jobId: job.id }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 409 &&
      error.code === "INSUFFICIENT_RESOURCES" &&
      error.message.includes("500m CPU"),
  );
});

test("a job cannot hold two reservations at once", async () => {
  const job = makeJob();
  const repository = new StubResourceRepository({ status: "ALREADY_RESERVED", lockWaitMs: 1 });
  const service = new ResourceService(repository, lookup([job]));

  await assert.rejects(
    () => service.reserve({ jobId: job.id }),
    (error: unknown) => error instanceof AppError && error.code === "ALREADY_RESERVED",
  );
});

test("reservation requires an existing, scheduled, placed job", async () => {
  const unplaced = makeJob({ assignedWorkerId: null, placedAt: null });
  const queued = makeJob({ status: JobStatus.QUEUED });
  const repository = new StubResourceRepository({ status: "WORKER_NOT_FOUND", lockWaitMs: 0 });
  const service = new ResourceService(repository, lookup([unplaced, queued]));

  await assert.rejects(
    () => service.reserve({ jobId: randomUUID() }),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
  await assert.rejects(
    () => service.reserve({ jobId: queued.id }),
    (error: unknown) => error instanceof AppError && error.code === "JOB_NOT_RESERVABLE",
  );
  await assert.rejects(
    () => service.reserve({ jobId: unplaced.id }),
    (error: unknown) => error instanceof AppError && error.code === "JOB_NOT_PLACED",
  );
  assert.equal(repository.requests.length, 0, "invalid requests must not reach the transaction");
});

test("release returns the freed allocation and worker", async () => {
  const job = makeJob();
  const allocation = makeAllocation({
    jobId: job.id,
    status: AllocationStatus.RELEASED,
    releasedAt: now,
  });
  const worker = makeWorker({ status: WorkerStatus.IDLE });
  const repository = new StubResourceRepository(
    { status: "ALREADY_RESERVED", lockWaitMs: 0 },
    { status: "RELEASED", allocation, worker },
  );
  const service = new ResourceService(repository, lookup([job]));

  const result = await service.release({ jobId: job.id });

  assert.equal(result.alreadyReleased, false);
  assert.equal(result.allocation.status, AllocationStatus.RELEASED);
  assert.equal(result.worker?.status, WorkerStatus.IDLE);
});

test("release is idempotent and rejects jobs that never reserved", async () => {
  const job = makeJob();
  const released = makeAllocation({
    jobId: job.id,
    status: AllocationStatus.RELEASED,
    releasedAt: now,
  });

  const idempotent = new ResourceService(
    new StubResourceRepository(
      { status: "ALREADY_RESERVED", lockWaitMs: 0 },
      { status: "ALREADY_RELEASED", allocation: released },
    ),
    lookup([job]),
  );
  const repeat = await idempotent.release({ jobId: job.id });
  assert.equal(repeat.alreadyReleased, true);
  assert.equal(repeat.worker, null);

  const never = new ResourceService(
    new StubResourceRepository(
      { status: "ALREADY_RESERVED", lockWaitMs: 0 },
      { status: "NO_ALLOCATION" },
    ),
    lookup([job]),
  );
  await assert.rejects(
    () => never.release({ jobId: job.id }),
    (error: unknown) => error instanceof AppError && error.code === "NO_ACTIVE_ALLOCATION",
  );
});

test("resource request input is strictly validated", () => {
  const id = randomUUID();

  assert.equal(reserveResourcesSchema.safeParse({ jobId: id }).success, true);
  assert.equal(reserveResourcesSchema.safeParse({ jobId: "nope" }).success, false);
  assert.equal(
    reserveResourcesSchema.safeParse({ jobId: id, cpuMillicores: 9_999 }).success,
    false,
    "clients cannot choose how much to reserve",
  );
  assert.equal(
    reserveResourcesSchema.safeParse({ jobId: id, workerId: randomUUID() }).success,
    false,
    "clients cannot choose the worker",
  );
  assert.equal(releaseResourcesSchema.safeParse({ jobId: id }).success, true);
  assert.equal(releaseResourcesSchema.safeParse({}).success, false);
  assert.equal(
    listAllocationsQuerySchema.safeParse({ status: "RESERVED", limit: "10" }).success,
    true,
  );
  assert.equal(listAllocationsQuerySchema.safeParse({ status: "PENDING" }).success, false);
});
