import { AllocationStatus, JobStatus, WorkerStatus } from "@prisma/client";
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
  async listWorkers() {
    const workers = await prisma.worker.findMany({
      // Retired workers are out of service and not placement candidates.
      where: { status: { not: WorkerStatus.RETIRED } },
      orderBy: { name: "asc" },
      include: { _count: { select: { assignedJobs: true } } },
    });
    return workers.map(({ _count, ...worker }) => ({
      ...worker,
      placementCount: _count.assignedJobs,
    }));
  },
  async assignedLoadByWorker() {
    const grouped = await prisma.job.groupBy({
      by: ["assignedWorkerId"],
      where: {
        assignedWorkerId: { not: null },
        status: { in: [...ACTIVE_PLACEMENT_STATUSES] },
        // Reserved jobs are already included in the worker's allocated counters.
        allocations: { none: { status: AllocationStatus.RESERVED } },
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
