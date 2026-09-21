import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  WorkerStatus,
  type Prisma,
  type Worker,
} from "@prisma/client";

import { AppError } from "../../errors/app-error.js";
import type { WorkerRepository } from "./worker.repository.js";
import { createWorkerSchema } from "./worker.schemas.js";
import { WorkerService } from "./worker.service.js";

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  const now = new Date();

  return {
    id: randomUUID(),
    name: "worker-test",
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

class InMemoryWorkerRepository implements WorkerRepository {
  private readonly workers = new Map<string, Worker>();

  async create(data: Prisma.WorkerCreateInput): Promise<Worker> {
    const worker = makeWorker({
      name: data.name,
      cpuCapacityMillicores: data.cpuCapacityMillicores,
      memoryCapacityMiB: data.memoryCapacityMiB,
      cpuAllocatedMillicores: data.cpuAllocatedMillicores ?? 0,
      memoryAllocatedMiB: data.memoryAllocatedMiB ?? 0,
      status: data.status ?? WorkerStatus.IDLE,
    });
    this.workers.set(worker.id, worker);
    return worker;
  }

  async findAll(): Promise<Worker[]> {
    return [...this.workers.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async findById(id: string): Promise<Worker | null> {
    return this.workers.get(id) ?? null;
  }
}

const validWorkerInput = {
  name: "worker-4",
  cpuCapacityMillicores: 2_000,
  memoryCapacityMiB: 2_048,
} as const;

test("worker schema accepts bounded capacity and rejects managed fields", () => {
  assert.equal(createWorkerSchema.safeParse(validWorkerInput).success, true);
  assert.equal(
    createWorkerSchema.safeParse({ ...validWorkerInput, status: WorkerStatus.FAILED }).success,
    false,
  );
  assert.equal(
    createWorkerSchema.safeParse({ ...validWorkerInput, cpuAllocatedMillicores: 500 }).success,
    false,
  );
  assert.equal(
    createWorkerSchema.safeParse({ ...validWorkerInput, memoryCapacityMiB: 0 }).success,
    false,
  );
});

test("worker service creates idle zero-allocation logical workers", async () => {
  const repository = new InMemoryWorkerRepository();
  const service = new WorkerService(repository);
  const worker = await service.create(validWorkerInput);

  assert.equal(worker.status, WorkerStatus.IDLE);
  assert.equal(worker.cpuAllocatedMillicores, 0);
  assert.equal(worker.memoryAllocatedMiB, 0);
  assert.equal(worker.cpuCapacityMillicores, validWorkerInput.cpuCapacityMillicores);
});

test("worker service lists by stable name and retrieves by id", async () => {
  const repository = new InMemoryWorkerRepository();
  const service = new WorkerService(repository);
  const workerB = await service.create({ ...validWorkerInput, name: "worker-b" });
  const workerA = await service.create({ ...validWorkerInput, name: "worker-a" });

  const workers = await service.list();
  assert.deepEqual(workers.map((worker) => worker.name), ["worker-a", "worker-b"]);
  assert.equal((await service.getById(workerB.id)).id, workerB.id);
  assert.equal((await service.getById(workerA.id)).id, workerA.id);
});

test("worker lookup rejects missing ids", async () => {
  const service = new WorkerService(new InMemoryWorkerRepository());

  await assert.rejects(
    () => service.getById(randomUUID()),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});
