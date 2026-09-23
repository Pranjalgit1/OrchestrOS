import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  JobStatus,
  PlacementStrategy,
  WorkerStatus,
  WorkloadType,
} from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import {
  prismaPlacementRepository,
  type PlacementRepository,
} from "./placement.repository.js";
import { PlacementService } from "./placement.service.js";

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

/** Scopes worker discovery to this test's workers so assertions stay deterministic. */
function scopedRepository(prefix: string): PlacementRepository {
  return {
    findJobById: prismaPlacementRepository.findJobById,
    assignedLoadByWorker: prismaPlacementRepository.assignedLoadByWorker,
    assign: prismaPlacementRepository.assign,
    async listWorkers() {
      const workers = await prismaPlacementRepository.listWorkers();
      return workers.filter((worker) => worker.name.startsWith(prefix));
    },
  };
}

test(
  "placement persists advisory decisions and refuses insufficient resources",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `placement-${randomUUID()}`;
    const jobBase = {
      workloadType: WorkloadType.SORTING,
      workloadSize: 5_000,
      status: JobStatus.SCHEDULED,
      estimatedDurationSeconds: 20,
      priority: 5,
      schedulingRounds: 1,
      scheduledAt: new Date(),
      schedulingPolicy: "FCFS" as const,
    };

    try {
      const small = await prisma.worker.create({
        data: {
          name: `${prefix}-small`,
          cpuCapacityMillicores: 1_000,
          memoryCapacityMiB: 1_024,
          status: WorkerStatus.IDLE,
        },
      });
      const large = await prisma.worker.create({
        data: {
          name: `${prefix}-large`,
          cpuCapacityMillicores: 4_000,
          memoryCapacityMiB: 4_096,
          status: WorkerStatus.IDLE,
        },
      });
      const failed = await prisma.worker.create({
        data: {
          name: `${prefix}-zfailed`,
          cpuCapacityMillicores: 8_000,
          memoryCapacityMiB: 8_192,
          status: WorkerStatus.FAILED,
        },
      });

      const service = new PlacementService(scopedRepository(prefix));

      // Accounting starts from persisted capacity with no advisory load.
      const capacity = await service.capacity();
      assert.equal(capacity.length, 3);
      const smallSnapshot = capacity.find((worker) => worker.workerId === small.id);
      assert.equal(smallSnapshot?.cpuAvailableMillicores, 1_000);
      assert.equal(smallSnapshot?.cpuAssignedMillicores, 0);
      assert.equal(
        capacity.find((worker) => worker.workerId === failed.id)?.schedulable,
        false,
      );

      // A job that only the large worker fits must land there, skipping the
      // bigger FAILED worker entirely.
      const bigJob = await prisma.job.create({
        data: {
          ...jobBase,
          name: `${prefix}-big`,
          cpuRequiredMillicores: 3_000,
          memoryRequiredMiB: 2_048,
        },
      });
      const bigResult = await service.assign({
        jobId: bigJob.id,
        strategy: PlacementStrategy.FIRST_FIT,
      });

      assert.equal(bigResult.selected?.workerId, large.id);
      assert.equal(bigResult.job.assignedWorkerId, large.id);
      assert.equal(bigResult.job.placementStrategy, PlacementStrategy.FIRST_FIT);
      assert.ok(bigResult.job.placedAt);
      assert.equal(bigResult.job.status, JobStatus.SCHEDULED);

      // Placement must not reserve resources; that is the reservation increment.
      const largeAfter = await prisma.worker.findUniqueOrThrow({ where: { id: large.id } });
      assert.equal(largeAfter.cpuAllocatedMillicores, 0);
      assert.equal(largeAfter.memoryAllocatedMiB, 0);
      assert.equal(await prisma.resourceAllocation.count({ where: { jobId: bigJob.id } }), 0);

      // The advisory load of the placed job now reduces available capacity.
      const afterPlacement = await service.capacity();
      const largeSnapshot = afterPlacement.find((worker) => worker.workerId === large.id);
      assert.equal(largeSnapshot?.cpuAssignedMillicores, 3_000);
      assert.equal(largeSnapshot?.cpuAvailableMillicores, 1_000);

      // Acceptance: a job that no worker can fit is refused and stays unplaced.
      const oversized = await prisma.job.create({
        data: {
          ...jobBase,
          name: `${prefix}-oversized`,
          cpuRequiredMillicores: 6_000,
          memoryRequiredMiB: 1_024,
        },
      });
      await assert.rejects(
        () => service.assign({ jobId: oversized.id, strategy: PlacementStrategy.RESOURCE_AWARE }),
        (error: unknown) => error instanceof Error && error.message.includes("No worker"),
      );
      const oversizedAfter = await prisma.job.findUniqueOrThrow({ where: { id: oversized.id } });
      assert.equal(oversizedAfter.assignedWorkerId, null);
      assert.equal(oversizedAfter.placedAt, null);

      // Concurrency: parallel placements of one job assign it exactly once.
      const contested = await prisma.job.create({
        data: {
          ...jobBase,
          name: `${prefix}-contested`,
          cpuRequiredMillicores: 500,
          memoryRequiredMiB: 256,
        },
      });
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          prismaPlacementRepository.assign({
            jobId: contested.id,
            workerId: small.id,
            strategy: PlacementStrategy.FIRST_FIT,
            placedAt: new Date(),
          }),
        ),
      );
      assert.equal(
        attempts.filter(Boolean).length,
        1,
        "exactly one concurrent placement may claim a job",
      );

      // Route contracts. These use the real global worker set, so the
      // unplaceable job must exceed the largest worker in the database.
      const unplaceable = await prisma.job.create({
        data: {
          ...jobBase,
          name: `${prefix}-unplaceable`,
          cpuRequiredMillicores: 64_000,
          memoryRequiredMiB: 1_024,
        },
      });

      await withServer(async (baseUrl) => {
        const capacityResponse = await fetch(`${baseUrl}/placement/capacity`);
        assert.equal(capacityResponse.status, 200);
        assert.ok(Array.isArray(await capacityResponse.json()));

        const previewResponse = await fetch(
          `${baseUrl}/placement/preview?jobId=${unplaceable.id}&strategy=LEAST_LOADED`,
        );
        const preview = (await previewResponse.json()) as { selected: unknown };
        assert.equal(previewResponse.status, 200);
        assert.equal(preview.selected, null, "a job larger than every worker has no placement");

        const refusedResponse = await fetch(`${baseUrl}/placement/assign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: unplaceable.id, strategy: "FIRST_FIT" }),
        });
        const refused = (await refusedResponse.json()) as { error: { code: string } };
        assert.equal(refusedResponse.status, 409);
        assert.equal(refused.error.code, "INSUFFICIENT_RESOURCES");

        const conflictResponse = await fetch(`${baseUrl}/placement/assign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: contested.id, strategy: "FIRST_FIT" }),
        });
        assert.equal(conflictResponse.status, 409, "an already placed job cannot be replaced");

        const invalidResponse = await fetch(`${baseUrl}/placement/assign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: contested.id, strategy: "BEST_FIT" }),
        });
        assert.equal(invalidResponse.status, 400);

        const missingResponse = await fetch(`${baseUrl}/placement/assign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: randomUUID(), strategy: "FIRST_FIT" }),
        });
        assert.equal(missingResponse.status, 404);
      });
    } finally {
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  },
);
