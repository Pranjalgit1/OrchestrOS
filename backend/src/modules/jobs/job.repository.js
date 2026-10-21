import { ExecutionStatus, JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  TRANSACTION_OPTIONS,
  releaseAllocationWithin,
  withDeadlockRetry,
} from "../resources/resource.repository.js";
import { RequeueReason, requeuedJobData } from "./job.requeue.js";
/**
 * Jobs that can be cancelled without touching a container. RUNNING is included
 * for a job whose execution already ended or never existed; a RUNNING job with
 * a live execution is reported as such so the caller can stop its container.
 */
const CANCELLABLE_WITHOUT_RUNTIME = [
  JobStatus.CREATED,
  JobStatus.QUEUED,
  JobStatus.WAITING,
  JobStatus.SCHEDULED,
  JobStatus.RUNNING,
  JobStatus.INTERRUPTED,
];
const REQUEUEABLE = [JobStatus.FAILED, JobStatus.INTERRUPTED];
const OPEN_EXECUTION_STATUSES = [ExecutionStatus.PENDING, ExecutionStatus.RUNNING];
async function lockJob(tx, id) {
  await tx.$queryRaw`SELECT \`id\` FROM \`jobs\` WHERE \`id\` = ${id} FOR UPDATE`;
  return tx.job.findUnique({ where: { id } });
}
export const prismaJobRepository = {
  create(data) {
    return prisma.job.create({ data });
  },
  findAll(status, limit) {
    return prisma.job.findMany({
      ...(status ? { where: { status } } : {}),
      orderBy: [
        { arrivalAt: "asc" },
        { createdAt: "asc" },
        { batchSequence: "asc" },
        { id: "asc" },
      ],
      take: limit,
    });
  },
  findById(id) {
    return prisma.job.findUnique({ where: { id } });
  },
  /**
   * Cancels a job that has no live container and returns any reservation it
   * holds, in one transaction under the job row lock.
   */
  async cancelIdle(id, cancelledAt, reason) {
    return withDeadlockRetry(() => prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (!job) return { status: "JOB_NOT_FOUND" };
      if (job.status === JobStatus.CANCELLED) {
        return { status: "ALREADY_CANCELLED", job };
      }
      if (!CANCELLABLE_WITHOUT_RUNTIME.includes(job.status)) {
        return { status: "NOT_CANCELLABLE", job };
      }
      const open = await tx.jobExecution.count({
        where: { jobId: id, status: { in: OPEN_EXECUTION_STATUSES } },
      });
      if (open > 0) return { status: "HAS_OPEN_EXECUTION", job };
      const cancelled = await tx.job.update({
        where: { id },
        data: {
          status: JobStatus.CANCELLED,
          cancelledAt,
          completedAt: cancelledAt,
          failureReason: reason,
        },
      });
      const release = await releaseAllocationWithin(tx, id);
      return {
        status: "CANCELLED",
        job: cancelled,
        released: release.status === "RELEASED",
      };
    }, TRANSACTION_OPTIONS));
  },
  /** Puts a failed or interrupted job back in the queue for another attempt. */
  async requeue(id) {
    return withDeadlockRetry(() => prisma.$transaction(async (tx) => {
      const job = await lockJob(tx, id);
      if (!job) return { status: "JOB_NOT_FOUND" };
      if (!REQUEUEABLE.includes(job.status)) {
        return { status: "NOT_REQUEUEABLE", job };
      }
      // Finalisation releases capacity with the outcome, so this is only a
      // guard against a reservation left by a manual stage call.
      await releaseAllocationWithin(tx, id);
      const requeued = await tx.job.update({
        where: { id },
        // Only completed runs record a result, so there is none to clear here.
        data: requeuedJobData(RequeueReason.RETRY),
      });
      return { status: "REQUEUED", job: requeued };
    }, TRANSACTION_OPTIONS));
  },
};
