import { WorkerStatus } from "@prisma/client";
import { NotFoundError } from "../../errors/app-error.js";
import { prismaWorkerRepository } from "./worker.repository.js";
export class WorkerService {
  repository;
  constructor(repository = prismaWorkerRepository) {
    this.repository = repository;
  }
  create(input) {
    return this.repository.create({
      name: input.name.trim(),
      cpuCapacityMillicores: input.cpuCapacityMillicores,
      memoryCapacityMiB: input.memoryCapacityMiB,
      cpuAllocatedMillicores: 0,
      memoryAllocatedMiB: 0,
      status: WorkerStatus.IDLE,
    });
  }
  list() {
    return this.repository.findAll();
  }
  async getById(id) {
    const worker = await this.repository.findById(id);
    if (!worker) {
      throw new NotFoundError("Worker");
    }
    return worker;
  }
}
export const workerService = new WorkerService();
