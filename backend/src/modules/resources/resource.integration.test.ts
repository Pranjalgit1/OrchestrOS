import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  AllocationStatus,
  JobStatus,
  WorkerStatus,
  WorkloadType,
  type Job,
} from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { prismaResourceRepository } from "./resource.repository.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}/api`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test(
  "concurrent reservations cannot over-allocate a worker",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `reservation-${randomUUID()}`;

    try {
      // A worker with room for exactly one of the two competing jobs.
      const worker = await prisma.worker.create({
        data: {
          name: `${prefix}-worker`,
          cpuCapacityMillicores: 1_000,
          memoryCapacityMiB: 1_024,
          status: WorkerStatus.IDLE,
        },
      });

      const jobTemplate = {
        workloadType: WorkloadType.SORTING,
        workloadSize: 5_000,
        status: JobStatus.SCHEDULED,
        estimatedDurationSeconds: 20,
        priority: 5,
        schedulingRounds: 1,
        scheduledAt: new Date(),
        schedulingPolicy: "FCFS" as const,
        placementStrategy: "FIRST_FIT" as const,
        placedAt: new Date(),
        assignedWorkerId: worker.id,
        cpuRequiredMillicores: 700,
        memoryRequiredMiB: 512,
      };

      const jobA = await prisma.job.create({
        data: { ...jobTemplate, name: `${prefix}-a` },
      });
      const jobB = await prisma.job.create({
        data: { ...jobTemplate, name: `${prefix}-b` },
      });

      // Both request 700m of a 1000m worker at the same moment.
      const outcomes = await Promise.all([
        prismaResourceRepository.reserve({
          jobId: jobA.id,
          workerId: worker.id,
          cpuMillicores: jobA.cpuRequiredMillicores,
          memoryMiB: jobA.memoryRequiredMiB,
        }),
        prismaResourceRepository.reserve({
          jobId: jobB.id,
          workerId: worker.id,
          cpuMillicores: jobB.cpuRequiredMillicores,
          memoryMiB: jobB.memoryRequiredMiB,
        }),
      ]);

      const reserved = outcomes.filter((outcome) => outcome.status === "RESERVED");
      const refused = outcomes.filter(
        (outcome) => outcome.status === "INSUFFICIENT_RESOURCES",
      );

      assert.equal(reserved.length, 1, "exactly one concurrent reservation may succeed");
      assert.equal(refused.length, 1, "the loser must be refused for lack of capacity");

      const afterConcurrency = await prisma.worker.findUniqueOrThrow({
        where: { id: worker.id },
      });
      assert.equal(afterConcurrency.cpuAllocatedMillicores, 700);
      assert.equal(afterConcurrency.memoryAllocatedMiB, 512);
      assert.ok(
        afterConcurrency.cpuAllocatedMillicores <= afterConcurrency.cpuCapacityMillicores,
        "worker must never be over-allocated",
      );
      assert.equal(afterConcurrency.status, WorkerStatus.BUSY);
      assert.equal(
        await prisma.resourceAllocation.count({
          where: { workerId: worker.id, status: AllocationStatus.RESERVED },
        }),
        1,
        "the refused reservation must leave no allocation row behind",
      );

      // The winner releases, which frees capacity for the loser to retry.
      const winner = reserved[0];
      assert.ok(winner && winner.status === "RESERVED");
      const winnerJobId = winner.allocation.jobId;
      const loserJobId = winnerJobId === jobA.id ? jobB.id : jobA.id;

      const releaseOutcome = await prismaResourceRepository.release(winnerJobId);
      assert.equal(releaseOutcome.status, "RELEASED");

      const afterRelease = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(afterRelease.cpuAllocatedMillicores, 0);
      assert.equal(afterRelease.memoryAllocatedMiB, 0);
      assert.equal(afterRelease.status, WorkerStatus.IDLE, "a fully released worker is idle again");

      const releasedAllocation = await prisma.resourceAllocation.findFirstOrThrow({
        where: { jobId: winnerJobId },
      });
      assert.equal(releasedAllocation.status, AllocationStatus.RELEASED);
      assert.ok(releasedAllocation.releasedAt, "release must record when capacity was returned");

      // Release is idempotent.
      const repeat = await prismaResourceRepository.release(winnerJobId);
      assert.equal(repeat.status, "ALREADY_RELEASED");
      const afterRepeat = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(afterRepeat.cpuAllocatedMillicores, 0, "a repeated release must not double-free");

      // The previously refused job now fits.
      const retry = await prismaResourceRepository.reserve({
        jobId: loserJobId,
        workerId: worker.id,
        cpuMillicores: 700,
        memoryMiB: 512,
      });
      assert.equal(retry.status, "RESERVED");

      // A job may not hold two reservations; the partial unique index enforces it.
      const duplicate = await prismaResourceRepository.reserve({
        jobId: loserJobId,
        workerId: worker.id,
        cpuMillicores: 100,
        memoryMiB: 64,
      });
      assert.equal(duplicate.status, "ALREADY_RESERVED");
      const afterDuplicate = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(
        afterDuplicate.cpuAllocatedMillicores,
        700,
        "a rejected duplicate must not change worker counters",
      );
    } finally {
      await prisma.resourceAllocation.deleteMany({
        where: { job: { name: { startsWith: prefix } } },
      });
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  },
);

test(
  "a failed reservation transaction rolls back every write",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `rollback-${randomUUID()}`;

    try {
      const worker = await prisma.worker.create({
        data: {
          name: `${prefix}-worker`,
          cpuCapacityMillicores: 2_000,
          memoryCapacityMiB: 2_048,
          status: WorkerStatus.IDLE,
        },
      });
      const job = await prisma.job.create({
        data: {
          name: `${prefix}-job`,
          workloadType: WorkloadType.SORTING,
          workloadSize: 5_000,
          status: JobStatus.SCHEDULED,
          cpuRequiredMillicores: 500,
          memoryRequiredMiB: 256,
          estimatedDurationSeconds: 10,
          priority: 5,
          assignedWorkerId: worker.id,
          placementStrategy: "FIRST_FIT",
          placedAt: new Date(),
        },
      });

      // Same shape as a real reservation, but the transaction fails after both
      // the allocation insert and the counter update have been issued.
      await assert.rejects(() =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "workers" WHERE "id" = ${worker.id}::uuid FOR UPDATE`;
          await tx.resourceAllocation.create({
            data: {
              jobId: job.id,
              workerId: worker.id,
              cpuMillicores: 500,
              memoryMiB: 256,
              status: AllocationStatus.RESERVED,
            },
          });
          await tx.worker.update({
            where: { id: worker.id },
            data: {
              cpuAllocatedMillicores: { increment: 500 },
              memoryAllocatedMiB: { increment: 256 },
              status: WorkerStatus.BUSY,
            },
          });
          throw new Error("simulated failure before commit");
        }),
      );

      const afterRollback = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(afterRollback.cpuAllocatedMillicores, 0, "counters must roll back");
      assert.equal(afterRollback.memoryAllocatedMiB, 0);
      assert.equal(afterRollback.status, WorkerStatus.IDLE);
      assert.equal(
        await prisma.resourceAllocation.count({ where: { jobId: job.id } }),
        0,
        "no allocation row may survive a rolled-back transaction",
      );

      // The database itself refuses over-allocation even if application logic fails.
      await assert.rejects(
        () =>
          prisma.worker.update({
            where: { id: worker.id },
            data: { cpuAllocatedMillicores: 2_500 },
          }),
        "the capacity CHECK constraint is the last line of defence",
      );
    } finally {
      await prisma.resourceAllocation.deleteMany({
        where: { job: { name: { startsWith: prefix } } },
      });
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  },
);

test(
  "reservation and release route contracts behave correctly",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `resource-api-${randomUUID()}`;
    let job: Job | undefined;

    try {
      const worker = await prisma.worker.create({
        data: {
          name: `${prefix}-worker`,
          cpuCapacityMillicores: 2_000,
          memoryCapacityMiB: 2_048,
          status: WorkerStatus.IDLE,
        },
      });
      job = await prisma.job.create({
        data: {
          name: `${prefix}-job`,
          workloadType: WorkloadType.SORTING,
          workloadSize: 5_000,
          status: JobStatus.SCHEDULED,
          cpuRequiredMillicores: 800,
          memoryRequiredMiB: 512,
          estimatedDurationSeconds: 15,
          priority: 5,
          assignedWorkerId: worker.id,
          placementStrategy: "FIRST_FIT",
          placedAt: new Date(),
        },
      });
      const placedJob = job;

      await withServer(async (baseUrl) => {
        const post = (path: string, body: unknown) =>
          fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });

        const reserveResponse = await post("/resources/reserve", { jobId: placedJob.id });
        const reservation = (await reserveResponse.json()) as {
          allocation: { status: string; cpuMillicores: number };
          worker: { cpuAllocatedMillicores: number; status: string };
          lockWaitMs: number;
        };
        assert.equal(reserveResponse.status, 201);
        assert.equal(reservation.allocation.status, AllocationStatus.RESERVED);
        assert.equal(reservation.allocation.cpuMillicores, 800);
        assert.equal(reservation.worker.cpuAllocatedMillicores, 800);
        assert.equal(reservation.worker.status, WorkerStatus.BUSY);
        assert.ok(reservation.lockWaitMs >= 0);

        const duplicate = await post("/resources/reserve", { jobId: placedJob.id });
        const duplicateBody = (await duplicate.json()) as { error: { code: string } };
        assert.equal(duplicate.status, 409);
        assert.equal(duplicateBody.error.code, "ALREADY_RESERVED");

        const allocationsResponse = await fetch(
          `${baseUrl}/resources/allocations?jobId=${placedJob.id}&status=RESERVED`,
        );
        const allocations = (await allocationsResponse.json()) as unknown[];
        assert.equal(allocationsResponse.status, 200);
        assert.equal(allocations.length, 1);

        const releaseResponse = await post("/resources/release", { jobId: placedJob.id });
        const release = (await releaseResponse.json()) as {
          alreadyReleased: boolean;
          worker: { cpuAllocatedMillicores: number; status: string } | null;
        };
        assert.equal(releaseResponse.status, 200);
        assert.equal(release.alreadyReleased, false);
        assert.equal(release.worker?.cpuAllocatedMillicores, 0);
        assert.equal(release.worker?.status, WorkerStatus.IDLE);

        const repeatRelease = await post("/resources/release", { jobId: placedJob.id });
        const repeatBody = (await repeatRelease.json()) as { alreadyReleased: boolean };
        assert.equal(repeatRelease.status, 200);
        assert.equal(repeatBody.alreadyReleased, true, "release is idempotent");

        const missing = await post("/resources/reserve", { jobId: randomUUID() });
        assert.equal(missing.status, 404);

        const invalid = await post("/resources/reserve", {
          jobId: placedJob.id,
          cpuMillicores: 5_000,
        });
        assert.equal(invalid.status, 400, "clients cannot choose the reserved amount");
      });
    } finally {
      await prisma.resourceAllocation.deleteMany({
        where: { job: { name: { startsWith: prefix } } },
      });
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  },
);

test(
  "a duplicate reservation is reported as such even when the worker is saturated",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `duplicate-${randomUUID()}`;

    try {
      // Capacity is an exact fit, so the job's own reservation leaves no room.
      // Checking capacity before duplication would report a false shortfall.
      const worker = await prisma.worker.create({
        data: {
          name: `${prefix}-worker`,
          cpuCapacityMillicores: 800,
          memoryCapacityMiB: 512,
          status: WorkerStatus.IDLE,
        },
      });
      const job = await prisma.job.create({
        data: {
          name: `${prefix}-job`,
          workloadType: WorkloadType.SORTING,
          workloadSize: 5_000,
          status: JobStatus.SCHEDULED,
          cpuRequiredMillicores: 800,
          memoryRequiredMiB: 512,
          estimatedDurationSeconds: 10,
          priority: 5,
          assignedWorkerId: worker.id,
          placementStrategy: "FIRST_FIT",
          placedAt: new Date(),
        },
      });

      const request = {
        jobId: job.id,
        workerId: worker.id,
        cpuMillicores: 800,
        memoryMiB: 512,
      };

      const first = await prismaResourceRepository.reserve(request);
      assert.equal(first.status, "RESERVED");

      const second = await prismaResourceRepository.reserve(request);
      assert.equal(
        second.status,
        "ALREADY_RESERVED",
        "the job holds the capacity itself, so this is a duplicate, not a shortfall",
      );

      const after = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(after.cpuAllocatedMillicores, 800, "counters must be untouched");
      assert.equal(
        await prisma.resourceAllocation.count({
          where: { jobId: job.id, status: AllocationStatus.RESERVED },
        }),
        1,
      );
    } finally {
      await prisma.resourceAllocation.deleteMany({
        where: { job: { name: { startsWith: prefix } } },
      });
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  },
);
