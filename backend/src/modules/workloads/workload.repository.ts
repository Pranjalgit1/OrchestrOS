import {
  JobStatus,
  Prisma,
  type WorkloadBatch,
  type WorkloadPattern,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import type { GeneratedWorkloadSpec } from "./workload.generator.js";

export type WorkloadBatchWithJobs = Prisma.WorkloadBatchGetPayload<{
  include: { jobs: true };
}>;

export interface PersistWorkloadBatchInput {
  seed: number;
  jobCount: number;
  pattern: WorkloadPattern;
  generatorVersion: string;
  parameters: Prisma.InputJsonValue;
  startsAt: Date;
  sourceBatchId?: string;
  jobs: GeneratedWorkloadSpec[];
}

export interface WorkloadRepository {
  createBatch(input: PersistWorkloadBatchInput): Promise<WorkloadBatchWithJobs>;
  findBatchById(id: string): Promise<WorkloadBatchWithJobs | null>;
}

const jobsBySequence = {
  orderBy: { batchSequence: "asc" as const },
};

export const prismaWorkloadRepository: WorkloadRepository = {
  createBatch(input) {
    return prisma.$transaction(async (transaction) => {
      const batch = await transaction.workloadBatch.create({
        data: {
          seed: input.seed,
          jobCount: input.jobCount,
          pattern: input.pattern,
          generatorVersion: input.generatorVersion,
          parameters: input.parameters,
          startsAt: input.startsAt,
          ...(input.sourceBatchId ? { sourceBatchId: input.sourceBatchId } : {}),
        },
      });

      await transaction.job.createMany({
        data: input.jobs.map((job) => ({
          name: job.name,
          workloadType: job.workloadType,
          workloadSize: job.workloadSize,
          status: JobStatus.QUEUED,
          cpuRequiredMillicores: job.cpuRequiredMillicores,
          memoryRequiredMiB: job.memoryRequiredMiB,
          estimatedDurationSeconds: job.estimatedDurationSeconds,
          priority: job.priority,
          workloadBatchId: batch.id,
          batchSequence: job.sequence,
          arrivalOffsetSeconds: job.arrivalOffsetSeconds,
          arrivalAt: new Date(input.startsAt.getTime() + job.arrivalOffsetSeconds * 1_000),
        })),
      });

      return transaction.workloadBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: { jobs: jobsBySequence },
      });
    });
  },

  findBatchById(id) {
    return prisma.workloadBatch.findUnique({
      where: { id },
      include: { jobs: jobsBySequence },
    });
  },
};
