import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  type Worker,
  type WorkerSample,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import type { RawDurationRow } from "./monitoring.metrics.js";

/**
 * Reads for monitoring.
 *
 * Every figure here is computed from the authoritative records at read time, so
 * a metric can never disagree with the state it describes. The one exception is
 * `worker_samples`, which exists because utilization over time cannot be
 * reconstructed from current counters.
 */

export interface RunningExecutionRow {
  executionId: string;
  jobId: string;
  jobName: string;
  workerId: string;
  workerName: string;
  workloadType: string;
  attempt: number;
  containerId: string | null;
  startedAt: Date | null;
  elapsedSeconds: number;
}

export interface WorkerActivity {
  workerId: string;
  reservedAllocations: number;
  runningExecutions: number;
  executionsRun: number;
  jobsCompleted: number;
  jobsFailed: number;
}

export interface OverviewData {
  workers: Worker[];
  jobsByStatus: Record<string, number>;
  executionsByStatus: Record<string, number>;
  reservedAllocations: number;
  runningExecutions: RunningExecutionRow[];
  latestSampleAt: Date | null;
  sampleCount: number;
}

export interface SampleFilter {
  workerId?: string | undefined;
  sinceMinutes: number;
  limit: number;
}

export interface MonitoringRepository {
  overview(now: Date): Promise<OverviewData>;
  jobTimings(since: Date): Promise<RawDurationRow[]>;
  terminalJobCounts(since: Date): Promise<Record<string, number>>;
  workerActivity(): Promise<WorkerActivity[]>;
  listSamples(filter: SampleFilter, now: Date): Promise<WorkerSample[]>;
  captureSample(capturedAt: Date): Promise<number>;
  pruneSamples(before: Date): Promise<number>;
}

function tally<T extends string>(
  groups: readonly { status: T; _count: { _all: number } }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const group of groups) {
    counts[group.status] = group._count._all;
  }
  return counts;
}

export const prismaMonitoringRepository: MonitoringRepository = {
  /**
   * One read of everything the live view needs, inside a transaction so the
   * numbers describe a single consistent instant rather than a drifting one.
   */
  async overview(now) {
    return prisma.$transaction(async (tx) => {
      const [
        workers,
        jobGroups,
        executionGroups,
        reservedAllocations,
        running,
        latestSample,
        sampleCount,
      ] = await Promise.all([
        tx.worker.findMany({ orderBy: { name: "asc" } }),
        tx.job.groupBy({ by: ["status"], _count: { _all: true } }),
        tx.jobExecution.groupBy({ by: ["status"], _count: { _all: true } }),
        tx.resourceAllocation.count({ where: { status: AllocationStatus.RESERVED } }),
        tx.jobExecution.findMany({
          where: { status: { in: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING] } },
          orderBy: { startedAt: "asc" },
          take: 50,
          include: {
            job: { select: { name: true, workloadType: true } },
            worker: { select: { name: true } },
          },
        }),
        tx.workerSample.findFirst({
          orderBy: { capturedAt: "desc" },
          select: { capturedAt: true },
        }),
        tx.workerSample.count(),
      ]);

      return {
        workers,
        jobsByStatus: tally(jobGroups),
        executionsByStatus: tally(executionGroups),
        reservedAllocations,
        runningExecutions: running.map((execution) => ({
          executionId: execution.id,
          jobId: execution.jobId,
          jobName: execution.job.name,
          workerId: execution.workerId,
          workerName: execution.worker.name,
          workloadType: execution.job.workloadType,
          attempt: execution.attempt,
          containerId: execution.containerId,
          startedAt: execution.startedAt,
          elapsedSeconds: execution.startedAt
            ? Math.max(0, Math.round((now.getTime() - execution.startedAt.getTime()) / 1_000))
            : 0,
        })),
        latestSampleAt: latestSample?.capturedAt ?? null,
        sampleCount,
      };
    });
  },

  /**
   * Stage durations for jobs created inside the window.
   *
   * Prisma cannot aggregate the difference between two columns, so this is raw
   * SQL. The durations are normalised into (metric, seconds) pairs and then
   * aggregated once, which keeps the query readable and lets PostgreSQL compute
   * the percentile instead of loading every row into the process.
   */
  jobTimings(since) {
    return prisma.$queryRaw<RawDurationRow[]>`
      WITH windowed AS (
        SELECT "arrivalAt", "scheduledAt", "placedAt", "startedAt", "completedAt"
        FROM "jobs"
        WHERE "createdAt" >= ${since}
      ),
      durations AS (
        SELECT 'queueWait' AS metric,
               EXTRACT(EPOCH FROM ("scheduledAt" - "arrivalAt")) AS seconds
        FROM windowed WHERE "scheduledAt" IS NOT NULL
        UNION ALL
        SELECT 'placementDelay',
               EXTRACT(EPOCH FROM ("placedAt" - "scheduledAt"))
        FROM windowed WHERE "placedAt" IS NOT NULL AND "scheduledAt" IS NOT NULL
        UNION ALL
        SELECT 'startDelay',
               EXTRACT(EPOCH FROM ("startedAt" - "placedAt"))
        FROM windowed WHERE "startedAt" IS NOT NULL AND "placedAt" IS NOT NULL
        UNION ALL
        SELECT 'execution',
               EXTRACT(EPOCH FROM ("completedAt" - "startedAt"))
        FROM windowed WHERE "completedAt" IS NOT NULL AND "startedAt" IS NOT NULL
        UNION ALL
        SELECT 'turnaround',
               EXTRACT(EPOCH FROM ("completedAt" - "arrivalAt"))
        FROM windowed WHERE "completedAt" IS NOT NULL
      )
      SELECT metric,
             count(*)::int AS "count",
             avg(seconds)::float8 AS "average",
             min(seconds)::float8 AS "minimum",
             max(seconds)::float8 AS "maximum",
             percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds)::float8 AS "p95"
      FROM durations
      WHERE seconds IS NOT NULL
      GROUP BY metric
    `;
  },

  /** Jobs that reached a terminal state inside the window, by status. */
  async terminalJobCounts(since) {
    const groups = await prisma.job.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: {
        completedAt: { gte: since },
        status: {
          in: [
            JobStatus.COMPLETED,
            JobStatus.FAILED,
            JobStatus.INTERRUPTED,
            JobStatus.CANCELLED,
          ],
        },
      },
    });
    return tally(groups);
  },

  /** Per-worker current claims and lifetime job outcomes. */
  async workerActivity() {
    const rows = await prisma.$queryRaw<
      {
        workerId: string;
        reservedAllocations: number;
        runningExecutions: number;
        executionsRun: number;
        jobsCompleted: number;
        jobsFailed: number;
      }[]
    >`
      SELECT w."id" AS "workerId",
             count(DISTINCT a."id") FILTER (WHERE a."status" = 'RESERVED')::int
               AS "reservedAllocations",
             count(DISTINCT e."id") FILTER (WHERE e."status" IN ('PENDING', 'RUNNING'))::int
               AS "runningExecutions",
             count(DISTINCT e."id")::int AS "executionsRun",
             count(DISTINCT e."id") FILTER (WHERE e."status" = 'COMPLETED')::int
               AS "jobsCompleted",
             count(DISTINCT e."id") FILTER (WHERE e."status" IN ('FAILED', 'INTERRUPTED'))::int
               AS "jobsFailed"
      FROM "workers" w
      LEFT JOIN "resource_allocations" a ON a."workerId" = w."id"
      LEFT JOIN "job_executions" e ON e."workerId" = w."id"
      GROUP BY w."id"
    `;
    return rows;
  },

  listSamples({ workerId, sinceMinutes, limit }, now) {
    const since = new Date(now.getTime() - sinceMinutes * 60_000);
    return prisma.workerSample.findMany({
      where: {
        capturedAt: { gte: since },
        ...(workerId ? { workerId } : {}),
      },
      orderBy: [{ capturedAt: "desc" }, { workerId: "asc" }],
      take: limit,
    });
  },

  /**
   * Records one utilization sample per worker.
   *
   * All rows share `capturedAt`, so grouping on it reconstructs the cluster at
   * that instant. The write is a single statement inside a transaction, and the
   * unique index on (workerId, capturedAt) makes a repeated pass a no-op rather
   * than a double count.
   */
  async captureSample(capturedAt) {
    return prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO "worker_samples" (
          "id", "workerId", "capturedAt",
          "cpuCapacityMillicores", "memoryCapacityMiB",
          "cpuAllocatedMillicores", "memoryAllocatedMiB",
          "status", "runningExecutions", "reservedAllocations"
        )
        SELECT gen_random_uuid(), w."id", ${capturedAt},
               w."cpuCapacityMillicores", w."memoryCapacityMiB",
               w."cpuAllocatedMillicores", w."memoryAllocatedMiB",
               w."status",
               COALESCE(running."count", 0),
               COALESCE(reserved."count", 0)
        FROM "workers" w
        LEFT JOIN (
          SELECT "workerId", count(*)::int AS "count"
          FROM "job_executions"
          WHERE "status" IN ('PENDING', 'RUNNING')
          GROUP BY "workerId"
        ) running ON running."workerId" = w."id"
        LEFT JOIN (
          SELECT "workerId", count(*)::int AS "count"
          FROM "resource_allocations"
          WHERE "status" = 'RESERVED'
          GROUP BY "workerId"
        ) reserved ON reserved."workerId" = w."id"
        ON CONFLICT ("workerId", "capturedAt") DO NOTHING
      `;
      return inserted;
    });
  },

  async pruneSamples(before) {
    const deleted = await prisma.workerSample.deleteMany({
      where: { capturedAt: { lt: before } },
    });
    return deleted.count;
  },
};
