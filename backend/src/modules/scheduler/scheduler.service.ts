import { JobStatus, SchedulingPolicy, type Job } from "@prisma/client";

import { assertJobTransition } from "../jobs/job.transitions.js";
import { orderByPolicy } from "./scheduler.policies.js";
import {
  prismaSchedulerRepository,
  type SchedulerRepository,
} from "./scheduler.repository.js";
import {
  DEFAULT_TIME_QUANTUM_SECONDS,
  type DispatchInput,
  type PreviewQuery,
} from "./scheduler.schemas.js";

export interface DispatchResult {
  policy: SchedulingPolicy;
  timeQuantumSeconds: number | null;
  requested: number;
  eligibleCount: number;
  scheduledCount: number;
  scheduled: Job[];
}

export interface PreviewResult {
  policy: SchedulingPolicy;
  eligibleCount: number;
  jobs: Job[];
}

const ELIGIBLE_SCAN_LIMIT = 500;

export class SchedulerService {
  constructor(
    private readonly repository: SchedulerRepository = prismaSchedulerRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(query: PreviewQuery): Promise<PreviewResult> {
    const now = this.now();
    const candidates = await this.repository.findEligible(now, ELIGIBLE_SCAN_LIMIT);
    const ordered = orderByPolicy(candidates, query.policy, now);

    return {
      policy: query.policy,
      eligibleCount: ordered.length,
      jobs: ordered.slice(0, query.limit),
    };
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const now = this.now();
    const timeQuantumSeconds =
      input.policy === SchedulingPolicy.ROUND_ROBIN
        ? (input.timeQuantumSeconds ?? DEFAULT_TIME_QUANTUM_SECONDS)
        : null;

    const candidates = await this.repository.findEligible(now, ELIGIBLE_SCAN_LIMIT);
    const ordered = orderByPolicy(candidates, input.policy, now);
    const scheduled: Job[] = [];

    for (const candidate of ordered) {
      if (scheduled.length >= input.count) {
        break;
      }

      assertJobTransition(candidate.status, JobStatus.SCHEDULED);

      const claimed = await this.repository.claim({
        jobId: candidate.id,
        policy: input.policy,
        scheduledAt: now,
        timeQuantumSeconds,
      });

      if (!claimed) {
        // Another dispatch claimed this job first; skip it rather than failing.
        continue;
      }

      const job = await this.repository.findById(candidate.id);
      if (job) {
        scheduled.push(job);
      }
    }

    return {
      policy: input.policy,
      timeQuantumSeconds,
      requested: input.count,
      eligibleCount: ordered.length,
      scheduledCount: scheduled.length,
      scheduled,
    };
  }
}

export const schedulerService = new SchedulerService();
