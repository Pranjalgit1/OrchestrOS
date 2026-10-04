import { AllocationStatus, Prisma, WorkerStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
/**
 * Reservation transactions intentionally block on a worker row lock, so the
 * defaults are widened: `maxWait` covers queueing for a connection and
 * `timeout` covers the lock wait plus the writes.
 */
export const TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 20_000,
};
export const prismaResourceRepository = {
  async reserve({ jobId, workerId, cpuMillicores, memoryMiB }) {
    return prisma.$transaction(async (tx) => {
      const lockStartedAt = Date.now();
      // Row-level lock. Any concurrent reservation for this worker waits here,
      // which is what serialises the capacity check below.
      const locked = await tx.$queryRaw`
        SELECT \`id\`,
               \`cpuCapacityMillicores\`,
               \`memoryCapacityMiB\`,
               \`cpuAllocatedMillicores\`,
               \`memoryAllocatedMiB\`
        FROM \`workers\`
        WHERE \`id\` = ${workerId}
        FOR UPDATE
      `;
      const lockWaitMs = Date.now() - lockStartedAt;
      const worker = locked[0];
      if (!worker) {
        return { status: "WORKER_NOT_FOUND", lockWaitMs };
      }
      // Duplicate check precedes the capacity check on purpose. A job that
      // already holds a reservation is counted in the worker's own usage, so
      // checking capacity first would report a misleading shortfall.
      const existing = await tx.resourceAllocation.findFirst({
        where: { jobId, status: AllocationStatus.RESERVED },
        select: { id: true },
      });
      if (existing) {
        return { status: "ALREADY_RESERVED", lockWaitMs };
      }
      // Re-read capacity inside the transaction. An earlier placement decision
      // is advisory only and may be stale by the time the lock is acquired.
      const cpuAvailableMillicores =
        worker.cpuCapacityMillicores - worker.cpuAllocatedMillicores;
      const memoryAvailableMiB =
        worker.memoryCapacityMiB - worker.memoryAllocatedMiB;
      if (
        cpuAvailableMillicores < cpuMillicores ||
        memoryAvailableMiB < memoryMiB
      ) {
        return {
          status: "INSUFFICIENT_RESOURCES",
          lockWaitMs,
          cpuAvailableMillicores,
          memoryAvailableMiB,
        };
      }
      try {
        const allocation = await tx.resourceAllocation.create({
          data: {
            jobId,
            workerId,
            cpuMillicores,
            memoryMiB,
            status: AllocationStatus.RESERVED,
          },
        });
        const updated = await tx.worker.update({
          where: { id: workerId },
          data: {
            cpuAllocatedMillicores: { increment: cpuMillicores },
            memoryAllocatedMiB: { increment: memoryMiB },
            status: WorkerStatus.BUSY,
          },
        });
        return { status: "RESERVED", allocation, worker: updated, lockWaitMs };
      } catch (error) {
        // A generated-column unique index allows only one RESERVED allocation per job.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          return { status: "ALREADY_RESERVED", lockWaitMs };
        }
        throw error;
      }
    }, TRANSACTION_OPTIONS);
  },
  async release(jobId) {
    return prisma.$transaction(
      (tx) => releaseAllocationWithin(tx, jobId),
      TRANSACTION_OPTIONS,
    );
  },
  listAllocations({ jobId, workerId, status, limit }) {
    return prisma.resourceAllocation.findMany({
      where: {
        ...(jobId ? { jobId } : {}),
        ...(workerId ? { workerId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ reservedAt: "desc" }, { id: "asc" }],
      take: limit,
    });
  },
};
/**
 * Releases a job's reservation using an existing transaction.
 *
 * Execution finalisation has to release capacity in the same transaction that
 * records the run's outcome, so the counter arithmetic lives here and is shared
 * rather than duplicated.
 */
export async function releaseAllocationWithin(tx, jobId) {
  const active = await tx.resourceAllocation.findFirst({
    where: { jobId, status: AllocationStatus.RESERVED },
  });
  if (!active) {
    const previous = await tx.resourceAllocation.findFirst({
      where: { jobId, status: AllocationStatus.RELEASED },
      orderBy: { releasedAt: "desc" },
    });
    return previous
      ? { status: "ALREADY_RELEASED", allocation: previous }
      : { status: "NO_ALLOCATION" };
  }
  // Lock the worker before touching its counters so release cannot race a
  // concurrent reservation.
  await tx.$queryRaw`
    SELECT \`id\` FROM \`workers\` WHERE \`id\` = ${active.workerId} FOR UPDATE
  `;
  const allocation = await tx.resourceAllocation.update({
    where: { id: active.id },
    data: {
      status: AllocationStatus.RELEASED,
      releasedAt: new Date(),
    },
  });
  const decremented = await tx.worker.update({
    where: { id: active.workerId },
    data: {
      cpuAllocatedMillicores: { decrement: active.cpuMillicores },
      memoryAllocatedMiB: { decrement: active.memoryMiB },
    },
  });
  // A worker holding no reservations is idle again.
  const worker =
    decremented.cpuAllocatedMillicores === 0 &&
    decremented.memoryAllocatedMiB === 0
      ? await tx.worker.update({
          where: { id: decremented.id },
          data: { status: WorkerStatus.IDLE },
        })
      : decremented;
  return { status: "RELEASED", allocation, worker };
}
