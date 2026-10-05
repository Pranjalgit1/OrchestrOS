import { JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
const jobsBySequence = {
  orderBy: { batchSequence: "asc" },
};
export const prismaWorkloadRepository = {
  async deleteGeneratedJobs() {
    return prisma.$transaction(async (transaction) => {
      // Keep the eligibility checks in the DELETE itself: the scheduler may
      // claim a queued job while this request is in flight.
      const jobs = await transaction.job.deleteMany({
        where: {
          workloadBatchId: { not: null },
          status: JobStatus.QUEUED,
          scheduledAt: null,
          schedulingRounds: 0,
          assignedWorkerId: null,
          containerId: null,
          allocations: { none: {} },
          executions: { none: {} },
        },
      });
      // Preserve batches referenced by reused workloads.
      await transaction.workloadBatch.deleteMany({
        where: { jobs: { none: {} }, reusedBatches: { none: {} } },
      });
      return { deletedJobs: jobs.count };
    });
  },
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
          ...(input.sourceBatchId
            ? { sourceBatchId: input.sourceBatchId }
            : {}),
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
          arrivalAt: new Date(
            input.startsAt.getTime() + job.arrivalOffsetSeconds * 1_000,
          ),
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
