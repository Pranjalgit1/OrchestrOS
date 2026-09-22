import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { WorkerStatus, type Worker, type WorkerSample } from "@prisma/client";

import {
  TIMING_METRICS,
  completionRatePerMinute,
  ratio,
  round,
  summariseCluster,
  summariseTimings,
  utilizationSeries,
  type RawDurationRow,
} from "./monitoring.metrics.js";
import {
  jobMetricsQuerySchema,
  sampleHistoryQuerySchema,
} from "./monitoring.schemas.js";
import { MonitoringSampler, type SampleRecorder } from "./monitoring.sampler.js";
import { MonitoringService } from "./monitoring.service.js";
import type {
  MonitoringRepository,
  OverviewData,
  SampleFilter,
  WorkerActivity,
} from "./monitoring.repository.js";
import type { SampleCaptureResult } from "./monitoring.service.js";

const now = new Date("2026-09-22T12:00:00.000Z");

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    name: "worker-1",
    cpuCapacityMillicores: 2_000,
    memoryCapacityMiB: 2_048,
    cpuAllocatedMillicores: 0,
    memoryAllocatedMiB: 0,
    status: WorkerStatus.IDLE,
    lastHeartbeat: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSample(overrides: Partial<WorkerSample> = {}): WorkerSample {
  return {
    id: randomUUID(),
    workerId: randomUUID(),
    capturedAt: now,
    cpuCapacityMillicores: 2_000,
    memoryCapacityMiB: 2_048,
    cpuAllocatedMillicores: 0,
    memoryAllocatedMiB: 0,
    status: WorkerStatus.IDLE,
    runningExecutions: 0,
    reservedAllocations: 0,
    createdAt: now,
    ...overrides,
  };
}

class StubRepository implements MonitoringRepository {
  captureCalls: Date[] = [];
  pruneCalls: Date[] = [];
  lastSampleFilter: SampleFilter | null = null;
  lastTimingSince: Date | null = null;

  constructor(
    private readonly data: Partial<OverviewData> = {},
    private readonly activity: WorkerActivity[] = [],
    private readonly timings: RawDurationRow[] = [],
    private readonly terminal: Record<string, number> = {},
    private readonly samples: WorkerSample[] = [],
  ) {}

  async overview(): Promise<OverviewData> {
    return {
      workers: [],
      jobsByStatus: {},
      executionsByStatus: {},
      reservedAllocations: 0,
      runningExecutions: [],
      latestSampleAt: null,
      sampleCount: 0,
      ...this.data,
    };
  }

  async jobTimings(since: Date): Promise<RawDurationRow[]> {
    this.lastTimingSince = since;
    return this.timings;
  }

  async terminalJobCounts(): Promise<Record<string, number>> {
    return this.terminal;
  }

  async workerActivity(): Promise<WorkerActivity[]> {
    return this.activity;
  }

  async listSamples(filter: SampleFilter): Promise<WorkerSample[]> {
    this.lastSampleFilter = filter;
    return this.samples;
  }

  async captureSample(capturedAt: Date): Promise<number> {
    this.captureCalls.push(capturedAt);
    return 3;
  }

  async pruneSamples(before: Date): Promise<number> {
    this.pruneCalls.push(before);
    return 7;
  }
}

test("ratio is clamped so a reporting bug cannot show impossible load", () => {
  assert.equal(ratio(500, 1_000), 0.5);
  assert.equal(ratio(0, 1_000), 0);
  assert.equal(ratio(2_000, 1_000), 1, "over-allocation is reported as full, never above");
  assert.equal(ratio(-50, 1_000), 0, "negative usage cannot read below empty");
  assert.equal(ratio(100, 0), 0, "a worker with no capacity reports no utilization");
  assert.equal(round(0.123456), 0.1235);
  assert.equal(round(1.5, 0), 2);
});

test("cluster totals sum capacity, reservations, and worker states", () => {
  const cluster = summariseCluster([
    makeWorker({
      status: WorkerStatus.BUSY,
      cpuCapacityMillicores: 2_000,
      cpuAllocatedMillicores: 800,
      memoryCapacityMiB: 2_048,
      memoryAllocatedMiB: 512,
    }),
    makeWorker({
      status: WorkerStatus.IDLE,
      cpuCapacityMillicores: 4_000,
      cpuAllocatedMillicores: 0,
      memoryCapacityMiB: 4_096,
      memoryAllocatedMiB: 0,
    }),
    makeWorker({ status: WorkerStatus.FAILED, cpuCapacityMillicores: 1_000, memoryCapacityMiB: 1_024 }),
  ]);

  assert.equal(cluster.workerCount, 3);
  assert.equal(cluster.cpuCapacityMillicores, 7_000);
  assert.equal(cluster.cpuAllocatedMillicores, 800);
  assert.equal(cluster.cpuAvailableMillicores, 6_200);
  assert.equal(cluster.cpuUtilization, round(800 / 7_000));
  assert.equal(cluster.memoryCapacityMiB, 7_168);
  assert.equal(cluster.memoryAllocatedMiB, 512);
  assert.equal(cluster.schedulableWorkers, 2, "a FAILED worker cannot accept work");
  assert.deepEqual(cluster.workersByStatus, { BUSY: 1, IDLE: 1, FAILED: 1 });
});

test("an empty cluster reports zeros rather than dividing by zero", () => {
  const cluster = summariseCluster([]);
  assert.equal(cluster.workerCount, 0);
  assert.equal(cluster.cpuUtilization, 0);
  assert.equal(cluster.memoryUtilization, 0);
  assert.deepEqual(cluster.workersByStatus, {});
});

test("timing summaries report every stage, including unmeasured ones", () => {
  const summary = summariseTimings([
    { metric: "queueWait", count: 4, average: 2.5, minimum: 1, maximum: 5, p95: 4.8 },
    { metric: "execution", count: 2n, average: 0.4567, minimum: 0.4, maximum: 0.5, p95: 0.5 },
    { metric: "notARealMetric", count: 9, average: 1, minimum: 1, maximum: 1, p95: 1 },
  ]);

  assert.deepEqual(Object.keys(summary).sort(), [...TIMING_METRICS].sort());
  assert.equal(summary.queueWait.count, 4);
  assert.equal(summary.queueWait.averageSeconds, 2.5);
  assert.equal(summary.queueWait.p95Seconds, 4.8);
  assert.equal(summary.execution.count, 2, "a bigint count from SQL is normalised");
  assert.equal(summary.execution.averageSeconds, 0.457);
  assert.equal(
    summary.placementDelay.count,
    0,
    "a stage nothing has reached yet reports zero, not absent",
  );
  assert.equal(summary.placementDelay.averageSeconds, null);
  assert.equal(
    Object.keys(summary).includes("notARealMetric"),
    false,
    "unknown metrics from SQL are ignored",
  );
});

test("samples collapse into cluster utilization points ordered oldest first", () => {
  const earlier = new Date("2026-09-22T12:00:00.000Z");
  const later = new Date("2026-09-22T12:00:15.000Z");

  const points = utilizationSeries([
    // Deliberately out of order to prove the sort.
    makeSample({
      capturedAt: later,
      cpuCapacityMillicores: 2_000,
      cpuAllocatedMillicores: 1_000,
      memoryCapacityMiB: 2_048,
      memoryAllocatedMiB: 1_024,
      runningExecutions: 1,
      reservedAllocations: 1,
    }),
    makeSample({
      capturedAt: earlier,
      cpuCapacityMillicores: 2_000,
      cpuAllocatedMillicores: 0,
      memoryCapacityMiB: 2_048,
      memoryAllocatedMiB: 0,
    }),
    makeSample({
      capturedAt: earlier,
      cpuCapacityMillicores: 4_000,
      cpuAllocatedMillicores: 2_000,
      memoryCapacityMiB: 4_096,
      memoryAllocatedMiB: 1_024,
      reservedAllocations: 2,
    }),
  ]);

  assert.equal(points.length, 2, "one point per sampling pass");
  assert.equal(points[0]?.capturedAt.getTime(), earlier.getTime(), "oldest first");

  const first = points[0];
  assert.ok(first);
  assert.equal(first.workerCount, 2, "both workers in the pass are summed");
  assert.equal(first.cpuCapacityMillicores, 6_000);
  assert.equal(first.cpuAllocatedMillicores, 2_000);
  assert.equal(first.cpuUtilization, round(2_000 / 6_000));
  assert.equal(first.reservedAllocations, 2);

  assert.deepEqual(utilizationSeries([]), [], "no samples is not an error");
});

test("completion rate divides by the stated window", () => {
  assert.equal(completionRatePerMinute(30, 60), 0.5);
  assert.equal(completionRatePerMinute(0, 60), 0);
  assert.equal(completionRatePerMinute(10, 0), 0, "a zero window cannot produce infinity");
});

test("the overview buckets jobs by lifecycle stage and fills missing worker activity", async () => {
  const busy = makeWorker({
    name: "worker-a",
    status: WorkerStatus.BUSY,
    cpuAllocatedMillicores: 800,
    memoryAllocatedMiB: 512,
  });
  const idle = makeWorker({ name: "worker-b" });

  const service = new MonitoringService(
    new StubRepository(
      {
        workers: [busy, idle],
        jobsByStatus: { QUEUED: 4, SCHEDULED: 1, RUNNING: 2, COMPLETED: 3, FAILED: 1 },
        executionsByStatus: { RUNNING: 2, COMPLETED: 3 },
        reservedAllocations: 2,
        sampleCount: 42,
        latestSampleAt: now,
      },
      [
        {
          workerId: busy.id,
          reservedAllocations: 1,
          runningExecutions: 2,
          executionsRun: 5,
          jobsCompleted: 3,
          jobsFailed: 1,
        },
      ],
    ),
    () => now,
  );

  const overview = await service.overview();

  assert.equal(overview.capturedAt, now.toISOString());
  assert.equal(overview.cluster.cpuAllocatedMillicores, 800);
  assert.equal(overview.queue.total, 11);
  assert.equal(overview.queue.waitingToRun, 5, "CREATED/QUEUED/WAITING/SCHEDULED");
  assert.equal(overview.queue.active, 2);
  assert.equal(overview.queue.finished, 4, "COMPLETED/FAILED/INTERRUPTED/CANCELLED");
  assert.equal(overview.reservations.active, 2);
  assert.equal(overview.samples.stored, 42);
  assert.equal(overview.samples.latestAt, now.toISOString());

  const [first, second] = overview.workers;
  assert.equal(first?.runningExecutions, 2);
  assert.equal(first?.cpuUtilization, round(800 / 2_000));
  assert.equal(
    second?.executionsRun,
    0,
    "a worker with no recorded activity reports zeros, not undefined",
  );
  assert.equal(second?.cpuAvailableMillicores, 2_000);
});

test("job metrics anchor the window and refuse to invent a success rate", async () => {
  const withWork = new MonitoringService(
    new StubRepository(
      {},
      [],
      [{ metric: "turnaround", count: 4, average: 12, minimum: 8, maximum: 20, p95: 19 }],
      { COMPLETED: 6, FAILED: 2 },
    ),
    () => now,
  );

  const metrics = await withWork.jobMetrics({ windowMinutes: 60 });
  assert.equal(metrics.windowMinutes, 60);
  assert.equal(
    metrics.since,
    new Date(now.getTime() - 3_600_000).toISOString(),
    "the window start is reported so the denominator is never ambiguous",
  );
  assert.equal(metrics.terminalInWindow, 8);
  assert.equal(metrics.completionsPerMinute, round(8 / 60, 3));
  assert.equal(metrics.successRate, round(6 / 8));
  assert.equal(metrics.timings.turnaround.count, 4);

  const idleService = new MonitoringService(new StubRepository(), () => now);
  const empty = await idleService.jobMetrics({ windowMinutes: 15 });
  assert.equal(empty.terminalInWindow, 0);
  assert.equal(empty.successRate, null, "no finished jobs means no rate, not 0%");
  assert.equal(empty.completionsPerMinute, 0);
});

test("sample history passes the window through and returns cluster points", async () => {
  const repository = new StubRepository({}, [], [], {}, [
    makeSample({ cpuAllocatedMillicores: 1_000 }),
  ]);
  const service = new MonitoringService(repository, () => now);

  const history = await service.sampleHistory({ windowMinutes: 30, limit: 100 });

  assert.deepEqual(repository.lastSampleFilter, {
    workerId: undefined,
    sinceMinutes: 30,
    limit: 100,
  });
  assert.equal(history.windowMinutes, 30);
  assert.equal(history.pointCount, 1);
  assert.equal(history.points[0]?.cpuAllocatedMillicores, 1_000);
});

test("capturing a sample prunes history, and retention zero keeps everything", async () => {
  const pruning = new StubRepository();
  const withRetention = new MonitoringService(pruning, () => now);

  const result = await withRetention.captureSample(24);
  assert.equal(result.workersRecorded, 3);
  assert.equal(result.prunedSamples, 7);
  assert.deepEqual(pruning.captureCalls, [now]);
  assert.deepEqual(
    pruning.pruneCalls,
    [new Date(now.getTime() - 24 * 3_600_000)],
    "pruning cuts at exactly the retention boundary",
  );

  const keeping = new StubRepository();
  const forever = new MonitoringService(keeping, () => now);
  const kept = await forever.captureSample(0);
  assert.equal(kept.prunedSamples, 0);
  assert.equal(keeping.pruneCalls.length, 0, "retention zero must not delete anything");
});

test("monitoring query input is bounded and strictly validated", () => {
  assert.equal(jobMetricsQuerySchema.safeParse({}).data?.windowMinutes, 60);
  assert.equal(jobMetricsQuerySchema.safeParse({ windowMinutes: "30" }).success, true);
  assert.equal(jobMetricsQuerySchema.safeParse({ windowMinutes: 0 }).success, false);
  assert.equal(
    jobMetricsQuerySchema.safeParse({ windowMinutes: 20_000 }).success,
    false,
    "an unbounded window would let a query scan without limit",
  );
  assert.equal(jobMetricsQuerySchema.safeParse({ windowMinutes: 60, extra: 1 }).success, false);

  const defaults = sampleHistoryQuerySchema.safeParse({}).data;
  assert.equal(defaults?.windowMinutes, 60);
  assert.equal(defaults?.limit, 500);
  assert.equal(sampleHistoryQuerySchema.safeParse({ workerId: randomUUID() }).success, true);
  assert.equal(sampleHistoryQuerySchema.safeParse({ workerId: "nope" }).success, false);
  assert.equal(sampleHistoryQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(sampleHistoryQuerySchema.safeParse({ limit: 99_999 }).success, false);
});

test("the sampler is inert when the interval is zero", async () => {
  let calls = 0;
  const recorder: SampleRecorder = {
    async captureSample() {
      calls += 1;
      return { capturedAt: now.toISOString(), workersRecorded: 3, prunedSamples: 0 };
    },
  };

  const disabled = new MonitoringSampler(recorder, 0, 24);
  assert.equal(disabled.enabled, false);
  disabled.start();
  assert.equal(disabled.active, false, "a disabled sampler must not create a timer");
  disabled.stop();

  // It can still be driven explicitly, which is what the endpoint does.
  await disabled.sampleOnce();
  assert.equal(calls, 1);
});

test("starting the sampler twice creates one timer and stopping is safe", () => {
  const recorder: SampleRecorder = {
    async captureSample() {
      return { capturedAt: now.toISOString(), workersRecorded: 3, prunedSamples: 0 };
    },
  };
  const sampler = new MonitoringSampler(recorder, 15, 24);

  assert.equal(sampler.enabled, true);
  sampler.start();
  assert.equal(sampler.active, true);
  sampler.start();
  assert.equal(sampler.active, true, "a repeated start must not stack timers");

  sampler.stop();
  assert.equal(sampler.active, false);
  sampler.stop();
  assert.equal(sampler.active, false, "stopping an idle sampler is not an error");
});

test("a failed sample is logged and never propagates out of the sampler", async () => {
  const failing: SampleRecorder = {
    async captureSample() {
      throw new Error("database unavailable");
    },
  };
  const sampler = new MonitoringSampler(failing, 15, 24);

  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    await sampler.sampleOnce();
  } finally {
    console.error = originalError;
  }

  assert.equal(logged.length, 1, "the failure is reported");
  assert.equal(
    sampler.active,
    false,
    "a missed observation must never take the orchestrator down",
  );
});

test("overlapping sampling passes are skipped rather than queued", async () => {
  let started = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const slow: SampleRecorder = {
    async captureSample(): Promise<SampleCaptureResult> {
      started += 1;
      await gate;
      return { capturedAt: now.toISOString(), workersRecorded: 3, prunedSamples: 0 };
    },
  };

  const sampler = new MonitoringSampler(slow, 1, 24);
  const first = sampler.sampleOnce();
  const second = sampler.sampleOnce();

  assert.equal(started, 1, "a pass already in flight blocks the next one");
  release();
  await Promise.all([first, second]);

  await sampler.sampleOnce();
  assert.equal(started, 2, "once the pass finishes, sampling resumes");
});
