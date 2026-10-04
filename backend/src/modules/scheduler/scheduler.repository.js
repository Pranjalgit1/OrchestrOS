import { JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
export const prismaSchedulerRepository = {
  findEligible(now, limit) {
    return prisma.job.findMany({
      where: {
        status: JobStatus.QUEUED,
        arrivalAt: { lte: now },
      },
      orderBy: [
        { arrivalAt: "asc" },
        { createdAt: "asc" },
        { batchSequence: "asc" },
        { id: "asc" },
      ],
      take: limit,
    });
  },
  async claim({ jobId, policy, scheduledAt, timeQuantumSeconds }) {
    // Conditional update: only a job still QUEUED can be claimed, so two
    // concurrent dispatches can never schedule the same job.
    const result = await prisma.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.QUEUED,
      },
      data: {
        status: JobStatus.SCHEDULED,
        schedulingPolicy: policy,
        scheduledAt,
        timeQuantumSeconds,
        schedulingRounds: { increment: 1 },
      },
    });
    return result.count === 1;
  },
  findById(id) {
    return prisma.job.findUnique({ where: { id } });
  },
};
