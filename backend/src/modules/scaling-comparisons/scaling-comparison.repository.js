import { BenchmarkStatus, JobStatus, WorkerStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { prismaBenchmarkRepository } from "../benchmarks/benchmark.repository.js";
import { SCHEDULABLE_WORKER_STATUSES } from "../placement/placement.accounting.js";

const runsInclude = { runs: { orderBy: { position: "asc" } } };
/** Job states that still have work ahead of them. */
const UNFINISHED_JOB_STATUSES = [
  JobStatus.CREATED, JobStatus.QUEUED, JobStatus.WAITING, JobStatus.SCHEDULED, JobStatus.RUNNING,
];
const runsWithSamples = {
  runs: { orderBy: { position: "asc" }, include: { samples: { orderBy: { offsetSeconds: "asc" } } } },
};

/** Sample columns the database stores; anything else on a sample is dropped. */
function sampleRow(runId, sample) {
  return {
    runId,
    at: sample.at,
    offsetSeconds: sample.offsetSeconds,
    queuedJobs: sample.queuedJobs,
    workersInService: sample.workersInService,
    extraWorkers: sample.extraWorkers,
    idleExtraWorkers: sample.idleExtraWorkers,
    peakUtilization: sample.peakUtilization,
    forecastQueuedJobs: sample.forecastQueuedJobs ?? null,
    forecastPeak: sample.forecastPeak ?? null,
  };
}

export const prismaScalingComparisonRepository = {
  // Shared with the policy benchmark: both need an idle cluster and measure batches the same way.
  countUnfinishedJobs: () => prismaBenchmarkRepository.countUnfinishedJobs(),
  readCapacity: () => prismaBenchmarkRepository.readCapacity(),
  batchProgress: (batchId) => prismaBenchmarkRepository.batchProgress(batchId),
  readBatchJobs: (batchId) => prismaBenchmarkRepository.readBatchJobs(batchId),

  /** The comparison and both of its planned runs, created together. */
  createComparison(comparison, strategies) {
    return prisma.scalingComparison.create({
      data: {
        ...comparison,
        status: BenchmarkStatus.RUNNING,
        runs: {
          create: strategies.map((strategy, position) => ({
            strategy,
            position,
            status: BenchmarkStatus.PENDING,
          })),
        },
      },
      include: runsInclude,
    });
  },

  startRun(runId, { workloadBatchId, capacity, jobCount, startedAt }) {
    return prisma.scalingComparisonRun.update({
      where: { id: runId },
      data: { status: BenchmarkStatus.RUNNING, startedAt, workloadBatchId, jobCount, ...capacity },
    });
  },

  /** Stores a run's results and its whole timeline in one transaction. */
  finishRun(runId, status, results, failureReason, samples) {
    return prisma.$transaction(async (tx) => {
      if (samples.length > 0) {
        await tx.scalingComparisonSample.createMany({
          data: samples.map((sample) => sampleRow(runId, sample)),
        });
      }
      return tx.scalingComparisonRun.update({
        where: { id: runId },
        data: { status, completedAt: new Date(), failureReason, ...results },
      });
    });
  },

  /** Marks every run that never finished, so the record cannot claim it ran. */
  finishComparison(comparisonId, status, failureReason = null) {
    return prisma.$transaction(async (tx) => {
      await tx.scalingComparisonRun.updateMany({
        where: { comparisonId, status: { in: [BenchmarkStatus.PENDING, BenchmarkStatus.RUNNING] } },
        data: {
          status: BenchmarkStatus.ABORTED,
          completedAt: new Date(),
          failureReason: failureReason ?? "The comparison stopped before this run finished",
        },
      });
      return tx.scalingComparison.update({
        where: { id: comparisonId },
        data: { status, completedAt: new Date(), failureReason },
        include: runsInclude,
      });
    });
  },

  /**
   * Takes every autoscaled worker out of service so the next run starts from
   * the base cluster. Only empty workers are retired, matching the database
   * check that a retired worker holds nothing; `remaining` counts any that
   * could not be.
   */
  async retireAutoscaledWorkers() {
    const { count } = await prisma.worker.updateMany({
      where: {
        autoscaled: true,
        status: { not: WorkerStatus.RETIRED },
        cpuAllocatedMillicores: 0,
        memoryAllocatedMiB: 0,
      },
      data: { status: WorkerStatus.RETIRED },
    });
    const remaining = await prisma.worker.count({
      where: { autoscaled: true, status: { not: WorkerStatus.RETIRED } },
    });
    return { retired: count, remaining };
  },

  async lastScalingEventAt() {
    const event = await prisma.scalingEvent.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return event?.createdAt ?? null;
  },

  /** What one timeline sample needs: the autoscaler's waiting count and the schedulable workers. */
  async readLoad(now) {
    const [queuedJobs, workers] = await prisma.$transaction([
      prisma.job.count({ where: { status: JobStatus.QUEUED, arrivalAt: { lte: now } } }),
      prisma.worker.findMany({
        where: { status: { in: SCHEDULABLE_WORKER_STATUSES } },
        select: {
          status: true,
          autoscaled: true,
          cpuCapacityMillicores: true,
          cpuAllocatedMillicores: true,
          memoryCapacityMiB: true,
          memoryAllocatedMiB: true,
        },
      }),
    ]);
    return { queuedJobs, workers };
  },

  /** Scaling actions recorded between two moments, oldest first. */
  async listActions(from, to) {
    const events = await prisma.scalingEvent.findMany({
      where: { createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, action: true, workerName: true, reason: true },
    });
    return events.map(({ createdAt, ...event }) => ({ at: createdAt, ...event }));
  },

  findComparison(id) {
    return prisma.scalingComparison.findUnique({ where: { id }, include: runsWithSamples });
  },

  listComparisons(limit) {
    return prisma.scalingComparison.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: runsInclude,
    });
  },

  /**
   * A comparison still RUNNING at startup lost its runner with the old
   * process. It is marked aborted, and the unfinished jobs of its batches are
   * cancelled through `cancelJob`, which also returns any reservation, so they
   * do not sit in the queue and block the next comparison.
   */
  async abandonInterrupted(cancelJob) {
    const comparisons = await prisma.scalingComparison.findMany({
      where: { status: BenchmarkStatus.RUNNING },
      select: { id: true, runs: { select: { workloadBatchId: true } } },
    });
    let cancelledJobs = 0;
    for (const comparison of comparisons) {
      await this.finishComparison(comparison.id, BenchmarkStatus.ABORTED,
        "The backend restarted while this comparison was running");
      const batchIds = comparison.runs.map((run) => run.workloadBatchId).filter(Boolean);
      if (!cancelJob || batchIds.length === 0) continue;
      const leftovers = await prisma.job.findMany({
        where: { workloadBatchId: { in: batchIds }, status: { in: UNFINISHED_JOB_STATUSES } },
        select: { id: true },
      });
      for (const job of leftovers) {
        try {
          await cancelJob(job.id);
          cancelledJobs += 1;
        } catch (error) {
          console.error(`Could not cancel leftover comparison job ${job.id}:`, error.message);
        }
      }
    }
    return { comparisons: comparisons.length, cancelledJobs };
  },
};
