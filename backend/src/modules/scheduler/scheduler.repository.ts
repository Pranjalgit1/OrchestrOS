import {
  JobStatus,
  SchedulingPolicy,
  type Job,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

export interface ScheduleClaim {
  jobId: string;
  policy: SchedulingPolicy;
  scheduledAt: Date;
  timeQuantumSeconds: number | null;
}

export interface SchedulerRepository {
  findEligible(now: Date, limit: number): Promise<Job[]>;
  claim(claim: ScheduleClaim): Promise<boolean>;
  findById(id: string): Promise<Job | null>;
}

export const prismaSchedulerRepository: SchedulerRepository = {
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
