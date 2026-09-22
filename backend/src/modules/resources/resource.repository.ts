import {
  AllocationStatus,
  Prisma,
  WorkerStatus,
  type ResourceAllocation,
  type Worker,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

export interface ReserveRequest {
  jobId: string;
  workerId: string;
  cpuMillicores: number;
  memoryMiB: number;
}

export type ReserveOutcome =
  | {
      status: "RESERVED";
      allocation: ResourceAllocation;
      worker: Worker;
      lockWaitMs: number;
    }
  | {
      status: "INSUFFICIENT_RESOURCES";
      lockWaitMs: number;
      cpuAvailableMillicores: number;
      memoryAvailableMiB: number;
    }
  | { status: "WORKER_NOT_FOUND"; lockWaitMs: number }
  | { status: "ALREADY_RESERVED"; lockWaitMs: number };

export type ReleaseOutcome =
  | {
      status: "RELEASED";
      allocation: ResourceAllocation;
      worker: Worker;
    }
  | { status: "ALREADY_RELEASED"; allocation: ResourceAllocation }
  | { status: "NO_ALLOCATION" };

/** Columns read while holding the worker row lock. */
interface LockedWorkerRow {
  id: string;
  cpuCapacityMillicores: number;
  memoryCapacityMiB: number;
  cpuAllocatedMillicores: number;
  memoryAllocatedMiB: number;
}

export interface AllocationFilter {
  jobId?: string | undefined;
  workerId?: string | undefined;
  status?: AllocationStatus | undefined;
  limit: number;
}

export interface ResourceRepository {
  reserve(request: ReserveRequest): Promise<ReserveOutcome>;
  release(jobId: string): Promise<ReleaseOutcome>;
  listAllocations(filter: AllocationFilter): Promise<ResourceAllocation[]>;
}

/**
 * Reservation transactions intentionally block on a worker row lock, so the
 * defaults are widened: `maxWait` covers queueing for a connection and
 * `timeout` covers the lock wait plus the writes.
 */
export const TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 20_000,
} as const;

export const prismaResourceRepository: ResourceRepository = {
  async reserve({ jobId, workerId, cpuMillicores, memoryMiB }) {
    return prisma.$transaction(async (tx) => {
      const lockStartedAt = Date.now();

      // Row-level lock. Any concurrent reservation for this worker waits here,
      // which is what serialises the capacity check below.
      const locked = await tx.$queryRaw<LockedWorkerRow[]>`
        SELECT "id",
               "cpuCapacityMillicores",
               "memoryCapacityMiB",
               "cpuAllocatedMillicores",
               "memoryAllocatedMiB"
        FROM "workers"
        WHERE "id" = ${workerId}::uuid
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
      const memoryAvailableMiB = worker.memoryCapacityMiB - worker.memoryAllocatedMiB;

      if (cpuAvailableMillicores < cpuMillicores || memoryAvailableMiB < memoryMiB) {
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
        // A partial unique index allows only one RESERVED allocation per job.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
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
export async function releaseAllocationWithin(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<ReleaseOutcome> {
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
  await tx.$queryRaw<LockedWorkerRow[]>`
    SELECT "id" FROM "workers" WHERE "id" = ${active.workerId}::uuid FOR UPDATE
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
    decremented.cpuAllocatedMillicores === 0 && decremented.memoryAllocatedMiB === 0
      ? await tx.worker.update({
          where: { id: decremented.id },
          data: { status: WorkerStatus.IDLE },
        })
      : decremented;

  return { status: "RELEASED", allocation, worker };
}
