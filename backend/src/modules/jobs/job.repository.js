import { JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
export const prismaJobRepository = {
  create(data) {
    return prisma.job.create({ data });
  },
  findAll(status, limit) {
    return prisma.job.findMany({
      ...(status ? { where: { status } } : {}),
      orderBy: [
        { arrivalAt: "asc" },
        { createdAt: "asc" },
        { batchSequence: "asc" },
        { id: "asc" },
      ],
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
