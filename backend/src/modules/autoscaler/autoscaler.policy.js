import { WorkerStatus } from "@prisma/client";
import { SCHEDULABLE_WORKER_STATUSES } from "../placement/placement.accounting.js";
/** Prefix of every worker the autoscaler creates. */
export const AUTOSCALED_WORKER_PREFIX = "auto-worker-";
/** Fraction of host memory the combined worker budgets may claim. */
export const HOST_MEMORY_FRACTION = 0.75;
export const ScaleAction = Object.freeze({
  SCALE_UP: "SCALE_UP",
  SCALE_DOWN: "SCALE_DOWN",
  NONE: "NONE",
});
/**
 * How the scaling rule reads load. Exactly one is active at a time, so the two
 * can be compared on identical workloads: REACTIVE uses the load measured now,
 * ML uses the load a regression predicts a short time ahead.
 */
export const ScalingStrategy = Object.freeze({
  REACTIVE: "REACTIVE",
  ML: "ML",
});
/** Fewest history points the ML strategy needs before it may act. */
export const MIN_FORECAST_POINTS = 3;
function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
function percent(value) {
  return `${Math.round(value * 100)}%`;
}
/**
 * Reserved share of the cluster's CPU and memory across schedulable workers.
 * An empty cluster reports full utilization: there is nowhere to run anything.
 */
export function clusterUtilization(workers) {
  const totals = workers.reduce(
    (sum, worker) => ({
      cpuCapacity: sum.cpuCapacity + worker.cpuCapacityMillicores,
      cpuAllocated: sum.cpuAllocated + worker.cpuAllocatedMillicores,
      memoryCapacity: sum.memoryCapacity + worker.memoryCapacityMiB,
      memoryAllocated: sum.memoryAllocated + worker.memoryAllocatedMiB,
    }),
    { cpuCapacity: 0, cpuAllocated: 0, memoryCapacity: 0, memoryAllocated: 0 },
  );
  const cpu = totals.cpuCapacity > 0
    ? Math.min(1, totals.cpuAllocated / totals.cpuCapacity) : 1;
  const memory = totals.memoryCapacity > 0
    ? Math.min(1, totals.memoryAllocated / totals.memoryCapacity) : 1;
  return { cpu: round(cpu), memory: round(memory), peak: round(Math.max(cpu, memory)) };
}
/**
 * Ordinary least-squares fit of y = slope * x + intercept. Too few points, or
 * points that all share one x, give a flat line through the mean.
 */
export function linearRegression(xs, ys) {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const sumX = xs.reduce((sum, x) => sum + x, 0);
  const sumY = ys.reduce((sum, y) => sum + y, 0);
  if (n < 2) return { slope: 0, intercept: sumY / n };
  const sumXY = xs.reduce((sum, x, index) => sum + x * ys[index], 0);
  const sumXX = xs.reduce((sum, x) => sum + x * x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denominator;
  return { slope, intercept: (sumY - slope * sumX) / n };
}
/**
 * Predicts waiting jobs and peak reserved utilization `lookAheadSeconds` after
 * the newest history point, by fitting a line to each series over time.
 * Returns null until there are enough points to fit a trend.
 *
 * @param {{ at: Date, queuedJobs: number, peak: number }[]} history oldest first
 */
export function forecastLoad(history, lookAheadSeconds) {
  if (history.length < MIN_FORECAST_POINTS) return null;
  const start = history[0].at.getTime();
  const xs = history.map((point) => (point.at.getTime() - start) / 1_000);
  const target = xs[xs.length - 1] + lookAheadSeconds;
  const queue = linearRegression(xs, history.map((point) => point.queuedJobs));
  const peak = linearRegression(xs, history.map((point) => point.peak));
  return {
    queuedJobs: round(Math.max(0, queue.slope * target + queue.intercept)),
    peak: round(Math.min(1, Math.max(0, peak.slope * target + peak.intercept))),
    queueSlopePerMinute: round(queue.slope * 60),
    lookAheadSeconds,
    points: history.length,
  };
}
/** The number in `auto-worker-N`, or 0 for any other name. */
export function autoscaledIndex(name) {
  if (!name.startsWith(AUTOSCALED_WORKER_PREFIX)) return 0;
  const parsed = Number(name.slice(AUTOSCALED_WORKER_PREFIX.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
/** The next unused autoscaled worker name. */
export function nextAutoscaledName(names) {
  const highest = names.reduce((max, name) => Math.max(max, autoscaledIndex(name)), 0);
  return `${AUTOSCALED_WORKER_PREFIX}${highest + 1}`;
}
/**
 * An autoscaled worker that holds nothing, has nothing planned on it, and has
 * been that way for the idle period. `updatedAt` moves whenever its counters
 * change, so it marks when the last reservation was released.
 */
export function isRetirable(worker, now, idleSeconds) {
  return (
    worker.autoscaled &&
    worker.status !== WorkerStatus.RETIRED &&
    worker.cpuAllocatedMillicores === 0 &&
    worker.memoryAllocatedMiB === 0 &&
    worker.reservedAllocations === 0 &&
    worker.activeAssignedJobs === 0 &&
    now.getTime() - worker.updatedAt.getTime() >= idleSeconds * 1_000
  );
}
function schedulableWorkers(snapshot) {
  return snapshot.workers.filter((worker) =>
    worker.status !== WorkerStatus.RETIRED && SCHEDULABLE_WORKER_STATUSES.includes(worker.status));
}
/** The load measured in a snapshot, as one point of ML history. */
export function currentLoad(snapshot, now) {
  return {
    at: now,
    queuedJobs: snapshot.queuedJobs,
    peak: clusterUtilization(schedulableWorkers(snapshot)).peak,
  };
}
/**
 * The scaling decision. Pure: it reads a snapshot and returns what to do, so
 * the rules can be tested without a database.
 *
 * Scale up when enough eligible jobs are waiting and the cluster is already
 * mostly reserved. Scale down one idle autoscaled worker when the queue is
 * short and the cluster would still be comfortably below the scale-up line
 * without it. The gap between the two thresholds and the cooldown between
 * actions keep the cluster from flapping. While autoscaling is disabled, idle
 * autoscaled workers are still retired so the cluster drains back to its base.
 *
 * Both strategies apply this same rule, limits, and cooldown, and add or retire
 * workers the same way; only the load they test differs. REACTIVE tests the
 * load measured now. ML tests `snapshot.forecast`, the load predicted a short
 * time ahead, so it can add capacity before the queue builds and keeps a
 * worker while load is predicted to return. ML also never retires on the
 * measured load alone: the forecast must stay low as well.
 */
export function decideScaling(snapshot, config, now) {
  const strategy = config.strategy ?? ScalingStrategy.REACTIVE;
  const ml = strategy === ScalingStrategy.ML;
  const active = snapshot.workers.filter((worker) => worker.status !== WorkerStatus.RETIRED);
  const schedulable = schedulableWorkers(snapshot);
  const utilization = clusterUtilization(schedulable);
  const autoscaledActive = active.filter((worker) => worker.autoscaled);
  const forecast = ml ? snapshot.forecast ?? null : null;
  const signals = {
    queuedJobs: snapshot.queuedJobs,
    utilization,
    workerCount: schedulable.length,
    autoscaledWorkers: autoscaledActive.length,
    ...(ml ? { forecast } : {}),
  };
  const tag = (reason) => (ml ? `[ML] ${reason}` : reason);
  const none = (reason) => ({ action: ScaleAction.NONE, reason: tag(reason), strategy, signals });
  if (snapshot.lastActionAt) {
    const remaining = config.cooldownSeconds * 1_000 -
      (now.getTime() - snapshot.lastActionAt.getTime());
    if (remaining > 0) {
      return none(`Cooling down for ${Math.ceil(remaining / 1_000)}s after the last scaling action`);
    }
  }
  // ML cannot act until it has enough history to fit a trend. Draining idle
  // workers while autoscaling is off does not depend on load, so it still runs.
  const awaitingHistory = config.enabled && ml && !forecast;
  const predicted = forecast
    ? `${forecast.queuedJobs.toFixed(1)} job(s) waiting with the cluster ` +
      `${percent(forecast.peak)} reserved in ${forecast.lookAheadSeconds}s`
    : null;
  const load = forecast ?? { queuedJobs: snapshot.queuedJobs, peak: utilization.peak };
  const pressured = !awaitingHistory &&
    load.queuedJobs >= config.scaleUpQueueThreshold &&
    load.peak >= config.scaleUpUtilization;
  if (config.enabled && pressured) {
    if (autoscaledActive.length >= config.maxWorkers) {
      return none(`Under pressure, but already at the ${config.maxWorkers} autoscaled worker limit`);
    }
    const budgetMiB = active.reduce((sum, worker) => sum + worker.memoryCapacityMiB, 0) +
      config.workerMemoryMiB;
    if (budgetMiB > snapshot.hostMemoryLimitMiB) {
      return none(
        `Under pressure, but another ${config.workerMemoryMiB} MiB worker would exceed ` +
        `the ${snapshot.hostMemoryLimitMiB} MiB host memory limit`,
      );
    }
    const reuse = snapshot.retiredAutoscaled[0] ?? null;
    const measured = `${snapshot.queuedJobs} job(s) waiting with the cluster ${percent(utilization.peak)} reserved`;
    return {
      action: ScaleAction.SCALE_UP,
      reason: tag(predicted ? `Forecast ${predicted} (now ${measured})` : measured),
      workerName: reuse?.name ?? nextAutoscaledName(snapshot.autoscaledNames),
      reuseWorkerId: reuse?.id ?? null,
      strategy,
      signals,
    };
  }
  const candidate = autoscaledActive
    .filter((worker) => isRetirable(worker, now, config.idleSeconds))
    .sort((left, right) => autoscaledIndex(right.name) - autoscaledIndex(left.name))[0];
  if (candidate) {
    if (!config.enabled) {
      return {
        action: ScaleAction.SCALE_DOWN,
        reason: tag(`Autoscaling is off; retiring idle ${candidate.name}`),
        workerId: candidate.id,
        workerName: candidate.name,
        strategy,
        signals,
      };
    }
    const remaining = schedulable.filter((worker) => worker.id !== candidate.id);
    const after = clusterUtilization(remaining);
    const quietNow = snapshot.queuedJobs < config.scaleUpQueueThreshold &&
      after.peak < config.scaleDownUtilization;
    const quietAhead = !ml || (forecast !== null &&
      forecast.queuedJobs < config.scaleUpQueueThreshold &&
      forecast.peak < config.scaleDownUtilization);
    if (quietNow && quietAhead) {
      return {
        action: ScaleAction.SCALE_DOWN,
        reason: tag(`${candidate.name} idle for ${config.idleSeconds}s+; cluster would be ` +
          `${percent(after.peak)} reserved without it` +
          (predicted ? `; forecast ${predicted}` : "")),
        workerId: candidate.id,
        workerName: candidate.name,
        strategy,
        signals,
      };
    }
  }
  if (!config.enabled) return none("Autoscaling is off");
  if (awaitingHistory) {
    return none(
      `Collecting load history (${snapshot.historyPoints ?? 0}/${MIN_FORECAST_POINTS} points) before forecasting`,
    );
  }
  return none(predicted
    ? `Within thresholds: forecast ${predicted}`
    : `Within thresholds: ${snapshot.queuedJobs} waiting, cluster ${percent(utilization.peak)} reserved`);
}
