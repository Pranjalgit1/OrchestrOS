import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WorkerStatus } from "@prisma/client";
import {
  ScaleAction,
  ScalingStrategy,
  clusterUtilization,
  decideScaling,
  forecastLoad,
  isRetirable,
  linearRegression,
  nextAutoscaledName,
} from "../src/modules/autoscaler/autoscaler.policy.js";
import { updateAutoscalerSchema } from "../src/modules/autoscaler/autoscaler.schemas.js";
import { AutoscalerService } from "../src/modules/autoscaler/autoscaler.service.js";
const now = new Date("2026-10-21T12:00:00.000Z");
const config = {
  enabled: true,
  maxWorkers: 2,
  workerCpuMillicores: 1_000,
  workerMemoryMiB: 512,
  scaleUpQueueThreshold: 2,
  scaleUpUtilization: 0.75,
  scaleDownUtilization: 0.4,
  idleSeconds: 30,
  cooldownSeconds: 15,
};
function worker(overrides = {}) {
  return {
    id: randomUUID(),
    name: "worker-1",
    status: WorkerStatus.IDLE,
    autoscaled: false,
    cpuCapacityMillicores: 1_000,
    memoryCapacityMiB: 1_024,
    cpuAllocatedMillicores: 0,
    memoryAllocatedMiB: 0,
    reservedAllocations: 0,
    activeAssignedJobs: 0,
    updatedAt: new Date(now.getTime() - 120_000),
    ...overrides,
  };
}
const busy = (overrides = {}) => worker({
  status: WorkerStatus.BUSY,
  cpuAllocatedMillicores: 900,
  memoryAllocatedMiB: 300,
  reservedAllocations: 2,
  activeAssignedJobs: 2,
  updatedAt: now,
  ...overrides,
});
function snapshot(overrides = {}) {
  return {
    workers: [busy({ name: "worker-1" }), busy({ name: "worker-2" })],
    retiredAutoscaled: [],
    autoscaledNames: [],
    queuedJobs: 5,
    lastActionAt: null,
    hostMemoryLimitMiB: 8_192,
    ...overrides,
  };
}
test("cluster utilization is the reserved share, and an empty cluster has no room", () => {
  assert.deepEqual(clusterUtilization([busy(), worker()]), { cpu: 0.45, memory: 0.1465, peak: 0.45 });
  assert.equal(clusterUtilization([]).peak, 1);
});
test("autoscaled names count up from the highest existing number", () => {
  assert.equal(nextAutoscaledName([]), "auto-worker-1");
  assert.equal(nextAutoscaledName(["auto-worker-2", "auto-worker-10", "worker-3"]), "auto-worker-11");
});
test("waiting work on a mostly reserved cluster scales up", () => {
  const decision = decideScaling(snapshot(), config, now);
  assert.equal(decision.action, ScaleAction.SCALE_UP);
  assert.equal(decision.workerName, "auto-worker-1");
  assert.equal(decision.reuseWorkerId, null);
  assert.match(decision.reason, /5 job\(s\) waiting with the cluster 90% reserved/);
  assert.equal(decision.signals.workerCount, 2);
});
test("scale up reuses a retired autoscaled worker before creating a new one", () => {
  const retired = { id: randomUUID(), name: "auto-worker-1" };
  const decision = decideScaling(snapshot({
    retiredAutoscaled: [retired], autoscaledNames: ["auto-worker-1"] }), config, now);
  assert.equal(decision.reuseWorkerId, retired.id);
  assert.equal(decision.workerName, "auto-worker-1");
});
test("scale up needs both a queue and high utilization", () => {
  assert.equal(decideScaling(snapshot({ queuedJobs: 1 }), config, now).action, ScaleAction.NONE);
  const roomy = snapshot({ workers: [busy(), worker({ name: "worker-2" })] });
  assert.equal(decideScaling(roomy, config, now).action, ScaleAction.NONE,
    "45% reserved is below the 75% line even with jobs waiting");
});
test("scale up respects the worker limit, the host memory limit, and the cooldown", () => {
  const atLimit = snapshot({ workers: [busy(), busy({ name: "auto-worker-1", autoscaled: true }),
    busy({ name: "auto-worker-2", autoscaled: true })] });
  assert.match(decideScaling(atLimit, config, now).reason, /2 autoscaled worker limit/);
  const tightHost = snapshot({ hostMemoryLimitMiB: 2_200 });
  assert.match(decideScaling(tightHost, config, now).reason, /host memory limit/);
  const recent = snapshot({ lastActionAt: new Date(now.getTime() - 5_000) });
  const cooling = decideScaling(recent, config, now);
  assert.equal(cooling.action, ScaleAction.NONE);
  assert.match(cooling.reason, /Cooling down for 10s/);
});
test("disabled autoscaling never scales up", () => {
  assert.equal(decideScaling(snapshot(), { ...config, enabled: false }, now).action, ScaleAction.NONE);
});
test("an idle autoscaled worker is retired when the cluster stays quiet without it", () => {
  const idle = worker({ name: "auto-worker-2", autoscaled: true });
  const older = worker({ name: "auto-worker-1", autoscaled: true });
  const decision = decideScaling(snapshot({
    workers: [busy({ cpuAllocatedMillicores: 200, memoryAllocatedMiB: 100 }), older, idle],
    queuedJobs: 0,
  }), config, now);
  assert.equal(decision.action, ScaleAction.SCALE_DOWN);
  assert.equal(decision.workerId, idle.id, "the newest autoscaled worker goes first");
});
test("scale down keeps workers that are busy, planned on, or only recently idle", () => {
  const base = busy({ cpuAllocatedMillicores: 100, memoryAllocatedMiB: 64 });
  for (const candidate of [
    worker({ autoscaled: true, name: "auto-worker-1", reservedAllocations: 1, cpuAllocatedMillicores: 100 }),
    worker({ autoscaled: true, name: "auto-worker-1", activeAssignedJobs: 1 }),
    worker({ autoscaled: true, name: "auto-worker-1", updatedAt: new Date(now.getTime() - 10_000) }),
    worker({ name: "worker-9" }),
  ]) {
    assert.equal(isRetirable(candidate, now, 30), false);
    assert.equal(decideScaling(snapshot({ workers: [base, candidate], queuedJobs: 0 }), config, now).action,
      ScaleAction.NONE);
  }
});
test("scale down waits while the remaining cluster would be too full", () => {
  const idle = worker({ name: "auto-worker-1", autoscaled: true });
  const decision = decideScaling(snapshot({ workers: [busy(), idle], queuedJobs: 0 }), config, now);
  assert.equal(decision.action, ScaleAction.NONE, "90% reserved without it is above the 40% line");
});
test("turning autoscaling off drains idle autoscaled workers", () => {
  const idle = worker({ name: "auto-worker-1", autoscaled: true });
  const decision = decideScaling(snapshot({ workers: [busy(), idle] }), { ...config, enabled: false }, now);
  assert.equal(decision.action, ScaleAction.SCALE_DOWN);
  assert.match(decision.reason, /Autoscaling is off/);
});
class FakeRepository {
  snapshots = [];
  scaled = [];
  outcome = { status: "SCALED" };
  async readSnapshot() {
    return this.snapshots.shift() ?? snapshot({ queuedJobs: 0 });
  }
  async scaleUp(decision, capacity) {
    this.scaled.push({ decision, capacity });
    return this.outcome;
  }
  async scaleDown(decision) {
    this.scaled.push({ decision });
    return this.outcome;
  }
  async listEvents() {
    return [];
  }
}
test("the service applies a scale up with the configured worker capacity", async () => {
  const repository = new FakeRepository();
  repository.snapshots.push(snapshot());
  const service = new AutoscalerService(repository, {
    config, intervalSeconds: 0, clock: () => now, hostMemoryMiB: () => 16_384 });
  const decision = await service.evaluate();
  assert.equal(decision.action, ScaleAction.SCALE_UP);
  assert.equal(decision.applied, true);
  assert.deepEqual(repository.scaled[0].capacity, { cpuMillicores: 1_000, memoryMiB: 512 });
  assert.equal((await service.status()).lastDecision.action, ScaleAction.SCALE_UP);
  assert.equal((await service.status()).hostMemoryLimitMiB, 12_288);
});
test("a target that changed under the decision is reported as skipped", async () => {
  const repository = new FakeRepository();
  repository.snapshots.push(snapshot());
  repository.outcome = { status: "STALE" };
  const service = new AutoscalerService(repository, { config, intervalSeconds: 0, clock: () => now });
  const decision = await service.evaluate();
  assert.equal(decision.applied, false);
  assert.match(decision.reason, /skipped: target stale/);
});
test("evaluations never overlap", async () => {
  const repository = new FakeRepository();
  let release;
  repository.readSnapshot = () => new Promise((resolve) => {
    release = () => resolve(snapshot({ queuedJobs: 0 }));
  });
  const service = new AutoscalerService(repository, { config, intervalSeconds: 0, clock: () => now });
  const first = service.evaluate();
  const second = await service.evaluate();
  assert.match(second.reason, /in progress/);
  release();
  assert.equal((await first).action, ScaleAction.NONE);
});
test("a failing pass is logged and the loop keeps going", async () => {
  const repository = new FakeRepository();
  repository.readSnapshot = async () => { throw new Error("database busy"); };
  const service = new AutoscalerService(repository, { config, intervalSeconds: 0 });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await service.tick();
  } finally {
    console.error = originalError;
  }
  assert.match(logged[0], /database busy/);
  assert.equal(service.running, false);
});
test("settings are validated, and thresholds that would flap are refused", () => {
  const service = new AutoscalerService(new FakeRepository(), { config, intervalSeconds: 0 });
  assert.equal(service.updateConfig({ enabled: false }).enabled, false);
  assert.throws(() => service.updateConfig({ scaleDownUtilization: 0.8 }),
    { code: "INVALID_AUTOSCALER_CONFIG", statusCode: 400 });
  assert.equal(service.config.scaleDownUtilization, 0.4, "a refused change leaves settings alone");
  assert.equal(updateAutoscalerSchema.safeParse({ enabled: true }).success, true);
  assert.equal(updateAutoscalerSchema.safeParse({ maxWorkers: 99 }).success, false);
  assert.equal(updateAutoscalerSchema.safeParse({ interval: 1 }).success, false,
    "unknown fields are rejected");
});
test("the timer only starts when an interval is configured", () => {
  const off = new AutoscalerService(new FakeRepository(), { config, intervalSeconds: 0 });
  off.start();
  assert.equal(off.timer, null);
  const on = new AutoscalerService(new FakeRepository(), { config, intervalSeconds: 60 });
  on.start();
  assert.notEqual(on.timer, null);
  on.stop();
  assert.equal(on.timer, null);
});

// --- ML strategy ----------------------------------------------------------
const mlConfig = { ...config, strategy: ScalingStrategy.ML, mlWindowPoints: 20, mlLookAheadSeconds: 60 };
/** Points `stepSeconds` apart ending at `now`, oldest first. */
function history(points, stepSeconds = 5) {
  return points.map(([queuedJobs, peak], index) => ({
    at: new Date(now.getTime() - (points.length - 1 - index) * stepSeconds * 1_000),
    queuedJobs,
    peak,
  }));
}
test("linear regression recovers a line and stays flat when it cannot fit one", () => {
  const fit = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 1);
  assert.deepEqual(linearRegression([4, 4], [2, 6]), { slope: 0, intercept: 4 });
  assert.deepEqual(linearRegression([], []), { slope: 0, intercept: 0 });
});
test("the forecast extrapolates the trend and clamps to possible values", () => {
  assert.equal(forecastLoad(history([[0, 0.1], [1, 0.2]]), 60), null, "two points are too few");
  const rising = forecastLoad(history([[0, 0.2], [1, 0.3], [2, 0.4]]), 10);
  // One job and 10 points per 5s: 10s past the last point adds two more steps.
  assert.equal(rising.queuedJobs, 4);
  assert.equal(rising.peak, 0.6);
  assert.equal(rising.queueSlopePerMinute, 12);
  const clamped = forecastLoad(history([[6, 0.9], [3, 1], [0, 1]]), 60);
  assert.equal(clamped.queuedJobs, 0, "a falling queue never predicts negative jobs");
  assert.equal(clamped.peak, 1, "utilization never predicts above 100%");
});
test("ML scales up on a rising forecast before the measured load crosses the line", () => {
  // Measured: one job waiting on a 45% reserved cluster, so REACTIVE holds.
  const quiet = snapshot({ workers: [busy(), worker({ name: "worker-2" })], queuedJobs: 1 });
  assert.equal(decideScaling(quiet, config, now).action, ScaleAction.NONE);
  const forecast = { queuedJobs: 4, peak: 0.9, queueSlopePerMinute: 3, lookAheadSeconds: 60, points: 6 };
  const decision = decideScaling({ ...quiet, forecast }, mlConfig, now);
  assert.equal(decision.action, ScaleAction.SCALE_UP);
  assert.equal(decision.strategy, ScalingStrategy.ML);
  assert.match(decision.reason, /^\[ML\] Forecast 4\.0 job\(s\) waiting with the cluster 90% reserved in 60s \(now 1 job/);
  assert.deepEqual(decision.signals.forecast, forecast);
});
test("ML holds on a falling forecast even while the measured load is high", () => {
  const forecast = { queuedJobs: 0, peak: 0.3, queueSlopePerMinute: -6, lookAheadSeconds: 60, points: 6 };
  assert.equal(decideScaling(snapshot(), config, now).action, ScaleAction.SCALE_UP);
  const decision = decideScaling({ ...snapshot(), forecast }, mlConfig, now);
  assert.equal(decision.action, ScaleAction.NONE);
  assert.match(decision.reason, /^\[ML\] Within thresholds: forecast 0\.0 job/);
});
test("ML waits for enough history and keeps the same limits and cooldown as REACTIVE", () => {
  const waiting = decideScaling({ ...snapshot(), forecast: null, historyPoints: 2 }, mlConfig, now);
  assert.equal(waiting.action, ScaleAction.NONE);
  assert.match(waiting.reason, /Collecting load history \(2\/3 points\)/);
  const forecast = { queuedJobs: 9, peak: 1, queueSlopePerMinute: 6, lookAheadSeconds: 60, points: 6 };
  const recent = snapshot({ forecast, lastActionAt: new Date(now.getTime() - 5_000) });
  assert.match(decideScaling(recent, mlConfig, now).reason, /Cooling down for 10s/);
  const atLimit = snapshot({ forecast, workers: [busy(), busy({ name: "auto-worker-1", autoscaled: true }),
    busy({ name: "auto-worker-2", autoscaled: true })] });
  assert.match(decideScaling(atLimit, mlConfig, now).reason, /2 autoscaled worker limit/);
});
test("ML retires a worker only when load is low now and predicted to stay low", () => {
  const idle = worker({ name: "auto-worker-1", autoscaled: true });
  const quiet = snapshot({
    workers: [busy({ cpuAllocatedMillicores: 200, memoryAllocatedMiB: 100 }), idle], queuedJobs: 0 });
  assert.equal(decideScaling(quiet, config, now).action, ScaleAction.SCALE_DOWN);
  // Below the scale-up line but above the scale-down line: load is returning.
  const returning = { queuedJobs: 1, peak: 0.6, queueSlopePerMinute: 1, lookAheadSeconds: 60, points: 6 };
  assert.equal(decideScaling({ ...quiet, forecast: returning }, mlConfig, now).action, ScaleAction.NONE,
    "load predicted to come back keeps the worker");
  const staysLow = { queuedJobs: 0, peak: 0.1, queueSlopePerMinute: 0, lookAheadSeconds: 60, points: 6 };
  const decision = decideScaling({ ...quiet, forecast: staysLow }, mlConfig, now);
  assert.equal(decision.action, ScaleAction.SCALE_DOWN);
  assert.match(decision.reason, /^\[ML\] auto-worker-1 idle .*; forecast 0\.0 job/);
});
test("the service records load every pass so either strategy can forecast", async () => {
  const repository = new FakeRepository();
  let clock = new Date(now.getTime() - 15_000);
  for (const queuedJobs of [0, 1, 2, 3]) repository.snapshots.push(snapshot({ queuedJobs }));
  const service = new AutoscalerService(repository, {
    config: { ...config, mlWindowPoints: 3 }, intervalSeconds: 0, clock: () => clock });
  for (let pass = 0; pass < 4; pass += 1) {
    await service.evaluate();
    clock = new Date(clock.getTime() + 5_000);
  }
  assert.equal(service.config.strategy, ScalingStrategy.REACTIVE, "REACTIVE is the default");
  assert.deepEqual(service.loadHistory.map((point) => point.queuedJobs), [1, 2, 3],
    "the window keeps only the newest points");
  const status = await service.status();
  assert.equal(status.forecast.points, 3);
  assert.equal(status.loadHistory.length, 3);
  assert.equal(typeof status.loadHistory[0].at, "string");
  service.updateConfig({ mlWindowPoints: 2 });
  assert.equal(service.loadHistory.length, 2, "shrinking the window trims at once");
});
test("the strategy setting accepts only REACTIVE or ML", () => {
  assert.equal(updateAutoscalerSchema.safeParse({ strategy: "ML" }).success, true);
  assert.equal(updateAutoscalerSchema.safeParse({ strategy: "BOTH" }).success, false,
    "both at once would make the two impossible to compare");
  assert.equal(updateAutoscalerSchema.safeParse({ mlWindowPoints: 2 }).success, false);
  assert.equal(updateAutoscalerSchema.safeParse({ mlLookAheadSeconds: 60 }).success, true);
});
