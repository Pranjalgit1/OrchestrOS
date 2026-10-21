import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { JobStatus, WorkerStatus, WorkloadType } from "@prisma/client";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { ScaleAction } from "../src/modules/autoscaler/autoscaler.policy.js";
import { prismaAutoscalerRepository } from "../src/modules/autoscaler/autoscaler.repository.js";
import { prismaPlacementRepository } from "../src/modules/placement/placement.repository.js";
import { prismaResourceRepository } from "../src/modules/resources/resource.repository.js";
const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
const signals = { queuedJobs: 3, utilization: { cpu: 0.9, memory: 0.5, peak: 0.9 },
  workerCount: 3, autoscaledWorkers: 0 };
function upDecision(workerName, reuseWorkerId = null) {
  return { action: ScaleAction.SCALE_UP, reason: "test pressure", workerName, reuseWorkerId, signals };
}
function downDecision(worker) {
  return { action: ScaleAction.SCALE_DOWN, reason: "test idle", workerId: worker.id,
    workerName: worker.name, signals };
}
async function cleanup(prefix) {
  await prisma.scalingEvent.deleteMany({ where: { workerName: { startsWith: prefix } } });
  await prisma.resourceAllocation.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
}
test("scaling up creates an autoscaled worker and records why in the same transaction",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `as-up-${randomUUID().slice(0, 8)}`;
    try {
      const outcome = await prismaAutoscalerRepository.scaleUp(upDecision(`${prefix}-a`),
        { cpuMillicores: 1_000, memoryMiB: 512 });
      assert.equal(outcome.status, "SCALED");
      assert.equal(outcome.worker.autoscaled, true);
      assert.equal(outcome.worker.status, WorkerStatus.IDLE);
      assert.equal(outcome.event.action, "SCALE_UP");
      assert.equal(outcome.event.workerId, outcome.worker.id);
      assert.equal(outcome.event.cpuUtilization, 0.9);
      const duplicate = await prismaAutoscalerRepository.scaleUp(upDecision(`${prefix}-a`),
        { cpuMillicores: 1_000, memoryMiB: 512 });
      assert.equal(duplicate.status, "STALE", "a name collision is a stale decision, not a crash");
      const snapshot = await prismaAutoscalerRepository.readSnapshot(new Date());
      const listed = snapshot.workers.find((entry) => entry.id === outcome.worker.id);
      assert.equal(listed.reservedAllocations, 0);
      assert.equal(listed.activeAssignedJobs, 0);
      assert.ok(snapshot.autoscaledNames.includes(`${prefix}-a`));
      assert.ok(snapshot.lastActionAt instanceof Date);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("a busy autoscaled worker is never retired, an idle one is, and it can come back",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `as-down-${randomUUID().slice(0, 8)}`;
    try {
      const { worker } = await prismaAutoscalerRepository.scaleUp(upDecision(`${prefix}-w`),
        { cpuMillicores: 1_000, memoryMiB: 512 });
      const job = await prisma.job.create({ data: {
        name: `${prefix}-job`, workloadType: WorkloadType.SLEEP, workloadSize: 1,
        status: JobStatus.SCHEDULED, cpuRequiredMillicores: 500, memoryRequiredMiB: 128,
        estimatedDurationSeconds: 2, priority: 5, schedulingPolicy: "FCFS", scheduledAt: new Date(),
        assignedWorkerId: worker.id, placementStrategy: "FIRST_FIT", placedAt: new Date(),
      } });
      assert.equal((await prismaAutoscalerRepository.scaleDown(downDecision(worker))).status, "BUSY",
        "a planned job keeps the worker in service");
      const reserved = await prismaResourceRepository.reserve({ jobId: job.id, workerId: worker.id,
        cpuMillicores: 500, memoryMiB: 128 });
      assert.equal(reserved.status, "RESERVED");
      await prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.COMPLETED } });
      assert.equal((await prismaAutoscalerRepository.scaleDown(downDecision(worker))).status, "BUSY",
        "a live reservation keeps the worker in service");
      await prismaResourceRepository.release(job.id);
      const retired = await prismaAutoscalerRepository.scaleDown(downDecision(worker));
      assert.equal(retired.status, "SCALED");
      assert.equal(retired.worker.status, WorkerStatus.RETIRED);
      assert.equal(retired.event.action, "SCALE_DOWN");
      assert.equal((await prismaAutoscalerRepository.scaleDown(downDecision(worker))).status, "STALE");
      // The database refuses to strand capacity on a retired worker.
      await assert.rejects(() => prisma.worker.update({ where: { id: worker.id },
        data: { cpuAllocatedMillicores: 100 } }));
      const snapshot = await prismaAutoscalerRepository.readSnapshot(new Date());
      assert.ok(snapshot.retiredAutoscaled.some((entry) => entry.id === worker.id));
      assert.ok(!snapshot.workers.some((entry) => entry.id === worker.id));
      const placementWorkers = await prismaPlacementRepository.listWorkers();
      assert.ok(!placementWorkers.some((entry) => entry.id === worker.id),
        "a retired worker is not a placement candidate");
      const revived = await prismaAutoscalerRepository.scaleUp(upDecision(worker.name, worker.id),
        { cpuMillicores: 1_500, memoryMiB: 768 });
      assert.equal(revived.status, "SCALED");
      assert.equal(revived.worker.id, worker.id, "the retired worker is reused, not duplicated");
      assert.equal(revived.worker.status, WorkerStatus.IDLE);
      assert.equal(revived.worker.cpuCapacityMillicores, 1_500);
      assert.equal(await prisma.scalingEvent.count({ where: { workerId: worker.id } }), 3);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("reserving on a worker that left service withdraws the placement",
  { skip: !databaseTestsEnabled }, async () => {
    const prefix = `as-guard-${randomUUID().slice(0, 8)}`;
    try {
      const worker = await prisma.worker.create({ data: { name: `${prefix}-w`,
        cpuCapacityMillicores: 1_000, memoryCapacityMiB: 512, autoscaled: true,
        status: WorkerStatus.RETIRED } });
      const job = await prisma.job.create({ data: {
        name: `${prefix}-job`, workloadType: WorkloadType.SLEEP, workloadSize: 1,
        status: JobStatus.SCHEDULED, cpuRequiredMillicores: 500, memoryRequiredMiB: 128,
        estimatedDurationSeconds: 2, priority: 5, schedulingPolicy: "FCFS", scheduledAt: new Date(),
        assignedWorkerId: worker.id, placementStrategy: "FIRST_FIT", placedAt: new Date(),
      } });
      const outcome = await prismaResourceRepository.reserve({ jobId: job.id, workerId: worker.id,
        cpuMillicores: 500, memoryMiB: 128 });
      assert.equal(outcome.status, "WORKER_NOT_SCHEDULABLE");
      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(stored.status, JobStatus.SCHEDULED);
      assert.equal(stored.assignedWorkerId, null, "the job can be placed again");
      assert.equal(stored.placedAt, null);
      const untouched = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
      assert.equal(untouched.cpuAllocatedMillicores, 0);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  });
test("the autoscaler API reports status, validates settings, and evaluates on demand",
  { skip: !databaseTestsEnabled }, async () => {
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/autoscaler`;
    const patch = (body) => fetch(base, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const status = await (await fetch(base)).json();
      assert.equal(typeof status.config.enabled, "boolean");
      assert.ok(Array.isArray(status.events));
      const refused = await patch({ scaleDownUtilization: 0.9 });
      assert.equal(refused.status, 400);
      assert.equal((await refused.json()).error.code, "INVALID_AUTOSCALER_CONFIG");
      assert.equal((await patch({ shell: "rm" })).status, 400);
      const off = await (await patch({ enabled: false, maxWorkers: 0 })).json();
      assert.equal(off.config.enabled, false);
      const evaluation = await (await fetch(`${base}/evaluate`, { method: "POST" })).json();
      assert.ok(["NONE", "SCALE_DOWN"].includes(evaluation.action),
        "a disabled autoscaler never adds workers");
      assert.ok(evaluation.signals.workerCount >= 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await prisma.$disconnect();
    }
  });
