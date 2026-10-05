import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  SchedulingPolicy,
  WorkloadPattern,
} from "@prisma/client";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { generateWorkloadSpecs } from "./workload.generator.js";
import { prismaWorkloadRepository } from "./workload.repository.js";
const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}/api`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
async function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function comparableJobs(jobs) {
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
  "clear generated workload removes only unstarted batch jobs and is safe to repeat",
  { skip: !databaseTestsEnabled },
  async () => {
    const batchIds = [];
    let manualId;
    let workerId;
    try {
      await withServer(async (baseUrl) => {
        const generated = await post(baseUrl, "/workloads/generate", {
          seed: 1_900_010,
          count: 10,
          pattern: "CONSTANT",
          startAt: "2099-01-01T00:00:00.000Z",
        });
        assert.equal(generated.status, 201);
        const batch = await generated.json();
        batchIds.push(batch.id);
        const reusedResponse = await post(baseUrl, `/workloads/${batch.id}/reuse`, {});
        assert.equal(reusedResponse.status, 201);
        const reused = await reusedResponse.json();
        batchIds.push(reused.id);
        const worker = await prisma.worker.create({
          data: {
            name: `clear-generated-${batch.id.slice(0, 8)}`,
            cpuCapacityMillicores: 2000,
            memoryCapacityMiB: 1024,
          },
        });
        workerId = worker.id;
        const specs = {
          name: "manual-clear-generated-test",
          workloadType: "SLEEP",
          workloadSize: 1,
          cpuRequiredMillicores: 100,
          memoryRequiredMiB: 64,
          estimatedDurationSeconds: 1,
        };
        manualId = (await prisma.job.create({ data: specs })).id;
        const protectedJobs = batch.jobs.slice(0, 6);
        await prisma.job.update({
          where: { id: protectedJobs[0].id },
          data: { status: JobStatus.SCHEDULED },
        });
        await prisma.job.update({
          where: { id: protectedJobs[1].id },
          data: { status: JobStatus.RUNNING },
        });
        await prisma.job.update({
          where: { id: protectedJobs[2].id },
          data: { status: JobStatus.COMPLETED },
        });
        // A Round Robin job can be QUEUED again after it has executed.
        await prisma.job.update({
          where: { id: protectedJobs[3].id },
          data: {
            schedulingPolicy: SchedulingPolicy.ROUND_ROBIN,
            scheduledAt: new Date(),
            schedulingRounds: 1,
          },
        });
        await prisma.job.update({
          where: { id: protectedJobs[4].id },
          data: { assignedWorkerId: worker.id },
        });
        const allocation = await prisma.resourceAllocation.create({
          data: {
            jobId: protectedJobs[5].id,
            workerId: worker.id,
            cpuMillicores: 100,
            memoryMiB: 64,
            status: AllocationStatus.RELEASED,
            releasedAt: new Date(),
          },
        });
        await prisma.jobExecution.create({
          data: {
            jobId: protectedJobs[5].id,
            workerId: worker.id,
            allocationId: allocation.id,
            attempt: 1,
            status: ExecutionStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
        const cleared = await post(baseUrl, "/workloads/clear-generated", {});
        assert.equal(cleared.status, 200);
        assert.ok((await cleared.json()).deletedJobs >= 14);
        assert.deepEqual(
          (await prisma.job.findMany({ where: { workloadBatchId: batch.id } }))
            .map((job) => job.id).sort(),
          protectedJobs.map((job) => job.id).sort(),
        );
        assert.ok(await prisma.job.findUnique({ where: { id: manualId } }));
        assert.equal(await prisma.workloadBatch.findUnique({ where: { id: reused.id } }), null);
        assert.ok(await prisma.workloadBatch.findUnique({ where: { id: batch.id } }));
        assert.equal(await prisma.jobExecution.count({ where: { jobId: protectedJobs[5].id } }), 1);
        const repeated = await post(baseUrl, "/workloads/clear-generated", {});
        assert.equal(repeated.status, 200);
        assert.deepEqual(await repeated.json(), { deletedJobs: 0 });
      });
    } finally {
      const jobFilter = { workloadBatchId: { in: batchIds } };
      await prisma.jobExecution.deleteMany({ where: { job: jobFilter } });
      await prisma.resourceAllocation.deleteMany({ where: { job: jobFilter } });
      await prisma.job.deleteMany({ where: jobFilter });
      if (manualId) await prisma.job.deleteMany({ where: { id: manualId } });
      await prisma.workloadBatch.deleteMany({ where: { sourceBatchId: { in: batchIds } } });
      await prisma.workloadBatch.deleteMany({ where: { id: { in: batchIds } } });
      if (workerId) await prisma.worker.deleteMany({ where: { id: workerId } });
      await prisma.$disconnect();
    }
  },
);
test(
  "workload API persists deterministic batches, retrieves them, and reuses exact specs",
  { skip: !databaseTestsEnabled },
  async () => {
    const batchIds = [];
    const seed = 1_900_001;
    try {
      await withServer(async (baseUrl) => {
        const request = {
          seed,
          count: 10,
          pattern: "SUDDEN_BURST",
          startAt: "2026-09-21T12:00:00.000Z",
        };
        const firstResponse = await post(
          baseUrl,
          "/workloads/generate",
          request,
        );
        const first = await firstResponse.json();
        if (typeof first.id === "string") {
          batchIds.push(first.id);
        }
        assert.equal(firstResponse.status, 201);
        assert.equal(first.pattern, WorkloadPattern.BURST);
        assert.equal(first.jobs.length, 10);
        assert.ok(first.jobs.every((job) => job.status === JobStatus.QUEUED));
        const getResponse = await fetch(`${baseUrl}/workloads/${first.id}`);
        const fetched = await getResponse.json();
        assert.equal(getResponse.status, 200);
        assert.deepEqual(
          comparableJobs(fetched.jobs),
          comparableJobs(first.jobs),
        );
        const secondResponse = await post(
          baseUrl,
          "/workloads/generate",
          request,
        );
        const second = await secondResponse.json();
        if (typeof second.id === "string") {
          batchIds.push(second.id);
        }
        assert.equal(secondResponse.status, 201);
        assert.notEqual(second.id, first.id);
        assert.deepEqual(
          comparableJobs(second.jobs),
          comparableJobs(first.jobs),
        );
        const reuseResponse = await post(
          baseUrl,
          `/workloads/${first.id}/reuse`,
          {
            startAt: "2026-09-22T12:00:00.000Z",
          },
        );
        const reused = await reuseResponse.json();
        if (typeof reused.id === "string") {
          batchIds.push(reused.id);
        }
        assert.equal(reuseResponse.status, 201);
        assert.equal(reused.sourceBatchId, first.id);
        assert.deepEqual(
          comparableJobs(reused.jobs),
          comparableJobs(first.jobs),
        );
        const invalidResponse = await post(baseUrl, "/workloads/generate", {
          seed,
          count: 12,
          pattern: "LIGHT",
        });
        assert.equal(invalidResponse.status, 400);
        // The simplified dashboard sends type selection with IMMEDIATE directly.
        const immediateResponse = await post(baseUrl, "/workloads/generate", {
          seed, count: 10, pattern: "IMMEDIATE", workloadTypes: ["MATRIX_MULTIPLICATION"],
        });
        const immediate = await immediateResponse.json();
        if (typeof immediate.id === "string") batchIds.push(immediate.id);
        assert.equal(immediateResponse.status, 201);
        assert.equal(immediate.generatorVersion, "v2");
        assert.equal(immediate.pattern, WorkloadPattern.CUSTOM);
        assert.equal(immediate.parameters.arrivalPattern, "IMMEDIATE");
        assert.ok(immediate.jobs.every((job) => job.workloadType === "MATRIX_MULTIPLICATION" &&
          job.arrivalOffsetSeconds === 0 && job.workloadSize <= 271 && job.memoryRequiredMiB <= 256));
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
      assert.equal(
        await prisma.workloadBatch.count({ where: { seed: rollbackSeed } }),
        0,
      );
      assert.equal(
        await prisma.job.count({
          where: { name: { startsWith: `workload-${rollbackSeed}-` } },
        }),
        0,
      );
    } finally {
      await prisma.job.deleteMany({
        where: { workloadBatchId: { in: batchIds } },
      });
      await prisma.workloadBatch.deleteMany({
        where: { sourceBatchId: { in: batchIds } },
      });
      await prisma.workloadBatch.deleteMany({
        where: { id: { in: batchIds } },
      });
      await prisma.$disconnect();
    }
  },
);
