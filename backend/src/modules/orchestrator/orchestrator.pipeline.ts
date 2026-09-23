import { ExecutionStatus, JobStatus } from "@prisma/client";

/**
 * Pure pipeline vocabulary shared by the orchestrator and the dashboard.
 *
 * Deriving a job's stage from its persisted state keeps the frontend from
 * inventing its own rules about what "placed" or "reserved" means.
 */

export const PIPELINE_STAGES = [
  "QUEUE",
  "SCHEDULER",
  "PLACEMENT",
  "RESERVATION",
  "EXECUTION",
  "COMPLETED",
  "TERMINATED",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface StageInput {
  status: JobStatus;
  assignedWorkerId: string | null;
  hasActiveReservation: boolean;
  executionStatus: ExecutionStatus | null;
}

/**
 * Where a job currently sits in the pipeline.
 *
 * `RESERVATION` means capacity is committed but no container has started yet,
 * which is exactly the window the transactional reservation protects.
 */
export function derivePipelineStage(input: StageInput): PipelineStage {
  switch (input.status) {
    case JobStatus.COMPLETED:
      return "COMPLETED";
    case JobStatus.FAILED:
    case JobStatus.INTERRUPTED:
    case JobStatus.CANCELLED:
      return "TERMINATED";
    case JobStatus.RUNNING:
      return "EXECUTION";
    case JobStatus.SCHEDULED:
      if (!input.assignedWorkerId) return "SCHEDULER";
      return input.hasActiveReservation ? "RESERVATION" : "PLACEMENT";
    default:
      return "QUEUE";
  }
}

/** True when the scheduler may consider this job now. */
export function isEligibleNow(status: JobStatus, arrivalAt: Date, now: Date): boolean {
  return (
    (status === JobStatus.QUEUED || status === JobStatus.WAITING) &&
    arrivalAt.getTime() <= now.getTime()
  );
}

/** Seconds until a queued job's planned arrival, or zero once it has passed. */
export function secondsUntilEligible(arrivalAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((arrivalAt.getTime() - now.getTime()) / 1_000));
}
