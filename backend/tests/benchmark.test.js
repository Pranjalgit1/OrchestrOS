import assert from "node:assert/strict";
import test from "node:test";
import { BenchmarkStatus, JobStatus, SchedulingPolicy } from "@prisma/client";
import { AppError } from "../src/errors/app-error.js";
import { rejectWhileBenchmarking } from "../src/modules/benchmarks/benchmark.guard.js";
import {
  checksumDigest,
  comparePolicies,
  measureBatch,
  percentile,
} from "../src/modules/benchmarks/benchmark.metrics.js";
import {
  ALL_POLICIES,
  startBenchmarkSchema,
} from "../src/modules/benchmarks/benchmark.schemas.js";
import { BenchmarkService, benchmarkService } from "../src/modules/benchmarks/benchmark.service.js";

const t0 = new Date("2026-10-22T10:00:00.000Z");
const at = (seconds) => new Date(t0.getTime() + seconds * 1_000);

// ---------------------------------------------------------------- metrics

test("percentile interpolates linearly, matching the monitoring SQL", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  // position 0.95 * 9 = 8.55 between 9 and 10
  assert.ok(Math.abs(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0.95) - 9.55) < 1e-9);
});

test("measureBatch computes waiting, turnaround, response, makespan, and throughput", () => {
  const jobs = [
    {
      status: JobStatus.COMPLETED, batchSequence: 1, arrivalAt: at(0), completedAt: at(10),
      preemptionCount: 0, retryCount: 0, result: { checksum: "aaaaaaaa" },
      executions: [{ startedAt: at(2), completedAt: at(10) }],
    },
    {
      // Preempted once: ran 0-3 and 8-12, so waited 12 - 7 = 5 seconds.
      status: JobStatus.COMPLETED, batchSequence: 2, arrivalAt: at(0), completedAt: at(12),
      preemptionCount: 1, retryCount: 0, result: { checksum: "bbbbbbbb" },
      executions: [{ startedAt: at(0), completedAt: at(3) }, { startedAt: at(8), completedAt: at(12) }],
    },
  ];
  const metrics = measureBatch(jobs);
  assert.equal(metrics.jobCount, 2);
  assert.equal(metrics.completedJobs, 2);
  assert.equal(metrics.avgWaitSeconds, 3.5); // (2 + 5) / 2
  assert.equal(metrics.avgTurnaroundSeconds, 11);
  assert.equal(metrics.avgResponseSeconds, 1); // (2 + 0) / 2
  assert.equal(metrics.makespanSeconds, 12);
  assert.equal(metrics.throughputPerMinute, 10); // 2 jobs in 12 s
  assert.equal(metrics.preemptions, 1);
  assert.equal(metrics.checksumDigest, checksumDigest([
    { sequence: 2, checksum: "bbbbbbbb" },
    { sequence: 1, checksum: "aaaaaaaa" },
  ]), "the digest does not depend on completion order");
});

test("measureBatch leaves failures out of timings and refuses a digest over partial work", () => {
  const metrics = measureBatch([
    {
      status: JobStatus.COMPLETED, batchSequence: 1, arrivalAt: at(0), completedAt: at(4),
      result: { checksum: "aaaaaaaa" }, executions: [{ startedAt: at(1), completedAt: at(4) }],
    },
    { status: JobStatus.FAILED, batchSequence: 2, arrivalAt: at(0), completedAt: at(2), executions: [] },
    { status: JobStatus.CANCELLED, batchSequence: 3, arrivalAt: at(0), completedAt: null, executions: [] },
  ]);
  assert.equal(metrics.completedJobs, 1);
  assert.equal(metrics.failedJobs, 1);
  assert.equal(metrics.cancelledJobs, 1);
  assert.equal(metrics.avgTurnaroundSeconds, 4);
  assert.equal(metrics.checksumDigest, null);
  assert.equal(measureBatch([]).avgWaitSeconds, null);
});

function finishedRun(policy, overrides = {}) {
  return {
    policy, status: "COMPLETED", workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072,
    checksumDigest: "d", avgWaitSeconds: 5, p95WaitSeconds: 9, avgTurnaroundSeconds: 15,
    p95TurnaroundSeconds: 20, avgResponseSeconds: 5, makespanSeconds: 30, throughputPerMinute: 20,
    preemptions: 0, ...overrides,
  };
}

test("comparePolicies picks the best per metric and treats a full tie as no winner", () => {
  const comparison = comparePolicies([
    finishedRun("FCFS", { avgWaitSeconds: 8, throughputPerMinute: 18 }),
    finishedRun("SJF", { avgWaitSeconds: 4, throughputPerMinute: 22 }),
    finishedRun("ROUND_ROBIN", { avgWaitSeconds: 4.0004, preemptions: 6 }),
  ]);
  const metric = (key) => comparison.metrics.find((entry) => entry.key === key);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(metric("avgWaitSeconds").best, ["SJF", "ROUND_ROBIN"], "sub-millisecond gaps tie");
  assert.deepEqual(metric("throughputPerMinute").best, ["SJF"], "higher is better for throughput");
  assert.deepEqual(metric("makespanSeconds").best, [], "everyone tied, so nobody wins");
  assert.deepEqual(metric("preemptions").best, ["FCFS", "SJF"]);
  assert.deepEqual(comparison.notes, []);
});

test("comparePolicies says when runs are not comparable", () => {
  const comparison = comparePolicies([
    finishedRun("FCFS"),
    finishedRun("SJF", { workerCount: 4, checksumDigest: "other" }),
    { policy: "PRIORITY", status: "FAILED" },
  ]);
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.fairCapacity, false);
  assert.equal(comparison.identicalWork, false);
  assert.equal(comparison.finishedRuns, 2);
  assert.equal(comparison.notes.length, 3);
  assert.deepEqual(comparePolicies([finishedRun("FCFS")]).metrics[0].best, [],
    "one run has nothing to beat");
});

// ---------------------------------------------------------------- schemas

test("the start schema fills in a full four-policy suite and rejects unsafe input", () => {
  const defaults = startBenchmarkSchema.parse({});
  assert.deepEqual(defaults.policies, ALL_POLICIES);
  assert.equal(defaults.count, 10);
  assert.equal(defaults.pattern, "IMMEDIATE");
  assert.equal(defaults.jobsPerTick, 25);
  for (const body of [
    { policies: ["FCFS", "FCFS"] },
    { policies: [] },
    { count: 11 },
    { pattern: "CUSTOM" },
    { jobsPerTick: 0 },
    { unexpected: true },
  ]) {
    assert.equal(startBenchmarkSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------- service with fakes

class FakeRepository {
  unfinished = 0;
  capacity = { workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072 };
  suite = null;
  batches = new Map();
  finishedRuns = [];

  async countUnfinishedJobs() { return this.unfinished; }
  async readCapacity() { return { ...this.capacity }; }
  async createSuite(suite, policies) {
    this.suite = {
      id: "00000000-0000-4000-8000-000000000001",
      ...suite,
      status: BenchmarkStatus.RUNNING,
      runs: policies.map((policy, position) => ({
        id: `run-${position}`, policy, position, status: BenchmarkStatus.PENDING,
      })),
    };
    return structuredClone(this.suite);
  }
  run(id) { return this.suite.runs.find((entry) => entry.id === id); }
  async startRun(id, { workloadBatchId, capacity, jobCount }) {
    Object.assign(this.run(id), { status: BenchmarkStatus.RUNNING, workloadBatchId, jobCount, ...capacity });
  }
  async finishRun(id, status, metrics, failureReason = null) {
    Object.assign(this.run(id), { status, failureReason, ...metrics });
    this.finishedRuns.push({ id, status, failureReason });
  }
  async finishSuite(id, status, failureReason = null) {
    for (const run of this.suite.runs) {
      if (run.status === BenchmarkStatus.PENDING || run.status === BenchmarkStatus.RUNNING) {
        run.status = BenchmarkStatus.ABORTED;
      }
    }
    Object.assign(this.suite, { status, failureReason });
    return this.suite;
  }
  async batchProgress(batchId) {
    const jobs = this.batches.get(batchId) ?? [];
    const unfinished = jobs.filter((job) =>
      ![JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED].includes(job.status)).length;
    return { total: jobs.length, unfinished, finished: jobs.length - unfinished };
  }
  async readBatchJobs(batchId) { return this.batches.get(batchId) ?? []; }
  async findSuite() { return this.suite; }
  async listSuites() { return this.suite ? [this.suite] : []; }
}

class FakeWorkloads {
  calls = [];
  constructor(repository) { this.repository = repository; }
  makeBatch(count) {
    // Called after the request is logged, so the first batch is batch-0.
    const id = `batch-${this.calls.length - 1}`;
    const jobs = Array.from({ length: count }, (_, index) => ({
      status: JobStatus.QUEUED, batchSequence: index + 1, arrivalAt: at(0), completedAt: null,
      preemptionCount: 0, retryCount: 0, result: null, executions: [],
    }));
    this.repository.batches.set(id, jobs);
    return { id, jobs };
  }
  async generate(input) { this.calls.push({ kind: "generate", input }); return this.makeBatch(input.count); }
  async reuse(id, input) { this.calls.push({ kind: "reuse", id, input }); return this.makeBatch(3); }
}

/** Completes every queued job in every batch on each run() call, unless a script says otherwise. */
class FakeOrchestrator {
  requests = [];
  killed = 0;
  script = [];
  constructor(repository) { this.repository = repository; }
  async run(request) {
    this.requests.push(request);
    const next = this.script.shift();
    if (next) return next(request);
    for (const jobs of this.repository.batches.values()) {
      jobs.forEach((job, index) => {
        if (job.status !== JobStatus.QUEUED) return;
        job.status = JobStatus.COMPLETED;
        job.completedAt = at(10 + index);
        job.executions = [{ startedAt: at(index), completedAt: at(10 + index) }];
        job.result = { checksum: `0000000${job.batchSequence}` };
      });
    }
    return { steps: [], startedCount: 1, stoppedBecause: null };
  }
  async killAll() {
    this.killed += 1;
    for (const jobs of this.repository.batches.values()) {
      for (const job of jobs) if (job.status === JobStatus.QUEUED) job.status = JobStatus.CANCELLED;
    }
  }
}

class FakeAutoscaler {
  events = [];
  pause(reason) { this.events.push(["pause", reason]); }
  resume() { this.events.push(["resume"]); }
}

function harness({ imageAvailable = true, clock } = {}) {
  const repository = new FakeRepository();
  const workloads = new FakeWorkloads(repository);
  const orchestrator = new FakeOrchestrator(repository);
  const autoscaler = new FakeAutoscaler();
  const service = new BenchmarkService(repository, {
    workloads,
    orchestrator,
    autoscaler,
    executions: { describeRuntime: async () => ({ imageAvailable, image: "orchestr-os/workload:test" }) },
    wait: () => new Promise((resolve) => setImmediate(resolve)),
    tickMs: 0,
    ...(clock ? { clock } : {}),
  });
  return { repository, workloads, orchestrator, autoscaler, service };
}

const input = (overrides = {}) => startBenchmarkSchema.parse({ count: 10, ...overrides });

test("a suite runs each policy in order on the same work, with autoscaling frozen", async () => {
  const { repository, workloads, orchestrator, autoscaler, service } = harness();
  const started = await service.start(input());
  assert.equal(started.status, BenchmarkStatus.RUNNING);
  assert.equal(service.isRunning, true);
  await service.awaitCompletion();
  assert.equal(service.isRunning, false);

  assert.equal(repository.suite.status, BenchmarkStatus.COMPLETED);
  assert.deepEqual(repository.suite.runs.map((run) => run.status), Array(4).fill(BenchmarkStatus.COMPLETED));
  assert.deepEqual(orchestrator.requests.map((request) => request.policy), ALL_POLICIES);
  assert.equal(orchestrator.requests.every((request) => request.maxJobs === 25), true);
  assert.equal(orchestrator.requests[3].timeQuantumSeconds, 5, "Round Robin gets its quantum");
  assert.equal("timeQuantumSeconds" in orchestrator.requests[0], false, "other policies do not");

  assert.equal(workloads.calls[0].kind, "generate");
  assert.equal(workloads.calls[0].input.seed, 42);
  assert.deepEqual(workloads.calls.slice(1).map((call) => [call.kind, call.id]),
    Array(3).fill(["reuse", "batch-0"]), "later runs reuse the first batch, not each other");

  assert.equal(autoscaler.events[0][0], "pause");
  assert.deepEqual(autoscaler.events.at(-1), ["resume"]);
  assert.equal(repository.run("run-0").workerCount, 3, "capacity is recorded per run");
  assert.equal(repository.run("run-0").completedJobs, 10);
  assert.ok(repository.run("run-0").avgTurnaroundSeconds > 0);

  const presented = await service.get(repository.suite.id);
  assert.equal(presented.comparison.finishedRuns, 4);
  assert.equal(presented.progress, null, "a finished suite has no live progress");
});

test("a suite refuses a busy cluster, a missing image, and a second suite", async () => {
  const busy = harness();
  busy.repository.unfinished = 2;
  await assert.rejects(busy.service.start(input()), { code: "CLUSTER_NOT_IDLE", statusCode: 409 });
  assert.equal(busy.service.isRunning, false, "a refused start frees the slot");
  assert.equal(busy.repository.suite, null);

  const noImage = harness({ imageAvailable: false });
  await assert.rejects(noImage.service.start(input()), { code: "WORKLOAD_IMAGE_MISSING", statusCode: 503 });
  assert.equal(noImage.service.isRunning, false);

  const { service } = harness();
  const first = service.start(input());
  await assert.rejects(service.start(input()), { code: "BENCHMARK_RUNNING" },
    "the slot is taken before the first start awaits anything");
  await first;
  await service.awaitCompletion();
});

test("waiting codes keep the run going; it finishes once capacity frees up", async () => {
  const { repository, orchestrator, service } = harness();
  const wait = { steps: [], startedCount: 0, stoppedBecause: "INSUFFICIENT_RESOURCES" };
  orchestrator.script.push(() => wait, () => ({ ...wait, stoppedBecause: "NOTHING_ELIGIBLE" }));
  await service.start(input({ policies: ["FCFS"] }));
  await service.awaitCompletion();
  assert.equal(orchestrator.requests.length, 3);
  assert.equal(repository.suite.status, BenchmarkStatus.COMPLETED);
});

test("a stage that cannot recover fails the run, stops its work, and skips the rest", async () => {
  const { repository, orchestrator, service, autoscaler } = harness();
  orchestrator.script.push(() => ({
    steps: [{ stages: [{ stage: "EXECUTION", status: "FAILED", detail: "Docker is not reachable" }] }],
    startedCount: 0,
    stoppedBecause: "DOCKER_UNAVAILABLE",
  }));
  await service.start(input({ policies: ["FCFS", "SJF"] }));
  await service.awaitCompletion();
  assert.equal(orchestrator.killed, 1);
  assert.equal(repository.run("run-0").status, BenchmarkStatus.FAILED);
  assert.equal(repository.run("run-0").failureReason, "Docker is not reachable");
  assert.equal(repository.run("run-1").status, BenchmarkStatus.ABORTED, "SJF never ran");
  assert.equal(repository.suite.status, BenchmarkStatus.FAILED);
  assert.deepEqual(autoscaler.events.at(-1), ["resume"], "autoscaling comes back after a failure");
});

test("an operator abort cancels the current run and records it", async () => {
  const { repository, orchestrator, service } = harness();
  orchestrator.script.push(() => {
    service.abort(repository.suite.id);
    return { steps: [], startedCount: 0, stoppedBecause: "INSUFFICIENT_RESOURCES" };
  });
  const started = await service.start(input());
  assert.throws(() => service.abort("00000000-0000-4000-8000-00000000ffff"), { code: "BENCHMARK_NOT_RUNNING" });
  await service.awaitCompletion();
  assert.equal(started.id, repository.suite.id);
  assert.equal(orchestrator.killed, 1);
  assert.equal(repository.run("run-0").status, BenchmarkStatus.ABORTED);
  assert.equal(repository.run("run-0").cancelledJobs, 10);
  assert.equal(repository.suite.status, BenchmarkStatus.ABORTED);
  assert.equal(orchestrator.requests.length, 1, "no further policy ran");
});

test("stopping all workloads mid-run aborts the suite instead of failing it", async () => {
  const { repository, orchestrator, service } = harness();
  orchestrator.script.push(() => {
    throw new AppError("Workloads are being stopped", 409, "WORKLOADS_STOPPING");
  });
  await service.start(input({ policies: ["SJF"] }));
  await service.awaitCompletion();
  assert.equal(repository.run("run-0").status, BenchmarkStatus.ABORTED);
  assert.equal(repository.suite.status, BenchmarkStatus.ABORTED);
});

test("a run that never drains times out as a failure", async () => {
  let now = t0.getTime();
  const { repository, orchestrator, service } = harness({ clock: () => new Date(now) });
  const stall = () => {
    now += 10 * 60_000;
    orchestrator.script.push(stall);
    return { steps: [], startedCount: 0, stoppedBecause: "NOTHING_ELIGIBLE" };
  };
  orchestrator.script.push(stall);
  await service.start(input({ policies: ["PRIORITY"] }));
  await service.awaitCompletion();
  assert.equal(repository.run("run-0").status, BenchmarkStatus.FAILED);
  assert.match(repository.run("run-0").failureReason, /did not finish within 15 minutes/);
  assert.equal(orchestrator.killed, 1);
});

test("jobs cancelled from outside the suite make the run aborted, not a result", async () => {
  const { repository, orchestrator, service } = harness();
  orchestrator.script.push(async () => {
    for (const job of repository.batches.get("batch-0")) job.status = JobStatus.CANCELLED;
    return { steps: [], startedCount: 0, stoppedBecause: "NOTHING_ELIGIBLE" };
  });
  await service.start(input({ policies: ["FCFS", "SJF"] }));
  await service.awaitCompletion();
  assert.equal(repository.run("run-0").status, BenchmarkStatus.ABORTED);
  assert.equal(repository.suite.status, BenchmarkStatus.ABORTED);
});

test("the route guard refuses pipeline changes only while a suite runs", () => {
  const calls = [];
  rejectWhileBenchmarking({}, {}, (error) => calls.push(error));
  assert.equal(calls[0], undefined);
  benchmarkService.active = { suiteId: "x" };
  try {
    rejectWhileBenchmarking({}, {}, (error) => calls.push(error));
  } finally {
    benchmarkService.active = null;
  }
  assert.equal(calls[1].code, "BENCHMARK_RUNNING");
  assert.equal(calls[1].statusCode, 409);
  assert.equal(SchedulingPolicy.ROUND_ROBIN, ALL_POLICIES[3]);
});
