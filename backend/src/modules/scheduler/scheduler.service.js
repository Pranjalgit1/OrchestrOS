import { JobStatus, SchedulingPolicy } from "@prisma/client";
import { assertJobTransition } from "../jobs/job.transitions.js";
import { orderByPolicy } from "./scheduler.policies.js";
import { prismaSchedulerRepository } from "./scheduler.repository.js";
import { DEFAULT_TIME_QUANTUM_SECONDS } from "./scheduler.schemas.js";
const ELIGIBLE_SCAN_LIMIT = 500;
export class SchedulerService {
  repository;
  now;
  constructor(repository = prismaSchedulerRepository, now = () => new Date()) {
    this.repository = repository;
    this.now = now;
  }
  async preview(query) {
    const now = this.now();
    const candidates = await this.repository.findEligible(
      now,
      ELIGIBLE_SCAN_LIMIT,
    );
    const ordered = orderByPolicy(candidates, query.policy, now);
    return {
      policy: query.policy,
      eligibleCount: ordered.length,
      jobs: ordered.slice(0, query.limit),
    };
  }
  async dispatch(input) {
    const now = this.now();
    const timeQuantumSeconds =
      input.policy === SchedulingPolicy.ROUND_ROBIN
        ? (input.timeQuantumSeconds ?? DEFAULT_TIME_QUANTUM_SECONDS)
        : null;
    const candidates = await this.repository.findEligible(
      now,
      ELIGIBLE_SCAN_LIMIT,
    );
    const ordered = orderByPolicy(candidates, input.policy, now);
    const scheduled = [];
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
