import { Prisma, type Worker } from "@prisma/client";

import { ConflictError } from "../../errors/app-error.js";
import { prisma } from "../../lib/prisma.js";

export interface WorkerRepository {
  create(data: Prisma.WorkerCreateInput): Promise<Worker>;
  findAll(): Promise<Worker[]>;
  findById(id: string): Promise<Worker | null>;
}

export const prismaWorkerRepository: WorkerRepository = {
  async create(data) {
    try {
      return await prisma.worker.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("A worker with this name already exists", "WORKER_NAME_EXISTS");
      }

      throw error;
    }
  },

  findAll() {
    return prisma.worker.findMany({ orderBy: { name: "asc" } });
  },

  findById(id) {
    return prisma.worker.findUnique({ where: { id } });
  },
};
