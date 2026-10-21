import { JobStatus } from "@prisma/client";
/** Why a job is going back to the queue, and which counter records it. */
export const RequeueReason = Object.freeze({
  /** A Round Robin quantum expired while other jobs were waiting. */
  PREEMPTION: "PREEMPTION",
  /** The execution failed or was interrupted and the job will run again. */
  RETRY: "RETRY",
});
/**
 * The job update that returns a job to the queue.
 *
 * Every per-attempt decision is cleared so the job goes through scheduling,
 * placement, and reservation again. `schedulingRounds` and `arrivalAt` are kept:
 * Round Robin uses the round count to rotate, and the original arrival keeps
 * FCFS and priority aging fair. The previous attempt's outcome remains on its
 * execution row.
 */
export function requeuedJobData(reason) {
  return {
    status: JobStatus.QUEUED,
    schedulingPolicy: null,
    scheduledAt: null,
    timeQuantumSeconds: null,
    placementStrategy: null,
    placedAt: null,
    assignedWorkerId: null,
    containerId: null,
    completedAt: null,
    cancelledAt: null,
    failureReason: null,
    ...(reason === RequeueReason.PREEMPTION
      ? { preemptionCount: { increment: 1 } }
      : { retryCount: { increment: 1 } }),
  };
}
