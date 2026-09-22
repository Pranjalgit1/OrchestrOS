import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  Prisma,
  type Job,
  type JobExecution,
  type ResourceAllocation,
  type Worker,
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import {
  TRANSACTION_OPTIONS,
  releaseAllocationWithin,
} from "../resources/resource.repository.js";

export interface ClaimExecutionRequest {
  jobId: string;
}

/** A job plus the reservation and worker the execution will consume. */
export interface ClaimedExecution {
  execution: JobExecution;
  job: Job;
  allocation: ResourceAllocation;
}

export type ClaimOutcome =
  | { status: "CLAIMED"; claimed: ClaimedExecution }
  | { status: "JOB_NOT_FOUND" }
  | { status: "JOB_NOT_RUNNABLE"; jobStatus: JobStatus }
  | { status: "NO_RESERVATION" }
  | { status: "EXECUTION_ALREADY_CLAIMED" };

export interface FinalizeExecutionRequest {
  executionId: string;
  executionStatus:
    | typeof ExecutionStatus.COMPLETED
    | typeof ExecutionStatus.FAILED
    | typeof ExecutionStatus.INTERRUPTED;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  failureReason: string | null;
  result: Prisma.InputJsonValue | null;
  completedAt: Date;
}

export type FinalizeOutcome =
  | {
      status: "FINALIZED";
      execution: JobExecution;
      job: Job;
      worker: Worker | null;
      released: boolean;
    }
  | { status: "EXECUTION_NOT_FOUND" }
  | { status: "ALREADY_FINALIZED"; execution: JobExecution; job: Job };

export interface ExecutionFilter {
  jobId?: string | undefined;
  workerId?: string | undefined;
  status?: ExecutionStatus | undefined;
  limit: number;
}

export interface ExecutionRepository {
  claim(request: ClaimExecutionRequest): Promise<ClaimOutcome>;
  markStarted(executionId: string, containerId: string): Promise<JobExecution>;
  finalize(request: FinalizeExecutionRequest): Promise<FinalizeOutcome>;
  findById(executionId: string): Promise<JobExecution | null>;
  findJobForExecution(executionId: string): Promise<Job>;
  list(filter: ExecutionFilter): Promise<JobExecution[]>;
}

/** Execution statuses that have already reached a terminal outcome. */
export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  ExecutionStatus.COMPLETED,
  ExecutionStatus.FAILED,
  ExecutionStatus.INTERRUPTED,
  ExecutionStatus.CANCELLED,
]);

function jobStatusForExecution(executionStatus: FinalizeExecutionRequest["executionStatus"]) {
  switch (executionStatus) {
    case ExecutionStatus.COMPLETED:
      return JobStatus.COMPLETED;
    case ExecutionStatus.INTERRUPTED:
      return JobStatus.INTERRUPTED;
    default:
      return JobStatus.FAILED;
  }
}

export const prismaExecutionRepository: ExecutionRepository = {
  /**
   * Atomically takes ownership of a job's execution slot.
   *
   * The conditional `SCHEDULED -> RUNNING` update is the claim: only one caller
   * can match it, so two concurrent start requests cannot both launch a
   * container. The execution row is bound to the job's live reservation, which
   * the database also enforces through a composite foreign key and a unique
   * allocation id.
   */
  async claim({ jobId }) {
    return prisma.$transaction(async (tx) => {
      // Lock the job row first so concurrent starts serialise here. Without it
      // the loser's refusal depends on interleaving and it could be told the job
      // is "not runnable" when the truth is that it is already running.
      await tx.$queryRaw`SELECT "id" FROM "jobs" WHERE "id" = ${jobId}::uuid FOR UPDATE`;

      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) {
        return { status: "JOB_NOT_FOUND" };
      }

      if (job.status === JobStatus.RUNNING) {
        const active = await tx.jobExecution.findFirst({
          where: {
            jobId,
            status: { in: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING] },
          },
          select: { id: true },
        });
        // A running job that owns a live execution was claimed by someone else.
        // A running job with no live execution is an orphan from an interrupted
        // process; it is reported as not runnable until recovery reconciles it.
        if (active) {
          return { status: "EXECUTION_ALREADY_CLAIMED" };
        }
      }

      if (job.status !== JobStatus.SCHEDULED || !job.assignedWorkerId) {
        return { status: "JOB_NOT_RUNNABLE", jobStatus: job.status };
      }

      const allocation = await tx.resourceAllocation.findFirst({
        where: { jobId, status: AllocationStatus.RESERVED },
      });
      if (!allocation) {
        return { status: "NO_RESERVATION" };
      }

      // Conditional claim. The row lock above already serialises callers, so this
      // is a second guard that keeps the write correct on its own terms.
      const claimed = await tx.job.updateMany({
        where: { id: jobId, status: JobStatus.SCHEDULED },
        data: { status: JobStatus.RUNNING, startedAt: new Date() },
      });
      if (claimed.count === 0) {
        return { status: "EXECUTION_ALREADY_CLAIMED" };
      }

      const previousAttempts = await tx.jobExecution.count({ where: { jobId } });

      try {
        const execution = await tx.jobExecution.create({
          data: {
            jobId,
            workerId: allocation.workerId,
            allocationId: allocation.id,
            attempt: previousAttempts + 1,
            status: ExecutionStatus.PENDING,
          },
        });

        const runningJob = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        return { status: "CLAIMED", claimed: { execution, job: runningJob, allocation } };
      } catch (error) {
        // One execution per allocation and per (job, attempt) are unique indexes;
        // a collision means a concurrent claim already owns this reservation.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return { status: "EXECUTION_ALREADY_CLAIMED" };
        }
        throw error;
      }
    }, TRANSACTION_OPTIONS);
  },

  markStarted(executionId, containerId) {
    return prisma.$transaction(async (tx) => {
      const execution = await tx.jobExecution.update({
        where: { id: executionId },
        data: {
          status: ExecutionStatus.RUNNING,
          containerId,
          startedAt: new Date(),
        },
      });

      // The job mirrors the container id so operators can correlate without a join.
      await tx.job.update({
        where: { id: execution.jobId },
        data: { containerId },
      });

      return execution;
    }, TRANSACTION_OPTIONS);
  },

  /**
   * Records the run's outcome and returns the reservation in one transaction.
   *
   * Nothing is half-written: the execution row, the job lifecycle, and the
   * worker's capacity counters commit together or not at all. Finalisation is
   * idempotent so a manual settle cannot double-release after the automatic one.
   */
  async finalize(request) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.jobExecution.findUnique({ where: { id: request.executionId } });
      if (!existing) {
        return { status: "EXECUTION_NOT_FOUND" };
      }

      if (TERMINAL_EXECUTION_STATUSES.has(existing.status)) {
        const job = await tx.job.findUniqueOrThrow({ where: { id: existing.jobId } });
        return { status: "ALREADY_FINALIZED", execution: existing, job };
      }

      const execution = await tx.jobExecution.update({
        where: { id: request.executionId },
        data: {
          status: request.executionStatus,
          exitCode: request.exitCode,
          stdout: request.stdout,
          stderr: request.stderr,
          failureReason: request.failureReason,
          completedAt: request.completedAt,
        },
      });

      const job = await tx.job.update({
        where: { id: execution.jobId },
        data: {
          status: jobStatusForExecution(request.executionStatus),
          completedAt: request.completedAt,
          failureReason: request.failureReason,
          ...(request.result === null ? {} : { result: request.result }),
        },
      });

      // Capacity is returned in the same transaction that records the outcome,
      // so a completed job can never keep holding a reservation.
      const release = await releaseAllocationWithin(tx, execution.jobId);

      return {
        status: "FINALIZED",
        execution,
        job,
        worker: release.status === "RELEASED" ? release.worker : null,
        released: release.status === "RELEASED",
      };
    }, TRANSACTION_OPTIONS);
  },

  findById(executionId) {
    return prisma.jobExecution.findUnique({ where: { id: executionId } });
  },

  async findJobForExecution(executionId) {
    const execution = await prisma.jobExecution.findUniqueOrThrow({
      where: { id: executionId },
      select: { job: true },
    });
    return execution.job;
  },

  list({ jobId, workerId, status, limit }) {
    return prisma.jobExecution.findMany({
      where: {
        ...(jobId ? { jobId } : {}),
        ...(workerId ? { workerId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit,
    });
  },
};
