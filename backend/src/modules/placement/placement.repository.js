import { JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
/** Job states that still hold an advisory claim on a worker's capacity. */
export const ACTIVE_PLACEMENT_STATUSES = [
  JobStatus.SCHEDULED,
  JobStatus.RUNNING,
];
export const prismaPlacementRepository = {
  findJobById(jobId) {
    return prisma.job.findUnique({ where: { id: jobId } });
  },
  listWorkers() {
    return prisma.worker.findMany({ orderBy: { name: "asc" } });
  },
  async assignedLoadByWorker() {
    const grouped = await prisma.job.groupBy({
      by: ["assignedWorkerId"],
      where: {
        assignedWorkerId: { not: null },
        status: { in: [...ACTIVE_PLACEMENT_STATUSES] },
      },
      _sum: {
        cpuRequiredMillicores: true,
        memoryRequiredMiB: true,
      },
    });
    const loads = new Map();
    for (const row of grouped) {
      if (!row.assignedWorkerId) {
        continue;
      }
      loads.set(row.assignedWorkerId, {
        cpuMillicores: row._sum.cpuRequiredMillicores ?? 0,
        memoryMiB: row._sum.memoryRequiredMiB ?? 0,
      });
    }
    return loads;
  },
  async assign({ jobId, workerId, strategy, placedAt }) {
    // Conditional update: only an unplaced SCHEDULED job can be placed, so two
    // concurrent placements cannot assign the same job to different workers.
    const result = await prisma.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.SCHEDULED,
        assignedWorkerId: null,
      },
      data: {
        assignedWorkerId: workerId,
        placementStrategy: strategy,
        placedAt,
      },
    });
    return result.count === 1;
  },
};
