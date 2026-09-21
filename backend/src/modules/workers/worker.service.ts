import { WorkerStatus, type Worker } from "@prisma/client";

import { NotFoundError } from "../../errors/app-error.js";
import type { CreateWorkerInput } from "./worker.schemas.js";
import { prismaWorkerRepository, type WorkerRepository } from "./worker.repository.js";

export class WorkerService {
  constructor(private readonly repository: WorkerRepository = prismaWorkerRepository) {}

  create(input: CreateWorkerInput): Promise<Worker> {
    return this.repository.create({
      name: input.name.trim(),
      cpuCapacityMillicores: input.cpuCapacityMillicores,
      memoryCapacityMiB: input.memoryCapacityMiB,
      cpuAllocatedMillicores: 0,
      memoryAllocatedMiB: 0,
      status: WorkerStatus.IDLE,
    });
  }

  list(): Promise<Worker[]> {
    return this.repository.findAll();
  }

  async getById(id: string): Promise<Worker> {
    const worker = await this.repository.findById(id);

    if (!worker) {
      throw new NotFoundError("Worker");
    }

    return worker;
  }
}

export const workerService = new WorkerService();
