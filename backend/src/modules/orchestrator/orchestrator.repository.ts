import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  type Job,
  type Worker,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

/**
 * Reads the orchestrator needs on top of the existing modules.
 *
 * Nothing here schedules, places, reserves, or executes: those remain owned by
 * their own modules. This only answers "what is the state of things" and "which
 * job should be advanced next".
 */

export interface JobStateRow {
  job: Job;
  workerName: string | null;
  hasActiveReservation: boolean;
  reservation: {
    id: string;
    cpuMillicores: number;
    memoryMiB: number;
    reservedAt: Date;
  } | null;
  execution: {
    id: string;
    status: ExecutionStatus;
    attempt: number;
    containerId: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    exitCode: number | null;
    failureReason: string | null;
  } | null;
}

export interface OrchestratorRepository {
  /**
   * The oldest scheduled job that no live execution owns yet.
   *
   * A user clicking through stages can leave a job placed but not reserved, so
   * the orchestrator resumes such a job before pulling a new one off the queue.
   */
  findResumableJob(): Promise<Job | null>;
  listJobStates(limit: number): Promise<JobStateRow[]>;
  listWorkers(): Promise<Worker[]>;
  countJobsByStatus(): Promise<Record<string, number>>;
  findJobById(jobId: string): Promise<Job | null>;
  hasActiveReservation(jobId: string): Promise<boolean>;
  /** Removes jobs that already reached a terminal state, and their records. */
  deleteFinishedJobs(): Promise<{ deletedJobs: number; deletedExecutions: number }>;
}

/** Job states that are finished and therefore safe to clear. */
const TERMINAL_JOB_STATUSES = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.INTERRUPTED,
  JobStatus.CANCELLED,
] as const;

export const prismaOrchestratorRepository: OrchestratorRepository = {
  findResumableJob() {
    return prisma.job.findFirst({
      where: {
        status: JobStatus.SCHEDULED,
        executions: {
          none: {
            status: { in: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING] },
          },
        },
      },
      orderBy: [{ scheduledAt: "asc" }, { arrivalAt: "asc" }, { id: "asc" }],
    });
  },

  async listJobStates(limit) {
    const jobs = await prisma.job.findMany({
      orderBy: [{ arrivalAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: limit,
      include: {
        assignedWorker: { select: { name: true } },
        allocations: {
          where: { status: AllocationStatus.RESERVED },
          select: { id: true, cpuMillicores: true, memoryMiB: true, reservedAt: true },
          take: 1,
        },
        executions: {
          orderBy: { attempt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            attempt: true,
            containerId: true,
            startedAt: true,
            completedAt: true,
            exitCode: true,
            failureReason: true,
          },
        },
      },
    });

    return jobs.map(({ assignedWorker, allocations, executions, ...job }) => ({
      job: job as Job,
      workerName: assignedWorker?.name ?? null,
      hasActiveReservation: allocations.length > 0,
      reservation: allocations[0] ?? null,
      execution: executions[0] ?? null,
    }));
  },

  listWorkers() {
    return prisma.worker.findMany({ orderBy: { name: "asc" } });
  },

  async countJobsByStatus() {
    const groups = await prisma.job.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const group of groups) {
      counts[group.status] = group._count._all;
    }
    return counts;
  },

  findJobById(jobId) {
    return prisma.job.findUnique({ where: { id: jobId } });
  },

  async hasActiveReservation(jobId) {
    const count = await prisma.resourceAllocation.count({
      where: { jobId, status: AllocationStatus.RESERVED },
    });
    return count > 0;
  },

  /**
   * Clears finished work so a demonstration can start from a clean queue.
   *
   * Only terminal jobs are touched, and the deletes run in one transaction in
   * foreign-key order. Running or reserved work is never removed, so this cannot
   * strand a container or leave a worker's counters wrong.
   */
  async deleteFinishedJobs() {
    return prisma.$transaction(async (tx) => {
      const finished = await tx.job.findMany({
        where: { status: { in: [...TERMINAL_JOB_STATUSES] } },
        select: { id: true },
      });
      const jobIds = finished.map((job) => job.id);

      if (jobIds.length === 0) {
        return { deletedJobs: 0, deletedExecutions: 0 };
      }

      const executions = await tx.jobExecution.deleteMany({
        where: { jobId: { in: jobIds } },
      });
      await tx.resourceAllocation.deleteMany({ where: { jobId: { in: jobIds } } });
      const jobs = await tx.job.deleteMany({ where: { id: { in: jobIds } } });

      // Batches whose jobs are all gone would otherwise linger as empty shells.
      await tx.workloadBatch.deleteMany({
        where: { jobs: { none: {} }, reusedBatches: { none: {} } },
      });

      return { deletedJobs: jobs.count, deletedExecutions: executions.count };
    });
  },
};
