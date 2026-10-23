import { AllocationStatus, ExecutionStatus, JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
function tally(groups) {
  const counts = {};
  for (const group of groups) {
    counts[group.status] = group._count._all;
  }
  return counts;
}
export const prismaMonitoringRepository = {
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
        tx.resourceAllocation.count({
          where: { status: AllocationStatus.RESERVED },
        }),
        tx.jobExecution.findMany({
          where: {
            status: { in: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING] },
          },
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
            ? Math.max(
                0,
                Math.round(
                  (now.getTime() - execution.startedAt.getTime()) / 1_000,
                ),
              )
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
   * aggregated once, which keeps the query readable and lets MySQL compute
   * the percentile instead of loading every row into the process.
   */
  async jobTimings(since) {
    const rows = await prisma.$queryRaw`
      WITH windowed AS (
        SELECT \`arrivalAt\`, \`scheduledAt\`, \`placedAt\`, \`startedAt\`, \`completedAt\`
        FROM \`jobs\`
        WHERE \`createdAt\` >= ${since}
      ),
      durations AS (
        SELECT 'queueWait' AS metric,
               TIMESTAMPDIFF(MICROSECOND, \`arrivalAt\`, \`scheduledAt\`) / 1000000.0 AS seconds
        FROM windowed WHERE \`scheduledAt\` IS NOT NULL
        UNION ALL
        SELECT 'placementDelay',
               TIMESTAMPDIFF(MICROSECOND, \`scheduledAt\`, \`placedAt\`) / 1000000.0
        FROM windowed WHERE \`placedAt\` IS NOT NULL AND \`scheduledAt\` IS NOT NULL
        UNION ALL
        SELECT 'startDelay',
               TIMESTAMPDIFF(MICROSECOND, \`placedAt\`, \`startedAt\`) / 1000000.0
        FROM windowed WHERE \`startedAt\` IS NOT NULL AND \`placedAt\` IS NOT NULL
        UNION ALL
        SELECT 'execution',
               TIMESTAMPDIFF(MICROSECOND, \`startedAt\`, \`completedAt\`) / 1000000.0
        FROM windowed WHERE \`completedAt\` IS NOT NULL AND \`startedAt\` IS NOT NULL
        UNION ALL
        SELECT 'turnaround',
               TIMESTAMPDIFF(MICROSECOND, \`arrivalAt\`, \`completedAt\`) / 1000000.0
        FROM windowed WHERE \`completedAt\` IS NOT NULL
      ), ranked AS (
        SELECT metric, seconds,
               ROW_NUMBER() OVER (PARTITION BY metric ORDER BY seconds) AS position,
               COUNT(*) OVER (PARTITION BY metric) AS sampleCount
        FROM durations WHERE seconds IS NOT NULL
      ), positioned AS (
        SELECT *, 1 + 0.95 * (sampleCount - 1) AS percentilePosition FROM ranked
      )
      SELECT metric,
             COUNT(*) AS count,
             AVG(seconds) AS average,
             MIN(seconds) AS minimum,
             MAX(seconds) AS maximum,
             MAX(CASE WHEN position = FLOOR(percentilePosition) THEN seconds END)
             + (MAX(percentilePosition) - FLOOR(MAX(percentilePosition)))
               * (MAX(CASE WHEN position = CEIL(percentilePosition) THEN seconds END)
                  - MAX(CASE WHEN position = FLOOR(percentilePosition) THEN seconds END)) AS p95
      FROM positioned GROUP BY metric
    `;
    // MySQL returns COUNT as bigint and decimal aggregates as Prisma.Decimal.
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          key === "metric" || value === null ? value : Number(value),
        ]),
      ),
    );
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
    const rows = await prisma.$queryRaw`
      SELECT w.\`id\` AS \`workerId\`,
             COUNT(DISTINCT CASE WHEN a.\`status\` = 'RESERVED' THEN a.\`id\` END)
               AS \`reservedAllocations\`,
             COUNT(DISTINCT CASE WHEN e.\`status\` IN ('PENDING', 'RUNNING') THEN e.\`id\` END)
               AS \`runningExecutions\`,
             count(DISTINCT e.\`id\`) AS \`executionsRun\`,
             COUNT(DISTINCT CASE WHEN e.\`status\` = 'COMPLETED' THEN e.\`id\` END)
               AS \`jobsCompleted\`,
             COUNT(DISTINCT CASE WHEN e.\`status\` IN ('FAILED', 'INTERRUPTED') THEN e.\`id\` END)
               AS \`jobsFailed\`
      FROM \`workers\` w
      LEFT JOIN \`resource_allocations\` a ON a.\`workerId\` = w.\`id\`
      LEFT JOIN \`job_executions\` e ON e.\`workerId\` = w.\`id\`
      GROUP BY w.\`id\`
    `;
    return rows.map(({ workerId, ...counts }) => ({
      workerId,
      ...Object.fromEntries(
        Object.entries(counts).map(([key, value]) => [key, Number(value)]),
      ),
    }));
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
        INSERT INTO \`worker_samples\` (
          \`id\`, \`workerId\`, \`capturedAt\`,
          \`cpuCapacityMillicores\`, \`memoryCapacityMiB\`,
          \`cpuAllocatedMillicores\`, \`memoryAllocatedMiB\`,
          \`status\`, \`runningExecutions\`, \`reservedAllocations\`
        )
        SELECT UUID(), w.\`id\`, ${capturedAt},
               w.\`cpuCapacityMillicores\`, w.\`memoryCapacityMiB\`,
               w.\`cpuAllocatedMillicores\`, w.\`memoryAllocatedMiB\`,
               w.\`status\`,
               COALESCE(running.\`count\`, 0),
               COALESCE(reserved.\`count\`, 0)
        FROM \`workers\` w
        LEFT JOIN (
          SELECT \`workerId\`, count(*) AS \`count\`
          FROM \`job_executions\`
          WHERE \`status\` IN ('PENDING', 'RUNNING')
          GROUP BY \`workerId\`
        ) running ON running.\`workerId\` = w.\`id\`
        LEFT JOIN (
          SELECT \`workerId\`, count(*) AS \`count\`
          FROM \`resource_allocations\`
          WHERE \`status\` = 'RESERVED'
          GROUP BY \`workerId\`
        ) reserved ON reserved.\`workerId\` = w.\`id\`
        ON DUPLICATE KEY UPDATE \`id\` = \`worker_samples\`.\`id\`
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
