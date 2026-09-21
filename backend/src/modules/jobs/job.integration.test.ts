import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { AllocationStatus, JobStatus, WorkloadType, WorkerStatus } from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";

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

async function postJson(baseUrl: string, path: string, body?: unknown): Promise<Response> {
  if (body === undefined) {
    return fetch(`${baseUrl}${path}`, { method: "POST" });
  }

  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "Phase 1 HTTP and PostgreSQL contracts work together",
  { skip: !databaseTestsEnabled },
  async () => {
    const suffix = randomUUID();
    const prefix = `integration-${suffix}`;
    let workerId: string | undefined;

    try {
      await withServer(async (baseUrl) => {
        const seededWorkersResponse = await fetch(`${baseUrl}/workers`);
        const seededWorkers = (await seededWorkersResponse.json()) as Array<{ id: string; name: string }>;
        assert.equal(seededWorkersResponse.status, 200);
        assert.ok(seededWorkers.some((worker) => worker.name === "worker-1"));

        const createJobResponse = await postJson(baseUrl, "/jobs", {
          name: `${prefix}-cancel-job`,
          workloadType: WorkloadType.SORTING,
          cpuRequiredMillicores: 500,
          memoryRequiredMiB: 256,
          estimatedDurationSeconds: 5,
          priority: 6,
        });
        const cancellationJob = (await createJobResponse.json()) as { id: string; status: JobStatus };
        assert.equal(createJobResponse.status, 201);
        assert.equal(cancellationJob.status, JobStatus.QUEUED);

        const cancellationResponses = await Promise.all([
          postJson(baseUrl, `/jobs/${cancellationJob.id}/cancel`),
          postJson(baseUrl, `/jobs/${cancellationJob.id}/cancel`),
        ]);
        assert.deepEqual(cancellationResponses.map((response) => response.status), [200, 200]);
        const cancelledJobs = await Promise.all(
          cancellationResponses.map((response) => response.json() as Promise<{ status: JobStatus }>),
        );
        assert.ok(cancelledJobs.every((job) => job.status === JobStatus.CANCELLED));

        const workerName = `${prefix}-worker`;
        const workerResponse = await postJson(baseUrl, "/workers", {
          name: workerName,
          cpuCapacityMillicores: 2_000,
          memoryCapacityMiB: 2_048,
        });
        const worker = (await workerResponse.json()) as { id: string; status: WorkerStatus };
        workerId = worker.id;
        assert.equal(workerResponse.status, 201);
        assert.equal(worker.status, WorkerStatus.IDLE);

        const duplicateWorkerResponse = await postJson(baseUrl, "/workers", {
          name: workerName,
          cpuCapacityMillicores: 2_000,
          memoryCapacityMiB: 2_048,
        });
        assert.equal(duplicateWorkerResponse.status, 409);

        const allocationJob = await prisma.job.create({
          data: {
            name: `${prefix}-allocation-job`,
            workloadType: WorkloadType.CPU_INTENSIVE,
            status: JobStatus.QUEUED,
            cpuRequiredMillicores: 500,
            memoryRequiredMiB: 256,
            estimatedDurationSeconds: 5,
            priority: 5,
          },
        });
        const seededWorker = await prisma.worker.findUniqueOrThrow({ where: { name: "worker-1" } });
        const allocation = await prisma.resourceAllocation.create({
          data: {
            jobId: allocationJob.id,
            workerId: seededWorker.id,
            cpuMillicores: 500,
            memoryMiB: 256,
            status: AllocationStatus.RESERVED,
          },
        });

        await assert.rejects(() =>
          prisma.resourceAllocation.create({
            data: {
              jobId: allocationJob.id,
              workerId: worker.id,
              cpuMillicores: 500,
              memoryMiB: 256,
              status: AllocationStatus.RESERVED,
            },
          }),
        );

        await assert.rejects(() =>
          prisma.jobExecution.create({
            data: {
              jobId: allocationJob.id,
              workerId: worker.id,
              allocationId: allocation.id,
              attempt: 1,
            },
          }),
        );

        const validExecution = await prisma.jobExecution.create({
          data: {
            jobId: allocationJob.id,
            workerId: seededWorker.id,
            allocationId: allocation.id,
            attempt: 1,
          },
        });
        assert.equal(validExecution.allocationId, allocation.id);

        await assert.rejects(() =>
          prisma.worker.update({
            where: { id: worker.id },
            data: { cpuAllocatedMillicores: 2_001 },
          }),
        );
      });
    } finally {
      await prisma.jobExecution.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
      await prisma.resourceAllocation.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      if (workerId) {
        await prisma.worker.deleteMany({ where: { id: workerId } });
      }
      await prisma.$disconnect();
    }
  },
);
