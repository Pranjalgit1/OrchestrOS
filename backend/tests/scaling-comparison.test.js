import assert from "node:assert/strict";
import test from "node:test";
import { BenchmarkStatus, JobStatus } from "@prisma/client";
import { rejectWhileBenchmarking } from "../src/modules/benchmarks/benchmark.guard.js";
import { benchmarkService } from "../src/modules/benchmarks/benchmark.service.js";
import {
  compareScaling,
  isTie,
  measureScaling,
  reactionOutcome,
} from "../src/modules/scaling-comparisons/scaling-comparison.metrics.js";
import { startScalingComparisonSchema } from "../src/modules/scaling-comparisons/scaling-comparison.schemas.js";
import {
  ScalingComparisonService,
  scalingComparisonService,
} from "../src/modules/scaling-comparisons/scaling-comparison.service.js";

const t0 = new Date("2026-11-01T10:00:00.000Z");
const at = (seconds) => new Date(t0.getTime() + seconds * 1_000);
const settings = {
  scaleUpQueueThreshold: 2, scaleUpUtilization: 0.75, mlLookAheadSeconds: 4, cooldownSeconds: 15, maxWorkers: 3,
};
/** One sample every 2 seconds from `points` of [queued, extra, idleExtra, peak, forecast]. */
function timeline(points) {
  return points.map(([queuedJobs, extraWorkers, idleExtraWorkers, peakUtilization, forecastQueuedJobs = null], index) => ({
    at: at(index * 2), offsetSeconds: index * 2, queuedJobs, workersInService: 3 + extraWorkers,
    extraWorkers, idleExtraWorkers, peakUtilization, forecastQueuedJobs,
  }));
}

// ---------------------------------------------------------------- measuring one run

test("reaction time runs from the first pressured sample to the first scale-up", () => {
  const samples = timeline([[0, 0, 0, 0.2], [3, 0, 0, 0.5], [3, 0, 0, 0.9], [4, 1, 0, 0.9], [1, 1, 1, 0.4]]);
  const actions = [{ at: at(7), action: "SCALE_UP" }];
  const result = measureScaling({ samples, actions, settings, endedAt: at(10) });
  assert.deepEqual(result.pressureAt, at(4), "a queue alone is not pressure; utilization must be high too");
  assert.equal(result.reactionSeconds, 3);
  assert.equal(result.scaleUps, 1);
  assert.equal(result.peakWorkers, 4);
});

test("an early scale-up gives a negative reaction time", () => {
  const samples = timeline([[0, 0, 0, 0.2], [1, 1, 1, 0.5], [3, 1, 0, 0.8]]);
  const result = measureScaling({ samples, actions: [{ at: at(1), action: "SCALE_UP" }], settings, endedAt: at(6) });
  assert.equal(result.reactionSeconds, -3);
});

test("time-weighted values hold each sample until the next one, and the last until the end", () => {
  const samples = timeline([[0, 0, 0, 0.1], [2, 1, 1, 0.9], [5, 2, 0, 1], [0, 2, 2, 0.3]]);
  const result = measureScaling({ samples, actions: [], settings, endedAt: at(10) });
  assert.equal(result.backedUpSeconds, 4, "queues of 2 and 5 each held for 2 s");
  assert.equal(result.extraWorkerSeconds, 2 * 1 + 2 * 2 + 4 * 2, "the last sample holds for 4 s");
  assert.equal(result.idleExtraWorkerSeconds, 2 * 1 + 4 * 2);
  assert.equal(measureScaling({ samples: [], actions: [], settings, endedAt: at(1) }).extraWorkerSeconds, null);
});

test("a worker added back within a minute of a retirement is a flap", () => {
  const actions = [
    { at: at(0), action: "SCALE_UP" }, { at: at(30), action: "SCALE_DOWN" },
    { at: at(50), action: "SCALE_UP" }, { at: at(200), action: "SCALE_DOWN" }, { at: at(300), action: "SCALE_UP" },
  ];
  const result = measureScaling({ samples: timeline([[0, 0, 0, 0]]), actions, settings, endedAt: at(400) });
  assert.equal(result.flaps, 1);
  assert.equal(result.scaleUps, 3);
  assert.equal(result.scaleDowns, 2);
});

test("forecast error compares each prediction with the queue measured look-ahead seconds later", () => {
  // Look-ahead 4 s: the forecast at 0 s is checked against 4 s, the one at 2 s against 6 s.
  const samples = timeline([[0, 0, 0, 0.1, 3], [1, 0, 0, 0.2, 2], [2, 0, 0, 0.5, null], [5, 0, 0, 0.9, 9]]);
  const result = measureScaling({ samples, actions: [], settings, endedAt: at(6) });
  assert.equal(result.forecastPairs, 2, "the last forecast points past the end of the run");
  assert.equal(result.forecastMeanAbsError, (Math.abs(3 - 2) + Math.abs(2 - 5)) / 2);
  const reactive = measureScaling({ samples: timeline([[1, 0, 0, 0.1]]), actions: [], settings, endedAt: at(2) });
  assert.equal(reactive.forecastMeanAbsError, null);
});

test("reaction outcomes cover the cases a single number cannot", () => {
  assert.equal(reactionOutcome({ pressureAt: at(1), firstScaleUpAt: at(2) }), "MEASURED");
  assert.equal(reactionOutcome({ pressureAt: null, firstScaleUpAt: at(2) }), "BEFORE_ANY_BACKLOG");
  assert.equal(reactionOutcome({ pressureAt: at(1), firstScaleUpAt: null }), "NEVER_SCALED_UP");
  assert.equal(reactionOutcome({ pressureAt: null, firstScaleUpAt: null }), "NOT_NEEDED");
});

// ---------------------------------------------------------------- comparing the two runs

function completedRun(strategy, overrides = {}) {
  return {
    strategy, status: "COMPLETED", workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072,
    checksumDigest: "same", avgWaitSeconds: 20, p95WaitSeconds: 40, avgTurnaroundSeconds: 30, makespanSeconds: 300,
    pressureAt: at(10), firstScaleUpAt: at(16), reactionSeconds: 6, backedUpSeconds: 60,
    extraWorkerSeconds: 200, idleExtraWorkerSeconds: 40, scaleUps: 2, scaleDowns: 2, flaps: 0,
    forecastMeanAbsError: null, forecastPairs: 0, ...overrides,
  };
}

test("small gaps are ties so timer noise cannot pick a winner", () => {
  assert.equal(isTie(20, 20.9, "s"), true, "under 5%");
  assert.equal(isTie(20, 22, "s"), false);
  assert.equal(isTie(0.2, 0.6, "s"), true, "under half a second");
  assert.equal(isTie(100, 103, "worker-s"), true);
  assert.equal(isTie(2, 3, "count"), false);
});

test("each metric names a winner and the ML-vs-Reactive change", () => {
  const result = compareScaling([
    completedRun("REACTIVE"),
    completedRun("ML", { avgWaitSeconds: 15, extraWorkerSeconds: 300, reactionSeconds: -2, firstScaleUpAt: at(8),
      forecastMeanAbsError: 1.25, forecastPairs: 40 }),
  ]);
  const metric = (key) => result.metrics.find((entry) => entry.key === key);
  assert.equal(result.comparable, true);
  assert.equal(metric("avgWaitSeconds").winner, "ML");
  assert.equal(metric("avgWaitSeconds").change, -0.25);
  assert.equal(metric("extraWorkerSeconds").winner, "REACTIVE", "ML used more worker time");
  assert.equal(metric("reactionSeconds").winner, "ML");
  assert.equal(metric("scaleActions").reactive, 4, "scaling changes add ups and downs");
  assert.equal(metric("makespanSeconds").winner, "TIE");
  assert.equal(result.waitVerdict, "ML");
  assert.equal(result.costVerdict, "REACTIVE");
  assert.deepEqual(result.forecast, { meanAbsError: 1.25, pairs: 40 });
});

test("scaling before any backlog beats reacting to one", () => {
  const result = compareScaling([
    completedRun("REACTIVE"),
    completedRun("ML", { pressureAt: null, firstScaleUpAt: at(5), reactionSeconds: null }),
  ]);
  const reaction = result.metrics.find((entry) => entry.key === "reactionSeconds");
  assert.equal(reaction.winner, "ML");
  assert.equal(reaction.mlOutcome, "BEFORE_ANY_BACKLOG");
  assert.equal(reaction.reactiveOutcome, "MEASURED");
});

test("no winner until both runs complete, and unfair runs say why", () => {
  const pending = compareScaling([completedRun("REACTIVE"), { strategy: "ML", status: "RUNNING" }]);
  assert.equal(pending.comparable, false);
  assert.equal(pending.waitVerdict, null);
  assert.match(pending.notes[0], /1 run\(s\) have not completed/);
  const unfair = compareScaling([completedRun("REACTIVE"), completedRun("ML", { workerCount: 4, checksumDigest: "x" })]);
  assert.equal(unfair.comparable, false);
  assert.equal(unfair.notes.length, 2);
});

test("the start schema defaults to a 25-job ramp and rejects unsafe input", () => {
  const defaults = startScalingComparisonSchema.parse({});
  assert.equal(defaults.count, 25);
  assert.equal(defaults.pattern, "INCREASING");
  assert.equal(defaults.policy, "FCFS");
  for (const body of [{ count: 30 }, { pattern: "CUSTOM" }, { strategies: ["ML"] }, { workloadTypes: ["SLEEP", "SLEEP"] }]) {
    assert.equal(startScalingComparisonSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------- the runner, with fakes

class FakeRepository {
  unfinished = 0;
  capacity = { workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072 };
  comparison = null;
  batches = new Map();
  retireCalls = 0;
  remainingExtra = 0;
  lastEventAt = null;
  stored = new Map();

  async countUnfinishedJobs() { return this.unfinished; }
  async readCapacity() { return { ...this.capacity }; }
  async createComparison(fields, strategies) {
    this.comparison = {
      id: "00000000-0000-4000-8000-0000000000aa", ...fields, status: BenchmarkStatus.RUNNING,
      runs: strategies.map((strategy, position) => ({ id: `run-${position}`, strategy, position, status: BenchmarkStatus.PENDING })),
    };
    return structuredClone(this.comparison);
  }
  run(id) { return this.comparison.runs.find((entry) => entry.id === id); }
  async startRun(id, { workloadBatchId, capacity, jobCount }) {
    Object.assign(this.run(id), { status: BenchmarkStatus.RUNNING, workloadBatchId, jobCount, ...capacity });
  }
  async finishRun(id, status, results, failureReason, samples) {
    Object.assign(this.run(id), { status, failureReason, ...results });
    this.stored.set(id, samples);
  }
  async finishComparison(id, status, failureReason = null) {
    for (const run of this.comparison.runs) {
      if (["PENDING", "RUNNING"].includes(run.status)) run.status = BenchmarkStatus.ABORTED;
    }
    Object.assign(this.comparison, { status, failureReason });
  }
  async retireAutoscaledWorkers() { this.retireCalls += 1; return { retired: 1, remaining: this.remainingExtra }; }
  async lastScalingEventAt() { return this.lastEventAt; }
  async readLoad() {
    const queuedJobs = [...this.batches.values()].flat().filter((job) => job.status === JobStatus.QUEUED).length;
    return { queuedJobs, workers: [
      { status: "BUSY", autoscaled: false, cpuCapacityMillicores: 1000, cpuAllocatedMillicores: 800,
        memoryCapacityMiB: 1024, memoryAllocatedMiB: 256 },
      { status: "IDLE", autoscaled: true, cpuCapacityMillicores: 1000, cpuAllocatedMillicores: 0,
        memoryCapacityMiB: 512, memoryAllocatedMiB: 0 },
    ] };
  }
  async listActions() { return [{ at: t0, action: "SCALE_UP", workerName: "auto-worker-1", reason: "x" }]; }
  async batchProgress(batchId) {
    const jobs = this.batches.get(batchId) ?? [];
    const unfinished = jobs.filter((job) => job.status === JobStatus.QUEUED).length;
    return { total: jobs.length, unfinished, finished: jobs.length - unfinished };
  }
  async readBatchJobs(batchId) { return this.batches.get(batchId) ?? []; }
  async findComparison() { return this.comparison; }
  async listComparisons() { return this.comparison ? [this.comparison] : []; }
}

class FakeWorkloads {
  calls = [];
  constructor(repository) { this.repository = repository; }
  make(count) {
    const id = `batch-${this.calls.length - 1}`;
    this.repository.batches.set(id, Array.from({ length: count }, (_, index) => ({
      status: JobStatus.QUEUED, batchSequence: index + 1, arrivalAt: at(0), completedAt: null,
      preemptionCount: 0, retryCount: 0, result: null, executions: [],
    })));
    return { id, jobs: this.repository.batches.get(id).map(() => ({ arrivalOffsetSeconds: 0 })) };
  }
  async generate(input) { this.calls.push({ kind: "generate", input }); return this.make(input.count); }
  async reuse(id) { this.calls.push({ kind: "reuse", id }); return this.make(3); }
}

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
        Object.assign(job, { status: JobStatus.COMPLETED, completedAt: at(10 + index),
          executions: [{ startedAt: at(index), completedAt: at(10 + index) }],
          result: { checksum: `0000000${job.batchSequence}` } });
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
  loopEnabled = true;
  config = { enabled: false, strategy: "REACTIVE", maxWorkers: 3, workerCpuMillicores: 1000, workerMemoryMiB: 512,
    scaleUpQueueThreshold: 2, scaleUpUtilization: 0.75, scaleDownUtilization: 0.4, idleSeconds: 30,
    cooldownSeconds: 15, mlWindowPoints: 20, mlLookAheadSeconds: 60 };
  events = [];
  updateConfig(patch) { this.config = { ...this.config, ...patch }; this.events.push(["config", patch]); return this.config; }
  resetHistory() { this.events.push(["reset-history"]); }
  pause(reason) { this.events.push(["pause", reason]); }
  resume() { this.events.push(["resume"]); }
  forecast() { return this.config.strategy === "ML" ? { queuedJobs: 4.5, peak: 0.8 } : null; }
}

function harness({ imageAvailable = true, clock } = {}) {
  const repository = new FakeRepository();
  const workloads = new FakeWorkloads(repository);
  const orchestrator = new FakeOrchestrator(repository);
  const autoscaler = new FakeAutoscaler();
  const waits = [];
  const service = new ScalingComparisonService(repository, {
    workloads, orchestrator, autoscaler,
    executions: { describeRuntime: async () => ({ imageAvailable, image: "orchestr-os/workload:test" }) },
    wait: (milliseconds) => { waits.push(milliseconds); return new Promise((resolve) => setImmediate(resolve)); },
    tickMs: 0,
    sampleMs: 0,
    ...(clock ? { clock } : {}),
  });
  return { repository, workloads, orchestrator, autoscaler, service, waits };
}

const input = (overrides = {}) => startScalingComparisonSchema.parse({ count: 10, ...overrides });

test("a comparison runs Reactive then ML on the same work, changing only the strategy", async () => {
  const { repository, workloads, orchestrator, autoscaler, service } = harness();
  await service.start(input({ policy: "SJF" }));
  assert.equal(service.isRunning, true);
  await service.awaitCompletion();
  assert.equal(service.isRunning, false);

  assert.equal(repository.comparison.status, BenchmarkStatus.COMPLETED);
  assert.deepEqual(repository.comparison.runs.map((run) => [run.strategy, run.status]),
    [["REACTIVE", "COMPLETED"], ["ML", "COMPLETED"]]);
  assert.deepEqual(workloads.calls.map((call) => call.kind), ["generate", "reuse"]);
  assert.equal(workloads.calls[1].id, "batch-0", "ML reuses the reactive run's batch");
  assert.equal(orchestrator.requests.every((request) => request.policy === "SJF"), true);
  assert.equal(repository.retireCalls, 2, "the cluster is reset before each run");
  assert.equal(repository.comparison.autoscalerSettings.scaleUpQueueThreshold, 2, "the shared settings are recorded");

  const strategies = autoscaler.events.filter(([kind, patch]) => kind === "config" && patch.strategy)
    .map(([, patch]) => patch);
  assert.deepEqual(strategies, [
    { enabled: true, strategy: "REACTIVE" },
    { enabled: true, strategy: "ML" },
    { enabled: false, strategy: "REACTIVE" },
  ], "each run enables its strategy, then the previous settings come back");
  assert.equal(autoscaler.events.filter(([kind]) => kind === "reset-history").length, 2,
    "ML never inherits the reactive run's load history");
  assert.deepEqual(autoscaler.events.at(-1), ["resume"]);

  const mlSamples = repository.stored.get("run-1");
  assert.ok(mlSamples.length >= 2, "a run stores its timeline");
  assert.equal(mlSamples[0].forecastQueuedJobs, 4.5, "ML samples carry the forecast");
  assert.equal(repository.stored.get("run-0")[0].forecastQueuedJobs, null, "reactive samples do not");
  assert.equal(mlSamples[0].extraWorkers, 1);
  assert.equal(mlSamples[0].idleExtraWorkers, 1);
  assert.equal(repository.run("run-1").scaleUps, 1);
  assert.equal(repository.run("run-1").completedJobs, 3);
  assert.equal(typeof repository.run("run-1").scalingActions[0].at, "string");

  const presented = await service.get(repository.comparison.id);
  assert.equal(presented.comparison.metrics.length > 0, true);
  assert.equal(presented.progress, null);
});

test("a comparison waits out the autoscaler cooldown before each run", async () => {
  const { repository, service, waits } = harness({ clock: () => at(5) });
  repository.lastEventAt = at(0);
  await service.start(input());
  await service.awaitCompletion();
  assert.equal(waits.filter((value) => value === 10_000).length, 2, "15 s cooldown, 5 s already passed");
});

test("a comparison refuses a busy cluster, a missing image, an off autoscaler, and a second start", async () => {
  const busy = harness();
  busy.repository.unfinished = 1;
  await assert.rejects(busy.service.start(input()), { code: "CLUSTER_NOT_IDLE" });
  assert.equal(busy.service.isRunning, false);
  await assert.rejects(harness({ imageAvailable: false }).service.start(input()), { code: "WORKLOAD_IMAGE_MISSING" });
  const noLoop = harness();
  noLoop.autoscaler.loopEnabled = false;
  await assert.rejects(noLoop.service.start(input()), { code: "AUTOSCALER_LOOP_DISABLED" });
  const noRoom = harness();
  noRoom.autoscaler.config.maxWorkers = 0;
  await assert.rejects(noRoom.service.start(input()), { code: "AUTOSCALER_NO_CAPACITY" });

  const { service } = harness();
  const first = service.start(input());
  await assert.rejects(service.start(input()), { code: "COMPARISON_RUNNING" });
  await first;
  await service.awaitCompletion();
});

test("an abort cancels the current run and skips ML", async () => {
  const { repository, orchestrator, service } = harness();
  orchestrator.script.push(() => {
    service.abort(repository.comparison.id);
    return { steps: [], startedCount: 0, stoppedBecause: "INSUFFICIENT_RESOURCES" };
  });
  await service.start(input());
  await service.awaitCompletion();
  assert.equal(orchestrator.killed, 1);
  assert.equal(repository.run("run-0").status, BenchmarkStatus.ABORTED);
  assert.equal(repository.run("run-1").status, BenchmarkStatus.ABORTED);
  assert.equal(repository.comparison.status, BenchmarkStatus.ABORTED);
});

test("a failing stage fails the run, and the autoscaler settings still come back", async () => {
  const { repository, orchestrator, autoscaler, service } = harness();
  orchestrator.script.push(() => ({
    steps: [{ stages: [{ status: "FAILED", detail: "Docker is not reachable" }] }],
    startedCount: 0, stoppedBecause: "DOCKER_UNAVAILABLE",
  }));
  await service.start(input());
  await service.awaitCompletion();
  assert.equal(repository.run("run-0").failureReason, "Docker is not reachable");
  assert.equal(repository.comparison.status, BenchmarkStatus.FAILED);
  assert.equal(autoscaler.config.enabled, false);
  assert.equal(autoscaler.config.strategy, "REACTIVE");
});

test("a cluster that cannot be reset fails the comparison before any job runs", async () => {
  const { repository, orchestrator, service } = harness();
  repository.remainingExtra = 1;
  await service.start(input());
  await service.awaitCompletion();
  assert.equal(repository.comparison.status, BenchmarkStatus.FAILED);
  assert.match(repository.comparison.failureReason, /could not be reset/);
  assert.equal(orchestrator.requests.length, 0);
});

test("the two experiments refuse each other, and the guard blocks pipeline changes during either", async () => {
  const calls = [];
  scalingComparisonService.active = { comparisonId: "x" };
  try {
    rejectWhileBenchmarking({}, {}, (error) => calls.push(error));
    await assert.rejects(benchmarkService.start({}), { code: "BENCHMARK_RUNNING", message: /An autoscaling comparison is running/ });
  } finally {
    scalingComparisonService.active = null;
  }
  assert.equal(calls[0].code, "BENCHMARK_RUNNING");
  assert.match(calls[0].message, /An autoscaling comparison is running/);

  benchmarkService.active = { suiteId: "y" };
  try {
    await assert.rejects(scalingComparisonService.start(input()), { message: /A policy benchmark is running/ });
  } finally {
    benchmarkService.active = null;
  }
  rejectWhileBenchmarking({}, {}, (error) => calls.push(error));
  assert.equal(calls[1], undefined, "nothing running, nothing refused");
});
