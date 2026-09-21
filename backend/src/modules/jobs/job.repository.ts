import {
  JobStatus,
  Prisma,
  type Job,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

export interface JobRepository {
  create(data: Prisma.JobUncheckedCreateInput): Promise<Job>;
  findAll(status: JobStatus | undefined, limit: number): Promise<Job[]>;
  findById(id: string): Promise<Job | null>;
  cancelQueued(id: string, cancelledAt: Date): Promise<boolean>;
}

export const prismaJobRepository: JobRepository = {
  create(data) {
    return prisma.job.create({ data });
  },

  findAll(status, limit) {
    return prisma.job.findMany({
      ...(status ? { where: { status } } : {}),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });
  },

  findById(id) {
    return prisma.job.findUnique({ where: { id } });
  },

  async cancelQueued(id, cancelledAt) {
    const result = await prisma.job.updateMany({
      where: {
        id,
        status: JobStatus.QUEUED,
      },
      data: {
        status: JobStatus.CANCELLED,
        cancelledAt,
      },
    });

    return result.count === 1;
  },
};
