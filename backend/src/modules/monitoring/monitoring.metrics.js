/**
 * Pure metric arithmetic.
 *
 * Nothing here touches Prisma or a clock. Set aggregation that SQL does better
 * stays in the repository; this module holds the small calculations worth
 * pinning with unit tests.
 */
/** The five stages a job passes through, measured from its own timestamps. */
export const TIMING_METRICS = [
  "queueWait",
  "placementDelay",
  "startDelay",
  "execution",
  "turnaround",
];
/** Clamped to 0..1 so a reporting bug can never present as impossible load. */
export function ratio(used, capacity) {
  if (capacity <= 0) return 0;
  return Math.min(1, Math.max(0, used / capacity));
}
/** Rounds to four decimals so JSON stays readable and comparable. */
export function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
const EMPTY_STATS = {
  count: 0,
  averageSeconds: null,
  minimumSeconds: null,
  maximumSeconds: null,
  p95Seconds: null,
};
/** Worker states that may receive work, mirroring placement's definition. */
const SCHEDULABLE = ["IDLE", "ACTIVE", "BUSY"];
/**
 * Totals the cluster's committed load.
 *
 * `cpuAllocatedMillicores` counts reservations only, so this reports capacity
 * actually claimed rather than advisory placement intent.
 */
export function summariseCluster(workers) {
  const workersByStatus = {};
  let cpuCapacity = 0;
  let cpuAllocated = 0;
  let memoryCapacity = 0;
  let memoryAllocated = 0;
  let schedulable = 0;
  for (const worker of workers) {
    cpuCapacity += worker.cpuCapacityMillicores;
    cpuAllocated += worker.cpuAllocatedMillicores;
    memoryCapacity += worker.memoryCapacityMiB;
    memoryAllocated += worker.memoryAllocatedMiB;
    workersByStatus[worker.status] = (workersByStatus[worker.status] ?? 0) + 1;
    if (SCHEDULABLE.includes(worker.status)) schedulable += 1;
  }
  return {
    workerCount: workers.length,
    schedulableWorkers: schedulable,
    cpuCapacityMillicores: cpuCapacity,
    cpuAllocatedMillicores: cpuAllocated,
    cpuAvailableMillicores: Math.max(0, cpuCapacity - cpuAllocated),
    cpuUtilization: round(ratio(cpuAllocated, cpuCapacity)),
    memoryCapacityMiB: memoryCapacity,
    memoryAllocatedMiB: memoryAllocated,
    memoryAvailableMiB: Math.max(0, memoryCapacity - memoryAllocated),
    memoryUtilization: round(ratio(memoryAllocated, memoryCapacity)),
    workersByStatus,
  };
}
/**
 * Fills in every timing metric, including the ones the query returned no rows
 * for, so a caller never has to distinguish "absent" from "nothing measured".
 */
export function summariseTimings(rows) {
  const summary = {};
  for (const metric of TIMING_METRICS) {
    summary[metric] = { ...EMPTY_STATS };
  }
  for (const row of rows) {
    if (!TIMING_METRICS.includes(row.metric)) continue;
    const metric = row.metric;
    const count = Number(row.count);
    summary[metric] = {
      count,
      averageSeconds: row.average === null ? null : round(row.average, 3),
      minimumSeconds: row.minimum === null ? null : round(row.minimum, 3),
      maximumSeconds: row.maximum === null ? null : round(row.maximum, 3),
      p95Seconds: row.p95 === null ? null : round(row.p95, 3),
    };
  }
  return summary;
}
/**
 * Collapses per-worker samples into cluster utilization over time.
 *
 * Every worker written by one sampling pass shares a `capturedAt`, so grouping
 * on it reconstructs the cluster as it stood at that instant. Points come back
 * oldest first, which is the order a chart wants.
 */
export function utilizationSeries(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    const key = sample.capturedAt.getTime();
    const point = grouped.get(key) ?? {
      capturedAt: sample.capturedAt,
      workerCount: 0,
      cpuCapacityMillicores: 0,
      cpuAllocatedMillicores: 0,
      cpuUtilization: 0,
      memoryCapacityMiB: 0,
      memoryAllocatedMiB: 0,
      memoryUtilization: 0,
      runningExecutions: 0,
      reservedAllocations: 0,
    };
    point.workerCount += 1;
    point.cpuCapacityMillicores += sample.cpuCapacityMillicores;
    point.cpuAllocatedMillicores += sample.cpuAllocatedMillicores;
    point.memoryCapacityMiB += sample.memoryCapacityMiB;
    point.memoryAllocatedMiB += sample.memoryAllocatedMiB;
    point.runningExecutions += sample.runningExecutions;
    point.reservedAllocations += sample.reservedAllocations;
    grouped.set(key, point);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, point]) => ({
      ...point,
      cpuUtilization: round(
        ratio(point.cpuAllocatedMillicores, point.cpuCapacityMillicores),
      ),
      memoryUtilization: round(
        ratio(point.memoryAllocatedMiB, point.memoryCapacityMiB),
      ),
    }));
}
/**
 * Completion rate over the window.
 *
 * Reported per minute because a prototype run is measured in minutes; the window
 * itself is echoed so the denominator is never ambiguous.
 */
export function completionRatePerMinute(terminalJobs, windowMinutes) {
  if (windowMinutes <= 0) return 0;
  return round(terminalJobs / windowMinutes, 3);
}
