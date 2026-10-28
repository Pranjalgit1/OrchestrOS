import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after } from "node:test";
import { BenchmarkStatus, WorkerStatus, WorkloadType } from "@prisma/client";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { prismaScalingComparisonRepository as repository } from "../src/modules/scaling-comparisons/scaling-comparison.repository.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
after(() => prisma.$disconnect());

async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const fields = (seed) => ({
  schedulingPolicy: "FCFS",
  placementStrategy: "LEAST_LOADED",
  pattern: "INCREASING",
  seed,
  jobCount: 25,
  workloadTypes: [WorkloadType.SLEEP],
  timeQuantumSeconds: 5,
  jobsPerTick: 25,
  autoscalerSettings: { scaleUpQueueThreshold: 2, mlLookAheadSeconds: 60 },
});

const sample = (offsetSeconds, overrides = {}) => ({
  at: new Date(Date.now() + offsetSeconds * 1_000),
  offsetSeconds,
  queuedJobs: 2,
  workersInService: 4,
  extraWorkers: 1,
  idleExtraWorkers: 0,
  peakUtilization: 0.8,
  forecastQueuedJobs: 3.5,
  forecastPeak: 0.9,
  ...overrides,
});

test("a comparison stores both runs, their results, and their timelines in order",
  { skip: !databaseTestsEnabled }, async () => {
    const comparison = await repository.createComparison(fields(910_001), ["REACTIVE", "ML"]);
    try {
      assert.deepEqual(comparison.runs.map((run) => [run.position, run.strategy, run.status]),
        [[0, "REACTIVE", "PENDING"], [1, "ML", "PENDING"]]);
      await assert.rejects(prisma.scalingComparisonRun.create({
        data: { comparisonId: comparison.id, position: 2, strategy: "ML" },
      }), "a strategy runs once per comparison");

      const [reactive] = comparison.runs;
      await repository.startRun(reactive.id, {
        workloadBatchId: null, jobCount: 25, startedAt: new Date(),
        capacity: { workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072 },
      });
      await repository.finishRun(reactive.id, BenchmarkStatus.COMPLETED, {
        completedJobs: 25, avgWaitSeconds: 12.5, reactionSeconds: -3, extraWorkerSeconds: 120,
        scaleUps: 2, scalingActions: [{ at: new Date().toISOString(), action: "SCALE_UP" }],
      }, null, [sample(4), sample(0), sample(2, { forecastQueuedJobs: null, forecastPeak: null })]);

      const stored = await repository.findComparison(comparison.id);
      const run = stored.runs[0];
      assert.equal(run.status, "COMPLETED");
      assert.equal(run.reactionSeconds, -3, "reaction time may be negative");
      assert.deepEqual(run.samples.map((entry) => entry.offsetSeconds), [0, 2, 4], "the timeline reads in time order");
      assert.equal(run.samples[1].forecastQueuedJobs, null);
      assert.equal(stored.runs[1].samples.length, 0);

      const finished = await repository.finishComparison(comparison.id, BenchmarkStatus.ABORTED, "Stopped");
      assert.equal(finished.runs[1].status, "ABORTED", "a run that never finished is marked, not left pending");
      assert.equal((await repository.listComparisons(50)).some((entry) => entry.id === comparison.id), true);
    } finally {
      await prisma.scalingComparison.delete({ where: { id: comparison.id } });
    }
    assert.equal(await prisma.scalingComparisonSample.count({ where: { run: { comparisonId: comparison.id } } }), 0,
      "deleting a comparison removes its runs and samples");
  });

test("database checks refuse impossible results and timelines",
  { skip: !databaseTestsEnabled }, async () => {
    const comparison = await repository.createComparison(fields(910_002), ["REACTIVE", "ML"]);
    try {
      const runId = comparison.runs[0].id;
      await assert.rejects(prisma.scalingComparisonSample.create({
        data: { runId, ...sample(0, { extraWorkers: 1, idleExtraWorkers: 2 }) },
      }), "more idle extra workers than extra workers");
      await assert.rejects(prisma.scalingComparisonSample.create({
        data: { runId, ...sample(0, { peakUtilization: 1.5 }) },
      }), "utilization above 100%");
      await assert.rejects(prisma.scalingComparisonRun.update({
        where: { id: runId }, data: { extraWorkerSeconds: -1 },
      }), "negative worker time");
      await assert.rejects(prisma.scalingComparison.create({ data: { ...fields(910_003), jobCount: 0 } }));
    } finally {
      await prisma.scalingComparison.delete({ where: { id: comparison.id } });
    }
  });

test("resetting retires only empty autoscaled workers, and load reads schedulable workers",
  { skip: !databaseTestsEnabled }, async () => {
    const suffix = randomUUID().slice(0, 8);
    const empty = await prisma.worker.create({ data: {
      name: `auto-worker-test-${suffix}`, cpuCapacityMillicores: 500, memoryCapacityMiB: 256, autoscaled: true,
    } });
    const busy = await prisma.worker.create({ data: {
      name: `auto-worker-busy-${suffix}`, cpuCapacityMillicores: 500, memoryCapacityMiB: 256, autoscaled: true,
      cpuAllocatedMillicores: 100, memoryAllocatedMiB: 64, status: WorkerStatus.BUSY,
    } });
    try {
      const before = await repository.readLoad(new Date());
      assert.ok(before.workers.some((worker) => worker.autoscaled), "extra workers count while in service");
      const { retired, remaining } = await repository.retireAutoscaledWorkers();
      assert.ok(retired >= 1);
      assert.equal(remaining >= 1, true, "a worker holding capacity is not retired");
      assert.equal((await prisma.worker.findUnique({ where: { id: empty.id } })).status, WorkerStatus.RETIRED);
      assert.equal((await prisma.worker.findUnique({ where: { id: busy.id } })).status, WorkerStatus.BUSY);
      const after = await repository.readLoad(new Date());
      assert.equal(after.workers.some((worker) => worker.autoscaled && worker.cpuAllocatedMillicores === 0), false);
    } finally {
      await prisma.worker.deleteMany({ where: { id: { in: [empty.id, busy.id] } } });
    }
  });

test("the API lists comparisons, validates a start, and 404s an unknown one",
  { skip: !databaseTestsEnabled }, async () => {
    await withServer(async (base) => {
      const list = await fetch(`${base}/scaling-comparisons`);
      assert.equal(list.status, 200);
      const body = await list.json();
      assert.equal(body.activeComparisonId, null);
      assert.ok(Array.isArray(body.comparisons));
      const invalid = await fetch(`${base}/scaling-comparisons`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 7 }),
      });
      assert.equal(invalid.status, 400);
      const missing = await fetch(`${base}/scaling-comparisons/${randomUUID()}`);
      assert.equal(missing.status, 404);
    });
  });

test("a comparison left RUNNING by a dead process is aborted and its leftover jobs are cancelled",
  { skip: !databaseTestsEnabled }, async () => {
    const { workloadService } = await import("../src/modules/workloads/workload.service.js");
    const { jobService } = await import("../src/modules/jobs/job.service.js");
    const comparison = await repository.createComparison(fields(910_004), ["REACTIVE", "ML"]);
    const batch = await workloadService.generate({ seed: 910_004, count: 10, pattern: "IMMEDIATE",
      workloadTypes: [WorkloadType.SLEEP] });
    try {
      await repository.startRun(comparison.runs[0].id, {
        workloadBatchId: batch.id, jobCount: 10, startedAt: new Date(),
        capacity: { workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072 },
      });
      const result = await repository.abandonInterrupted((id) => jobService.cancel(id));
      assert.ok(result.comparisons >= 1);
      assert.ok(result.cancelledJobs >= 10);
      const stored = await repository.findComparison(comparison.id);
      assert.equal(stored.status, "ABORTED");
      assert.match(stored.failureReason, /restarted/);
      const statuses = await prisma.job.groupBy({ by: ["status"], where: { workloadBatchId: batch.id }, _count: { _all: true } });
      assert.deepEqual(statuses.map((group) => [group.status, group._count._all]), [["CANCELLED", 10]],
        "nothing from the interrupted run is left in the queue");
    } finally {
      await prisma.scalingComparison.delete({ where: { id: comparison.id } });
      await prisma.job.deleteMany({ where: { workloadBatchId: batch.id } });
      await prisma.workloadBatch.delete({ where: { id: batch.id } });
    }
  });
