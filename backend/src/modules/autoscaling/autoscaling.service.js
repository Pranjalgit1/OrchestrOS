import { WorkerStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ScaleDirection } from "./autoscaling.schemas.js";

// ---------------------------------------------------------------------------
// In-memory state (resets on server restart — by design)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  mode: "OFF",
  cpuScaleUpThreshold: 0.75,
  cpuScaleDownThreshold: 0.25,
  queueDepthScaleUpThreshold: 5,
  queueDepthScaleDownThreshold: 1,
  minWorkers: 1,
  maxWorkers: 8,
  mlWindowPoints: 20,
  mlLookAheadSeconds: 60,
};

/**
 * Internal state kept in this module singleton.
 * @type {{ config: typeof DEFAULT_CONFIG, decisions: Array, metricsHistory: Array }}
 */
const state = {
  config: { ...DEFAULT_CONFIG },
  /** Last 100 scaling decisions. */
  decisions: [],
  /** Rolling window of { timestamp, cpuUtilization, queueDepth } snapshots for ML. */
  metricsHistory: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple ordinary-least-squares linear regression.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {{ slope: number, intercept: number }}
 */
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function recordDecision(direction, reason, dryRun, newWorkerCount) {
  const decision = {
    at: new Date().toISOString(),
    direction,
    reason,
    dryRun,
    newWorkerCount,
  };
  state.decisions.unshift(decision);
  if (state.decisions.length > 100) state.decisions.length = 100;
  return decision;
}

// ---------------------------------------------------------------------------
// Worker management helpers (call DB directly)
// ---------------------------------------------------------------------------

async function getWorkers() {
  return prisma.worker.findMany({ orderBy: { name: "asc" } });
}

async function addWorker(existingWorkers) {
  const index = existingWorkers.length + 1;
  // Inherit average capacity from existing workers; fall back to sensible defaults.
  const avgCpu = existingWorkers.length
    ? Math.round(
        existingWorkers.reduce((s, w) => s + w.cpuCapacityMillicores, 0) /
          existingWorkers.length,
      )
    : 1000;
  const avgMem = existingWorkers.length
    ? Math.round(
        existingWorkers.reduce((s, w) => s + w.memoryCapacityMiB, 0) /
          existingWorkers.length,
      )
    : 1024;
  const name = `worker-auto-${index}-${Date.now().toString(36)}`;
  return prisma.worker.create({
    data: {
      name,
      cpuCapacityMillicores: avgCpu,
      memoryCapacityMiB: avgMem,
      cpuAllocatedMillicores: 0,
      memoryAllocatedMiB: 0,
      status: WorkerStatus.IDLE,
    },
  });
}

async function removeIdleWorker(workers) {
  // Only remove workers with zero allocations (safe scale-down).
  const idle = workers
    .filter(
      (w) =>
        w.cpuAllocatedMillicores === 0 &&
        w.memoryAllocatedMiB === 0 &&
        w.status === WorkerStatus.IDLE,
    )
    .sort((a, b) => b.createdAt - a.createdAt); // newest first
  if (!idle.length) return null;
  const target = idle[0];
  await prisma.worker.delete({ where: { id: target.id } });
  return target;
}

async function getQueueDepth() {
  return prisma.job.count({
    where: { status: { in: ["QUEUED", "CREATED", "WAITING"] } },
  });
}

async function getClusterCpuUtilization(workers) {
  const total = workers.reduce((s, w) => s + w.cpuCapacityMillicores, 0);
  const allocated = workers.reduce((s, w) => s + w.cpuAllocatedMillicores, 0);
  return total === 0 ? 0 : allocated / total;
}

// ---------------------------------------------------------------------------
// Reactive Scaler
// ---------------------------------------------------------------------------

async function reactiveEvaluate(dryRun) {
  const cfg = state.config;
  const workers = await getWorkers();
  const queueDepth = await getQueueDepth();
  const cpuUtil = await getClusterCpuUtilization(workers);

  const scaleUp =
    cpuUtil >= cfg.cpuScaleUpThreshold ||
    queueDepth >= cfg.queueDepthScaleUpThreshold;
  const scaleDown =
    !scaleUp &&
    cpuUtil <= cfg.cpuScaleDownThreshold &&
    queueDepth <= cfg.queueDepthScaleDownThreshold;

  if (scaleUp && workers.length < cfg.maxWorkers) {
    const reason = `CPU ${(cpuUtil * 100).toFixed(1)}% ≥ ${(cfg.cpuScaleUpThreshold * 100).toFixed(0)}% or queue ${queueDepth} ≥ ${cfg.queueDepthScaleUpThreshold}`;
    let newWorker = null;
    if (!dryRun) newWorker = await addWorker(workers);
    return recordDecision(
      ScaleDirection.UP,
      `[REACTIVE] ${reason}`,
      dryRun,
      dryRun ? workers.length + 1 : workers.length + 1,
    );
  }

  if (scaleDown && workers.length > cfg.minWorkers) {
    const reason = `CPU ${(cpuUtil * 100).toFixed(1)}% ≤ ${(cfg.cpuScaleDownThreshold * 100).toFixed(0)}% and queue ${queueDepth} ≤ ${cfg.queueDepthScaleDownThreshold}`;
    let removed = null;
    if (!dryRun) removed = await removeIdleWorker(workers);
    if (removed || dryRun) {
      return recordDecision(
        ScaleDirection.DOWN,
        `[REACTIVE] ${reason}`,
        dryRun,
        workers.length - 1,
      );
    }
    return recordDecision(
      ScaleDirection.STABLE,
      "[REACTIVE] Would scale down but no idle workers available",
      dryRun,
      workers.length,
    );
  }

  return recordDecision(
    ScaleDirection.STABLE,
    `[REACTIVE] CPU ${(cpuUtil * 100).toFixed(1)}%, queue ${queueDepth} — within thresholds`,
    dryRun,
    workers.length,
  );
}

// ---------------------------------------------------------------------------
// ML Scaler
// ---------------------------------------------------------------------------

async function mlEvaluate(dryRun) {
  const cfg = state.config;
  const workers = await getWorkers();
  const now = Date.now();

  // Snapshot current metrics into history.
  const queueDepth = await getQueueDepth();
  const cpuUtil = await getClusterCpuUtilization(workers);
  state.metricsHistory.push({ timestamp: now, cpuUtil, queueDepth });
  // Trim to window size.
  if (state.metricsHistory.length > cfg.mlWindowPoints) {
    state.metricsHistory.splice(0, state.metricsHistory.length - cfg.mlWindowPoints);
  }

  const history = state.metricsHistory;

  if (history.length < 3) {
    return recordDecision(
      ScaleDirection.STABLE,
      `[ML] Collecting baseline data (${history.length}/${cfg.mlWindowPoints} points)`,
      dryRun,
      workers.length,
    );
  }

  // Normalise timestamps to seconds relative to first point.
  const t0 = history[0].timestamp;
  const xs = history.map((p) => (p.timestamp - t0) / 1000);
  const cpuYs = history.map((p) => p.cpuUtil);
  const queueYs = history.map((p) => p.queueDepth);

  const cpuReg = linearRegression(xs, cpuYs);
  const queueReg = linearRegression(xs, queueYs);

  const futureX = xs[xs.length - 1] + cfg.mlLookAheadSeconds;
  const predictedCpu = Math.min(1, Math.max(0, cpuReg.slope * futureX + cpuReg.intercept));
  const predictedQueue = Math.max(0, queueReg.slope * futureX + queueReg.intercept);

  const scaleUp =
    predictedCpu >= cfg.cpuScaleUpThreshold ||
    predictedQueue >= cfg.queueDepthScaleUpThreshold;
  const scaleDown =
    !scaleUp &&
    predictedCpu <= cfg.cpuScaleDownThreshold &&
    predictedQueue <= cfg.queueDepthScaleDownThreshold;

  const predStr = `Predicted CPU ${(predictedCpu * 100).toFixed(1)}%, queue ${predictedQueue.toFixed(1)} in ${cfg.mlLookAheadSeconds}s`;

  if (scaleUp && workers.length < cfg.maxWorkers) {
    if (!dryRun) await addWorker(workers);
    return recordDecision(
      ScaleDirection.UP,
      `[ML] ${predStr} — pre-scaling up`,
      dryRun,
      workers.length + 1,
    );
  }

  if (scaleDown && workers.length > cfg.minWorkers) {
    let removed = null;
    if (!dryRun) removed = await removeIdleWorker(workers);
    if (removed || dryRun) {
      return recordDecision(
        ScaleDirection.DOWN,
        `[ML] ${predStr} — scaling down`,
        dryRun,
        workers.length - 1,
      );
    }
    return recordDecision(
      ScaleDirection.STABLE,
      `[ML] ${predStr} — would scale down but no idle workers`,
      dryRun,
      workers.length,
    );
  }

  return recordDecision(
    ScaleDirection.STABLE,
    `[ML] ${predStr} — within predicted thresholds`,
    dryRun,
    workers.length,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const autoScalingService = {
  getConfig() {
    return { ...state.config };
  },

  updateConfig(updates) {
    Object.assign(state.config, updates);
    return { ...state.config };
  },

  async getStatus() {
    const workers = await getWorkers();
    const queueDepth = await getQueueDepth();
    const cpuUtil = await getClusterCpuUtilization(workers);
    const lastDecision = state.decisions[0] ?? null;
    return {
      mode: state.config.mode,
      config: { ...state.config },
      currentMetrics: {
        workerCount: workers.length,
        cpuUtilization: Math.round(cpuUtil * 1000) / 1000,
        queueDepth,
      },
      mlHistory: state.metricsHistory.slice(-state.config.mlWindowPoints),
      lastDecision,
      recentDecisions: state.decisions.slice(0, 20),
    };
  },

  async evaluate(dryRun = false) {
    const { mode } = state.config;
    if (mode === "OFF") {
      return [
        recordDecision(ScaleDirection.STABLE, "Auto scaling is OFF", dryRun, null),
      ];
    }

    const results = [];
    if (mode === "REACTIVE" || mode === "BOTH") {
      results.push(await reactiveEvaluate(dryRun));
    }
    if (mode === "ML" || mode === "BOTH") {
      results.push(await mlEvaluate(dryRun));
    }
    return results;
  },
};
