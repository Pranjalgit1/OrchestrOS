import { AllocationStatus, JobStatus, Prisma, WorkerStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { TRANSACTION_OPTIONS } from "../resources/resource.repository.js";
import { SCHEDULABLE_WORKER_STATUSES } from "../placement/placement.accounting.js";
/** Jobs that still have a plan on their worker. */
const ACTIVE_JOB_STATUSES = [JobStatus.SCHEDULED, JobStatus.RUNNING];
function eventData(tx, decision, workerId, workerCount) {
  return tx.scalingEvent.create({
    data: {
      action: decision.action,
      workerId,
      workerName: decision.workerName,
      reason: decision.reason,
      queuedJobs: decision.signals.queuedJobs,
      cpuUtilization: decision.signals.utilization.cpu,
      memoryUtilization: decision.signals.utilization.memory,
      workerCount,
    },
  });
}
function countSchedulable(tx) {
  return tx.worker.count({ where: { status: { in: SCHEDULABLE_WORKER_STATUSES } } });
}
export const prismaAutoscalerRepository = {
  /** Everything one scaling decision reads, from a single database snapshot. */
  async readSnapshot(now) {
    return prisma.$transaction(async (tx) => {
      const [workers, retiredAutoscaled, autoscaledNames, queuedJobs, lastEvent] =
        await Promise.all([
          tx.worker.findMany({
            where: { status: { not: WorkerStatus.RETIRED } },
            orderBy: { name: "asc" },
            include: {
              _count: {
                select: {
                  allocations: { where: { status: AllocationStatus.RESERVED } },
                  assignedJobs: { where: { status: { in: ACTIVE_JOB_STATUSES } } },
                },
              },
            },
          }),
          tx.worker.findMany({
            where: { autoscaled: true, status: WorkerStatus.RETIRED },
            orderBy: { name: "asc" },
            select: { id: true, name: true },
          }),
          tx.worker.findMany({ where: { autoscaled: true }, select: { name: true } }),
          tx.job.count({ where: { status: JobStatus.QUEUED, arrivalAt: { lte: now } } }),
          tx.scalingEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
        ]);
      return {
        workers: workers.map(({ _count, ...worker }) => ({
          ...worker,
          reservedAllocations: _count.allocations,
          activeAssignedJobs: _count.assignedJobs,
        })),
        retiredAutoscaled,
        autoscaledNames: autoscaledNames.map((worker) => worker.name),
        queuedJobs,
        lastActionAt: lastEvent?.createdAt ?? null,
      };
    }, { isolationLevel: "RepeatableRead" });
  },
  /**
   * Adds capacity: brings a retired autoscaled worker back, or creates a new
   * one. The worker and the event that explains it commit together.
   */
  async scaleUp(decision, capacity) {
    try {
      return await prisma.$transaction(async (tx) => {
        let worker;
        if (decision.reuseWorkerId) {
          await tx.$queryRaw`SELECT \`id\` FROM \`workers\` WHERE \`id\` = ${decision.reuseWorkerId} FOR UPDATE`;
          const current = await tx.worker.findUnique({ where: { id: decision.reuseWorkerId } });
          if (!current || current.status !== WorkerStatus.RETIRED || !current.autoscaled) {
            return { status: "STALE" };
          }
          worker = await tx.worker.update({
            where: { id: current.id },
            data: {
              status: WorkerStatus.IDLE,
              cpuCapacityMillicores: capacity.cpuMillicores,
              memoryCapacityMiB: capacity.memoryMiB,
            },
          });
        } else {
          worker = await tx.worker.create({
            data: {
              name: decision.workerName,
              cpuCapacityMillicores: capacity.cpuMillicores,
              memoryCapacityMiB: capacity.memoryMiB,
              status: WorkerStatus.IDLE,
              autoscaled: true,
            },
          });
        }
        const event = await eventData(tx, decision, worker.id, await countSchedulable(tx));
        return { status: "SCALED", worker, event };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      // Someone created a worker with this name in the meantime.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { status: "STALE" };
      }
      throw error;
    }
  },
  /**
   * Retires one autoscaled worker, rechecked under its row lock: it must hold
   * no reservation and have no scheduled or running job planned on it. A job
   * placed in the gap is caught later by reservation, which refuses
   * non-schedulable workers.
   */
  async scaleDown(decision) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT \`id\` FROM \`workers\` WHERE \`id\` = ${decision.workerId} FOR UPDATE`;
      const worker = await tx.worker.findUnique({ where: { id: decision.workerId } });
      if (!worker || !worker.autoscaled || worker.status === WorkerStatus.RETIRED) {
        return { status: "STALE" };
      }
      const [reserved, planned] = await Promise.all([
        tx.resourceAllocation.count({
          where: { workerId: worker.id, status: AllocationStatus.RESERVED },
        }),
        tx.job.count({
          where: { assignedWorkerId: worker.id, status: { in: ACTIVE_JOB_STATUSES } },
        }),
      ]);
      if (reserved || planned || worker.cpuAllocatedMillicores || worker.memoryAllocatedMiB) {
        return { status: "BUSY" };
      }
      const retired = await tx.worker.update({
        where: { id: worker.id },
        data: { status: WorkerStatus.RETIRED },
      });
      const event = await eventData(tx, decision, worker.id, await countSchedulable(tx));
      return { status: "SCALED", worker: retired, event };
    }, TRANSACTION_OPTIONS);
  },
  listEvents(limit) {
    return prisma.scalingEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  },
};
