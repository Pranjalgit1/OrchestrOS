import { JobStatus } from "@prisma/client";
import { ConflictError } from "../../errors/app-error.js";
const allowedTransitions = {
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
    // Round Robin preemption, or an automatic retry after an infrastructure fault.
    JobStatus.QUEUED,
  ]),
  [JobStatus.INTERRUPTED]: new Set([
    JobStatus.QUEUED,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.COMPLETED]: new Set(),
  // A failed job is final unless an operator requeues it.
  [JobStatus.FAILED]: new Set([JobStatus.QUEUED]),
  [JobStatus.CANCELLED]: new Set(),
};
export function canTransitionJob(from, to) {
  return allowedTransitions[from].has(to);
}
export function assertJobTransition(from, to) {
  if (!canTransitionJob(from, to)) {
    throw new ConflictError(
      `Job cannot transition from ${from} to ${to}`,
      "INVALID_JOB_TRANSITION",
    );
  }
}
