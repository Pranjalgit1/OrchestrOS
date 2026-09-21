import { JobStatus, SchedulingPolicy, type Job } from "@prisma/client";

/**
 * Jobs are eligible for scheduling only when they are queued and their planned
 * arrival time has passed. Arrival metadata is produced by the workload generator.
 */
export function isEligible(job: Job, now: Date): boolean {
  return job.status === JobStatus.QUEUED && job.arrivalAt.getTime() <= now.getTime();
}

export const MAX_PRIORITY = 10;
export const PRIORITY_AGING_INTERVAL_SECONDS = 60;

/**
 * Priority scheduling prevents starvation by aging: a queued job gains one
 * priority level for every full aging interval it has waited, capped at the
 * maximum priority. Higher numbers are more urgent.
 */
export function effectivePriority(job: Job, now: Date): number {
  const waitedSeconds = Math.max(0, (now.getTime() - job.arrivalAt.getTime()) / 1_000);
  const aged = Math.floor(waitedSeconds / PRIORITY_AGING_INTERVAL_SECONDS);
  return Math.min(MAX_PRIORITY, job.priority + aged);
}

function arrivalOrder(left: Job, right: Job): number {
  return (
    left.arrivalAt.getTime() - right.arrivalAt.getTime() ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.batchSequence ?? 0) - (right.batchSequence ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Returns eligible jobs in the order the requested policy would run them.
 * This function is pure: it never mutates jobs or touches persistence.
 */
export function orderByPolicy(
  jobs: readonly Job[],
  policy: SchedulingPolicy,
  now: Date,
): Job[] {
  const eligible = jobs.filter((job) => isEligible(job, now));

  switch (policy) {
    case SchedulingPolicy.FCFS:
      return [...eligible].sort(arrivalOrder);

    case SchedulingPolicy.SJF:
      return [...eligible].sort(
        (left, right) =>
          left.estimatedDurationSeconds - right.estimatedDurationSeconds ||
          arrivalOrder(left, right),
      );

    case SchedulingPolicy.PRIORITY:
      return [...eligible].sort(
        (left, right) =>
          effectivePriority(right, now) - effectivePriority(left, now) ||
          arrivalOrder(left, right),
      );

    case SchedulingPolicy.ROUND_ROBIN:
      // Jobs that have already consumed a quantum wait behind jobs with fewer
      // rounds, so requeued work rotates instead of monopolising the scheduler.
      return [...eligible].sort(
        (left, right) =>
          left.schedulingRounds - right.schedulingRounds || arrivalOrder(left, right),
      );

    default:
      return [...eligible].sort(arrivalOrder);
  }
}

export function selectNextJob(
  jobs: readonly Job[],
  policy: SchedulingPolicy,
  now: Date,
): Job | undefined {
  return orderByPolicy(jobs, policy, now)[0];
}
