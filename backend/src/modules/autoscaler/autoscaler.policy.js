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
/**
 * The reactive scaling decision. Pure: it reads a snapshot and returns what to
 * do, so the rules can be tested without a database.
 *
 * Scale up when enough eligible jobs are waiting and the cluster is already
 * mostly reserved. Scale down one idle autoscaled worker when the queue is
 * short and the cluster would still be comfortably below the scale-up line
 * without it. The gap between the two thresholds and the cooldown between
 * actions keep the cluster from flapping. While autoscaling is disabled, idle
 * autoscaled workers are still retired so the cluster drains back to its base.
 */
export function decideScaling(snapshot, config, now) {
  const active = snapshot.workers.filter((worker) => worker.status !== WorkerStatus.RETIRED);
  const schedulable = active.filter((worker) =>
    SCHEDULABLE_WORKER_STATUSES.includes(worker.status));
  const utilization = clusterUtilization(schedulable);
  const autoscaledActive = active.filter((worker) => worker.autoscaled);
  const signals = {
    queuedJobs: snapshot.queuedJobs,
    utilization,
    workerCount: schedulable.length,
    autoscaledWorkers: autoscaledActive.length,
  };
  const none = (reason) => ({ action: ScaleAction.NONE, reason, signals });
  if (snapshot.lastActionAt) {
    const remaining = config.cooldownSeconds * 1_000 -
      (now.getTime() - snapshot.lastActionAt.getTime());
    if (remaining > 0) {
      return none(`Cooling down for ${Math.ceil(remaining / 1_000)}s after the last scaling action`);
    }
  }
  const pressured = snapshot.queuedJobs >= config.scaleUpQueueThreshold &&
    utilization.peak >= config.scaleUpUtilization;
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
    return {
      action: ScaleAction.SCALE_UP,
      reason: `${snapshot.queuedJobs} job(s) waiting with the cluster ${percent(utilization.peak)} reserved`,
      workerName: reuse?.name ?? nextAutoscaledName(snapshot.autoscaledNames),
      reuseWorkerId: reuse?.id ?? null,
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
        reason: `Autoscaling is off; retiring idle ${candidate.name}`,
        workerId: candidate.id,
        workerName: candidate.name,
        signals,
      };
    }
    const remaining = schedulable.filter((worker) => worker.id !== candidate.id);
    const after = clusterUtilization(remaining);
    if (snapshot.queuedJobs < config.scaleUpQueueThreshold &&
        after.peak < config.scaleDownUtilization) {
      return {
        action: ScaleAction.SCALE_DOWN,
        reason: `${candidate.name} idle for ${config.idleSeconds}s+; cluster would be ` +
          `${percent(after.peak)} reserved without it`,
        workerId: candidate.id,
        workerName: candidate.name,
        signals,
      };
    }
  }
  if (!config.enabled) return none("Autoscaling is off");
  return none(
    `Within thresholds: ${snapshot.queuedJobs} waiting, cluster ${percent(utilization.peak)} reserved`,
  );
}
