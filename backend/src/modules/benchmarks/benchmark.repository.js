import { BenchmarkStatus, JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { SCHEDULABLE_WORKER_STATUSES } from "../placement/placement.accounting.js";

/** Job states that still have work ahead of them. */
const UNFINISHED_JOB_STATUSES = [
  JobStatus.CREATED,
  JobStatus.QUEUED,
  JobStatus.WAITING,
  JobStatus.SCHEDULED,
  JobStatus.RUNNING,
];

const suiteInclude = { runs: { orderBy: { position: "asc" } } };

export const prismaBenchmarkRepository = {
  /** Unfinished jobs anywhere in the cluster. A benchmark needs this to be zero. */
  countUnfinishedJobs() {
    return prisma.job.count({ where: { status: { in: UNFINISHED_JOB_STATUSES } } });
  },

  /** Capacity the next run will be measured against. */
  async readCapacity() {
    const workers = await prisma.worker.findMany({
      where: { status: { in: SCHEDULABLE_WORKER_STATUSES } },
      select: { cpuCapacityMillicores: true, memoryCapacityMiB: true },
    });
    return {
      workerCount: workers.length,
      cpuCapacityMillicores: workers.reduce((sum, worker) => sum + worker.cpuCapacityMillicores, 0),
      memoryCapacityMiB: workers.reduce((sum, worker) => sum + worker.memoryCapacityMiB, 0),
    };
  },

  /** The suite and all its planned runs, created together. */
  createSuite(suite, policies) {
    return prisma.benchmarkSuite.create({
      data: {
        ...suite,
        status: BenchmarkStatus.RUNNING,
        runs: {
          create: policies.map((policy, position) => ({
            policy,
            position,
            status: BenchmarkStatus.PENDING,
          })),
        },
      },
      include: suiteInclude,
    });
  },

  startRun(runId, { workloadBatchId, capacity, jobCount }) {
    return prisma.benchmarkRun.update({
      where: { id: runId },
      data: {
        status: BenchmarkStatus.RUNNING,
        startedAt: new Date(),
        workloadBatchId,
        jobCount,
        ...capacity,
      },
    });
  },

  finishRun(runId, status, metrics, failureReason = null) {
    return prisma.benchmarkRun.update({
      where: { id: runId },
      data: { status, completedAt: new Date(), failureReason, ...metrics },
    });
  },

  /** Marks every run that never finished, so the record cannot claim it ran. */
  async finishSuite(suiteId, status, failureReason = null) {
    return prisma.$transaction(async (tx) => {
      await tx.benchmarkRun.updateMany({
        where: { suiteId, status: { in: [BenchmarkStatus.PENDING, BenchmarkStatus.RUNNING] } },
        data: {
          status: BenchmarkStatus.ABORTED,
          completedAt: new Date(),
          failureReason: failureReason ?? "The suite stopped before this run finished",
        },
      });
      return tx.benchmarkSuite.update({
        where: { id: suiteId },
        data: { status, completedAt: new Date(), failureReason },
        include: suiteInclude,
      });
    });
  },

  /** Progress counts for one batch: how many jobs are finished so far. */
  async batchProgress(workloadBatchId) {
    const groups = await prisma.job.groupBy({
      by: ["status"],
      where: { workloadBatchId },
      _count: { _all: true },
    });
    let total = 0;
    let unfinished = 0;
    for (const group of groups) {
      total += group._count._all;
      if (UNFINISHED_JOB_STATUSES.includes(group.status)) unfinished += group._count._all;
    }
    return { total, unfinished, finished: total - unfinished };
  },

  /** Everything the metrics need for one batch, including every attempt. */
  readBatchJobs(workloadBatchId) {
    return prisma.job.findMany({
      where: { workloadBatchId },
      orderBy: { batchSequence: "asc" },
      select: {
        status: true,
        batchSequence: true,
        arrivalAt: true,
        completedAt: true,
        preemptionCount: true,
        retryCount: true,
        result: true,
        executions: { select: { startedAt: true, completedAt: true } },
      },
    });
  },

  findSuite(id) {
    return prisma.benchmarkSuite.findUnique({ where: { id }, include: suiteInclude });
  },

  listSuites(limit) {
    return prisma.benchmarkSuite.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: suiteInclude,
    });
  },

  /**
   * A suite still marked RUNNING when the backend starts was interrupted by a
   * restart: its runner lived in the old process.
   */
  async abandonInterruptedSuites() {
    const suites = await prisma.benchmarkSuite.findMany({
      where: { status: BenchmarkStatus.RUNNING },
      select: { id: true },
    });
    for (const suite of suites) {
      await this.finishSuite(suite.id, BenchmarkStatus.ABORTED,
        "The backend restarted while this benchmark was running");
    }
    return suites.length;
  },
};
