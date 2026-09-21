import { JobStatus } from "@prisma/client";

import { ConflictError } from "../../errors/app-error.js";

const allowedTransitions: Record<JobStatus, ReadonlySet<JobStatus>> = {
  [JobStatus.CREATED]: new Set([JobStatus.QUEUED, JobStatus.CANCELLED]),
  [JobStatus.QUEUED]: new Set([
    JobStatus.WAITING,
    JobStatus.SCHEDULED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.WAITING]: new Set([
    JobStatus.QUEUED,
    JobStatus.SCHEDULED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.SCHEDULED]: new Set([
    JobStatus.WAITING,
    JobStatus.RUNNING,
    JobStatus.QUEUED,
    JobStatus.FAILED,
    JobStatus.INTERRUPTED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.RUNNING]: new Set([
    JobStatus.COMPLETED,
    JobStatus.FAILED,
    JobStatus.INTERRUPTED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.INTERRUPTED]: new Set([
    JobStatus.QUEUED,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.COMPLETED]: new Set(),
  [JobStatus.FAILED]: new Set(),
  [JobStatus.CANCELLED]: new Set(),
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return allowedTransitions[from].has(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new ConflictError(
      `Job cannot transition from ${from} to ${to}`,
      "INVALID_JOB_TRANSITION",
    );
  }
}
