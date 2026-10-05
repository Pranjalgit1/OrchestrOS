import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../../lib/prisma.js";
import { resourceService } from "../resources/resource.service.js";
import { ensureStudyWorkers, STUDY_WORKERS } from "./worker.defaults.js";

test("study budgets update idle defaults and preserve an older active reservation", {
  skip: process.env.RUN_DATABASE_TESTS !== "true",
}, async () => {
  const saved = await prisma.worker.findMany({ where: { name: { in: STUDY_WORKERS.map((worker) => worker.name) } } });
  assert.equal(saved.length, 3, "Seed the test database before running integration tests");
  const worker = saved.find((entry) => entry.name === "worker-1");
  let job;
  try {
    await prisma.worker.update({ where: { id: worker.id }, data: {
      cpuCapacityMillicores: 2_000, memoryCapacityMiB: 2_048,
    } });
    job = await prisma.job.create({ data: {
      name: `study-defaults-${randomUUID()}`, workloadType: "SLEEP", workloadSize: 1,
      cpuRequiredMillicores: 1_000, memoryRequiredMiB: 1_024,
      estimatedDurationSeconds: 1, status: "SCHEDULED", assignedWorkerId: worker.id,
    } });
    await resourceService.reserve({ jobId: job.id });
    await ensureStudyWorkers(prisma);
    const busy = await prisma.worker.findUnique({ where: { id: worker.id } });
    assert.equal(busy.memoryCapacityMiB, 2_048);
    assert.equal(busy.memoryAllocatedMiB, 1_024);
    assert.equal(busy.cpuCapacityMillicores, 2_000);
    await resourceService.release({ jobId: job.id });
    await ensureStudyWorkers(prisma);
    await ensureStudyWorkers(prisma);
    for (const limits of STUDY_WORKERS) {
      const actual = await prisma.worker.findUnique({ where: { name: limits.name } });
      assert.equal(actual.memoryCapacityMiB, limits.memoryCapacityMiB);
      assert.equal(actual.cpuCapacityMillicores, limits.cpuCapacityMillicores);
      assert.equal(actual.memoryAllocatedMiB, 0);
      assert.equal(actual.cpuAllocatedMillicores, 0);
    }
  } finally {
    if (job) {
      await resourceService.release({ jobId: job.id });
      await prisma.resourceAllocation.deleteMany({ where: { jobId: job.id } });
      await prisma.job.delete({ where: { id: job.id } });
    }
    for (const original of saved) {
      await prisma.worker.update({ where: { id: original.id }, data: {
        cpuCapacityMillicores: original.cpuCapacityMillicores,
        memoryCapacityMiB: original.memoryCapacityMiB,
      } });
    }
    await prisma.$disconnect();
  }
});
