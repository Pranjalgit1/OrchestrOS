import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { JobStatus, WorkloadPattern } from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { generateWorkloadSpecs } from "./workload.generator.js";
import { prismaWorkloadRepository } from "./workload.repository.js";

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

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function comparableJobs(jobs: Array<Record<string, unknown>>): unknown[] {
  return jobs.map((job) => ({
    name: job.name,
    workloadType: job.workloadType,
    workloadSize: job.workloadSize,
    cpuRequiredMillicores: job.cpuRequiredMillicores,
    memoryRequiredMiB: job.memoryRequiredMiB,
    estimatedDurationSeconds: job.estimatedDurationSeconds,
    priority: job.priority,
    batchSequence: job.batchSequence,
    arrivalOffsetSeconds: job.arrivalOffsetSeconds,
  }));
}

test(
  "workload API persists deterministic batches, retrieves them, and reuses exact specs",
  { skip: !databaseTestsEnabled },
  async () => {
    const batchIds: string[] = [];
    const seed = 1_900_001;

    try {
      await withServer(async (baseUrl) => {
        const request = {
          seed,
          count: 10,
          pattern: "SUDDEN_BURST",
          startAt: "2026-09-21T12:00:00.000Z",
        } as const;
        const firstResponse = await post(baseUrl, "/workloads/generate", request);
        const first = (await firstResponse.json()) as {
          id: string;
          pattern: WorkloadPattern;
          jobs: Array<Record<string, unknown>>;
        };
        if (typeof first.id === "string") {
          batchIds.push(first.id);
        }

        assert.equal(firstResponse.status, 201);
        assert.equal(first.pattern, WorkloadPattern.BURST);
        assert.equal(first.jobs.length, 10);
        assert.ok(first.jobs.every((job) => job.status === JobStatus.QUEUED));

        const getResponse = await fetch(`${baseUrl}/workloads/${first.id}`);
        const fetched = (await getResponse.json()) as typeof first;
        assert.equal(getResponse.status, 200);
        assert.deepEqual(comparableJobs(fetched.jobs), comparableJobs(first.jobs));

        const secondResponse = await post(baseUrl, "/workloads/generate", request);
        const second = (await secondResponse.json()) as typeof first;
        if (typeof second.id === "string") {
          batchIds.push(second.id);
        }
        assert.equal(secondResponse.status, 201);
        assert.notEqual(second.id, first.id);
        assert.deepEqual(comparableJobs(second.jobs), comparableJobs(first.jobs));

        const reuseResponse = await post(baseUrl, `/workloads/${first.id}/reuse`, {
          startAt: "2026-09-22T12:00:00.000Z",
        });
        const reused = (await reuseResponse.json()) as typeof first & { sourceBatchId: string };
        if (typeof reused.id === "string") {
          batchIds.push(reused.id);
        }
        assert.equal(reuseResponse.status, 201);
        assert.equal(reused.sourceBatchId, first.id);
        assert.deepEqual(comparableJobs(reused.jobs), comparableJobs(first.jobs));

        const invalidResponse = await post(baseUrl, "/workloads/generate", {
          seed,
          count: 12,
          pattern: "LIGHT",
        });
        assert.equal(invalidResponse.status, 400);
      });

      const rollbackSeed = seed + 1;
      const duplicateSequence = generateWorkloadSpecs({
        seed: rollbackSeed,
        count: 10,
        pattern: WorkloadPattern.LIGHT,
      });
      const secondJob = duplicateSequence[1];
      if (!secondJob) throw new Error("Expected generated job");
      duplicateSequence[1] = { ...secondJob, sequence: 1 };

      await assert.rejects(() =>
        prismaWorkloadRepository.createBatch({
          seed: rollbackSeed,
          jobCount: 10,
          pattern: WorkloadPattern.LIGHT,
          generatorVersion: "v1",
          parameters: { contract: "rollback-test" },
          startsAt: new Date("2026-09-21T12:00:00.000Z"),
          jobs: duplicateSequence,
        }),
      );
      assert.equal(await prisma.workloadBatch.count({ where: { seed: rollbackSeed } }), 0);
      assert.equal(
        await prisma.job.count({ where: { name: { startsWith: `workload-${rollbackSeed}-` } } }),
        0,
      );
    } finally {
      await prisma.job.deleteMany({ where: { workloadBatchId: { in: batchIds } } });
      await prisma.workloadBatch.deleteMany({ where: { sourceBatchId: { in: batchIds } } });
      await prisma.workloadBatch.deleteMany({ where: { id: { in: batchIds } } });
      await prisma.$disconnect();
    }
  },
);
