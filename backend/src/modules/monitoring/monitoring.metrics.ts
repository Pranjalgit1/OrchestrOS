import type { Worker, WorkerSample, WorkerStatus } from "@prisma/client";

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
] as const;

export type TimingMetric = (typeof TIMING_METRICS)[number];

export interface DurationStats {
  count: number;
  averageSeconds: number | null;
  minimumSeconds: number | null;
  maximumSeconds: number | null;
  p95Seconds: number | null;
}

export type TimingSummary = Record<TimingMetric, DurationStats>;

/** Shape returned by the grouped duration query. */
export interface RawDurationRow {
  metric: string;
  count: number | bigint;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
  p95: number | null;
}

export interface ClusterUtilization {
  workerCount: number;
  schedulableWorkers: number;
  cpuCapacityMillicores: number;
  cpuAllocatedMillicores: number;
  cpuAvailableMillicores: number;
  cpuUtilization: number;
  memoryCapacityMiB: number;
  memoryAllocatedMiB: number;
  memoryAvailableMiB: number;
  memoryUtilization: number;
  workersByStatus: Record<string, number>;
}

export interface UtilizationPoint {
  capturedAt: Date;
  workerCount: number;
  cpuCapacityMillicores: number;
  cpuAllocatedMillicores: number;
  cpuUtilization: number;
  memoryCapacityMiB: number;
  memoryAllocatedMiB: number;
  memoryUtilization: number;
  runningExecutions: number;
  reservedAllocations: number;
}

/** Clamped to 0..1 so a reporting bug can never present as impossible load. */
export function ratio(used: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return Math.min(1, Math.max(0, used / capacity));
}

/** Rounds to four decimals so JSON stays readable and comparable. */
export function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const EMPTY_STATS: DurationStats = {
  count: 0,
  averageSeconds: null,
  minimumSeconds: null,
  maximumSeconds: null,
  p95Seconds: null,
};

/** Worker states that may receive work, mirroring placement's definition. */
const SCHEDULABLE: readonly WorkerStatus[] = ["IDLE", "ACTIVE", "BUSY"] as WorkerStatus[];

type WorkerCounters = Pick<
  Worker,
  | "status"
  | "cpuCapacityMillicores"
  | "cpuAllocatedMillicores"
  | "memoryCapacityMiB"
  | "memoryAllocatedMiB"
>;

/**
 * Totals the cluster's committed load.
 *
 * `cpuAllocatedMillicores` counts reservations only, so this reports capacity
 * actually claimed rather than advisory placement intent.
 */
export function summariseCluster(workers: readonly WorkerCounters[]): ClusterUtilization {
  const workersByStatus: Record<string, number> = {};
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
export function summariseTimings(rows: readonly RawDurationRow[]): TimingSummary {
  const summary = {} as TimingSummary;
  for (const metric of TIMING_METRICS) {
    summary[metric] = { ...EMPTY_STATS };
  }

  for (const row of rows) {
    if (!(TIMING_METRICS as readonly string[]).includes(row.metric)) continue;
    const metric = row.metric as TimingMetric;
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
export function utilizationSeries(
  samples: readonly WorkerSample[],
): UtilizationPoint[] {
  const grouped = new Map<number, UtilizationPoint>();

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
      cpuUtilization: round(ratio(point.cpuAllocatedMillicores, point.cpuCapacityMillicores)),
      memoryUtilization: round(ratio(point.memoryAllocatedMiB, point.memoryCapacityMiB)),
    }));
}

/**
 * Completion rate over the window.
 *
 * Reported per minute because a prototype run is measured in minutes; the window
 * itself is echoed so the denominator is never ambiguous.
 */
export function completionRatePerMinute(terminalJobs: number, windowMinutes: number): number {
  if (windowMinutes <= 0) return 0;
  return round(terminalJobs / windowMinutes, 3);
}
