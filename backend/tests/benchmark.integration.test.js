import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { BenchmarkStatus, JobStatus, WorkloadType } from "@prisma/client";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { executionService } from "../src/modules/executions/execution.service.js";
import { prismaBenchmarkRepository } from "../src/modules/benchmarks/benchmark.repository.js";
import { BenchmarkService, benchmarkService } from "../src/modules/benchmarks/benchmark.service.js";
import { startBenchmarkSchema } from "../src/modules/benchmarks/benchmark.schemas.js";
import { ensureStudyWorkers } from "../src/modules/workers/worker.defaults.js";
import { workloadService } from "../src/modules/workloads/workload.service.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";
const dockerTestsEnabled = databaseTestsEnabled && process.env.RUN_DOCKER_TESTS === "true";

async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const suiteFields = (seed) => ({
  placementStrategy: "LEAST_LOADED",
  pattern: "IMMEDIATE",
  seed,
  jobCount: 2,
  workloadTypes: [WorkloadType.SLEEP],
  timeQuantumSeconds: 5,
  jobsPerTick: 25,
});

/** Removes suites, then the batches they measured, attempts first. */
async function cleanup(suiteIds, batchIds) {
  await prisma.benchmarkSuite.deleteMany({ where: { id: { in: suiteIds } } });
  const jobFilter = { workloadBatchId: { in: batchIds } };
  await prisma.jobExecution.deleteMany({ where: { job: jobFilter } });
  await prisma.resourceAllocation.deleteMany({ where: { job: jobFilter } });
  await prisma.job.deleteMany({ where: jobFilter });
  await prisma.workloadBatch.deleteMany({ where: { sourceBatchId: { in: batchIds } } });
  await prisma.workloadBatch.deleteMany({ where: { id: { in: batchIds } } });
}

test("the repository records a suite, its runs, and survives clearing the measured jobs",
  { skip: !databaseTestsEnabled }, async () => {
    const seed = 900_000 + Math.floor(Math.random() * 90_000);
    const suiteIds = [];
    const batchIds = [];
    try {
      const suite = await prismaBenchmarkRepository.createSuite(suiteFields(seed), ["FCFS", "SJF"]);
      suiteIds.push(suite.id);
      assert.equal(suite.status, BenchmarkStatus.RUNNING);
      assert.deepEqual(suite.runs.map((run) => [run.position, run.policy, run.status]),
        [[0, "FCFS", "PENDING"], [1, "SJF", "PENDING"]]);
      await assert.rejects(prisma.benchmarkRun.create({ data: {
        suiteId: suite.id, position: 2, policy: "FCFS",
      } }), "a policy appears once per suite");

      // A real batch, finished by hand, stands in for a run that drained.
      const batch = await workloadService.generate({ seed, count: 10, pattern: "IMMEDIATE",
        workloadTypes: [WorkloadType.SLEEP] });
      batchIds.push(batch.id);
      // Park the jobs so no live scheduler picks them up mid-test.
      await prisma.job.updateMany({ where: { workloadBatchId: batch.id }, data: { status: JobStatus.CANCELLED } });
      const capacity = await prismaBenchmarkRepository.readCapacity();
      assert.ok(capacity.workerCount >= 0 && capacity.cpuCapacityMillicores >= 0);
      await prismaBenchmarkRepository.startRun(suite.runs[0].id,
        { workloadBatchId: batch.id, capacity, jobCount: 10 });
      assert.deepEqual(await prismaBenchmarkRepository.batchProgress(batch.id),
        { total: 10, unfinished: 0, finished: 10 });
      const jobs = await prismaBenchmarkRepository.readBatchJobs(batch.id);
      assert.deepEqual(jobs.slice(0, 2).map((job) => job.batchSequence), [1, 2]);
      assert.ok(Array.isArray(jobs[0].executions));

      await prismaBenchmarkRepository.finishRun(suite.runs[0].id, BenchmarkStatus.COMPLETED, {
        completedJobs: 2, avgWaitSeconds: 1.5, makespanSeconds: 9, checksumDigest: "a".repeat(64),
      });
      await assert.rejects(prismaBenchmarkRepository.finishRun(suite.runs[0].id, BenchmarkStatus.COMPLETED,
        { avgWaitSeconds: -1 }), "the database refuses a negative timing");

      const finished = await prismaBenchmarkRepository.finishSuite(suite.id, BenchmarkStatus.ABORTED, "test stop");
      assert.equal(finished.status, BenchmarkStatus.ABORTED);
      assert.ok(finished.completedAt);
      assert.equal(finished.runs[0].status, BenchmarkStatus.COMPLETED, "a finished run keeps its result");
      assert.equal(finished.runs[1].status, BenchmarkStatus.ABORTED, "the run that never started says so");

      // Clearing history deletes the batch; the measured numbers stay.
      await prisma.job.deleteMany({ where: { workloadBatchId: batch.id } });
      await prisma.workloadBatch.delete({ where: { id: batch.id } });
      const kept = await prismaBenchmarkRepository.findSuite(suite.id);
      assert.equal(kept.runs[0].workloadBatchId, null);
      assert.equal(kept.runs[0].avgWaitSeconds, 1.5);
      assert.ok((await prismaBenchmarkRepository.listSuites(50)).some((entry) => entry.id === suite.id));
    } finally {
      await cleanup(suiteIds, batchIds);
      await prisma.$disconnect();
    }
  });

test("a suite left RUNNING by a dead process is marked aborted at boot",
  { skip: !databaseTestsEnabled }, async () => {
    const suiteIds = [];
    try {
      const suite = await prismaBenchmarkRepository.createSuite(suiteFields(1), ["PRIORITY"]);
      suiteIds.push(suite.id);
      assert.ok(await prismaBenchmarkRepository.abandonInterruptedSuites() >= 1);
      const stored = await prismaBenchmarkRepository.findSuite(suite.id);
      assert.equal(stored.status, BenchmarkStatus.ABORTED);
      assert.match(stored.failureReason, /restarted/);
      assert.equal(stored.runs[0].status, BenchmarkStatus.ABORTED);
    } finally {
      await cleanup(suiteIds, []);
      await prisma.$disconnect();
    }
  });

test("benchmark routes validate input and pipeline routes refuse work while a suite runs",
  { skip: !databaseTestsEnabled }, async () => {
    try {
      await withServer(async (baseUrl) => {
        const send = (method, path, body) => fetch(`${baseUrl}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const list = await fetch(`${baseUrl}/benchmarks`);
        const listBody = await list.json();
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(listBody.suites));
        assert.ok("activeSuiteId" in listBody);
        assert.equal((await fetch(`${baseUrl}/benchmarks?limit=0`)).status, 400);
        assert.equal((await fetch(`${baseUrl}/benchmarks/not-a-uuid`)).status, 400);
        assert.equal((await fetch(`${baseUrl}/benchmarks/${randomUUID()}`)).status, 404);
        assert.equal((await send("POST", "/benchmarks", { count: 7 })).status, 400);
        assert.equal((await send("POST", "/benchmarks", { policies: ["FCFS", "FCFS"] })).status, 400);
        const abort = await send("POST", `/benchmarks/${randomUUID()}/abort`, {});
        assert.equal(abort.status, 409);
        assert.equal((await abort.json()).error.code, "BENCHMARK_NOT_RUNNING");

        // Pretend a suite is running; the guard reads only this flag.
        benchmarkService.active = { suiteId: randomUUID(), abortRequested: false, progress: null };
        try {
          for (const [method, path, body] of [
            ["POST", "/jobs", { name: "blocked", workloadType: "SLEEP", workloadSize: 1 }],
            ["POST", "/orchestrator/run", { policy: "FCFS", strategy: "FIRST_FIT" }],
            ["POST", "/orchestrator/clear-finished", {}],
            ["POST", "/workloads/generate", { seed: 1, count: 10, pattern: "IMMEDIATE" }],
            ["POST", "/scheduler/dispatch", { policy: "FCFS" }],
            ["PATCH", "/autoscaler", { enabled: true }],
            ["POST", "/benchmarks", {}],
          ]) {
            const response = await send(method, path, body);
            assert.equal(response.status, 409, `${method} ${path}`);
            assert.equal((await response.json()).error.code, "BENCHMARK_RUNNING", `${method} ${path}`);
          }
          const reads = await fetch(`${baseUrl}/orchestrator/state?limit=1`);
          assert.equal(reads.status, 200, "reading state stays allowed");
        } finally {
          benchmarkService.active = null;
        }
      });
    } finally {
      await prisma.$disconnect();
    }
  });

test("a real two-policy benchmark runs the same containers under each policy",
  { skip: !dockerTestsEnabled, timeout: 10 * 60_000 }, async () => {
    const suiteIds = [];
    const batchIds = [];
    try {
      await ensureStudyWorkers(prisma);
      const service = new BenchmarkService(prismaBenchmarkRepository, { tickMs: 500 });
      const seed = 800_000 + Math.floor(Math.random() * 90_000);
      const started = await service.start(startBenchmarkSchema.parse({
        policies: ["FCFS", "ROUND_ROBIN"], count: 10, seed, timeQuantumSeconds: 3,
      }));
      suiteIds.push(started.id);
      await service.awaitCompletion();
      await executionService.awaitPendingSettlements();

      const suite = await service.get(started.id);
      batchIds.push(...suite.runs.map((run) => run.workloadBatchId).filter(Boolean));
      assert.equal(suite.status, BenchmarkStatus.COMPLETED,
        suite.failureReason ?? suite.runs.map((run) => run.failureReason).join(" | "));
      for (const run of suite.runs) {
        assert.equal(run.status, BenchmarkStatus.COMPLETED, run.failureReason ?? "");
        assert.equal(run.completedJobs, 10);
        assert.ok(run.avgTurnaroundSeconds > 0);
        assert.ok(run.makespanSeconds > 0);
        assert.match(run.checksumDigest, /^[0-9a-f]{64}$/);
      }
      assert.equal(suite.comparison.identicalWork, true, "every policy did byte-identical work");
      assert.equal(suite.comparison.fairCapacity, true);
      assert.equal(suite.comparison.comparable, true);
      const batches = await prisma.workloadBatch.findMany({ where: { id: { in: batchIds } } });
      assert.equal(batches.find((batch) => batch.id === suite.runs[1].workloadBatchId)?.sourceBatchId,
        suite.runs[0].workloadBatchId, "the second run reused the first run's batch");
      assert.equal(await prismaBenchmarkRepository.countUnfinishedJobs(), 0, "nothing was left behind");
    } finally {
      await cleanup(suiteIds, batchIds);
      await prisma.$disconnect();
    }
  });
