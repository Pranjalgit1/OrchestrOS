import { JobStatus } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import {
  OPERATOR_CANCEL_REASON,
  executionService,
} from "../executions/execution.service.js";
import { prismaJobRepository } from "./job.repository.js";
/**
 * Bound on cancel retries. Each pass either finishes or observes a concurrent
 * change (a container exiting, a preemption requeueing the job) and retries
 * against the new state, so a few passes always settle.
 */
const CANCEL_ATTEMPTS = 3;
export class JobService {
  repository;
  executions;
  constructor(repository = prismaJobRepository, executions = executionService) {
    this.repository = repository;
    this.executions = executions;
  }
  create(input) {
    return this.repository.create({
      ...input,
      name: input.name.trim(),
      status: JobStatus.QUEUED,
    });
  }
  list(query) {
    return this.repository.findAll(query.status, query.limit);
  }
  async getById(id) {
    const job = await this.repository.findById(id);
    if (!job) {
      throw new NotFoundError("Job");
    }
    return job;
  }
  /**
   * Cancels a job at any stage before it finishes.
   *
   * Queued, scheduled, and reserved jobs are cancelled in one transaction that
   * also returns their reservation. A running job has its container stopped
   * first; the execution, job, and reservation are then recorded together.
   */
  async cancel(id) {
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt += 1) {
      const outcome = await this.repository.cancelIdle(
        id,
        new Date(),
        OPERATOR_CANCEL_REASON,
      );
      switch (outcome.status) {
        case "JOB_NOT_FOUND":
          throw new NotFoundError("Job");
        case "CANCELLED":
        case "ALREADY_CANCELLED":
          return outcome.job;
        case "NOT_CANCELLABLE":
          throw new ConflictError(
            `Job already finished as ${outcome.job.status} and cannot be cancelled`,
            "JOB_NOT_CANCELLABLE",
          );
        case "HAS_OPEN_EXECUTION": {
          const stopped = await this.executions.cancel(id);
          if (stopped.job?.status === JobStatus.CANCELLED) return stopped.job;
          // The run ended another way first; re-evaluate against that state.
          break;
        }
        default:
          throw new Error(`Unexpected cancel outcome ${outcome.status}`);
      }
    }
    const current = await this.getById(id);
    if (current.status === JobStatus.CANCELLED) return current;
    throw new ConflictError(
      `Job is ${current.status} and could not be cancelled; try again`,
      "JOB_NOT_CANCELLABLE",
    );
  }
  /** Sends a failed or interrupted job back to the queue for a fresh attempt. */
  async requeue(id) {
    const outcome = await this.repository.requeue(id);
    switch (outcome.status) {
      case "JOB_NOT_FOUND":
        throw new NotFoundError("Job");
      case "NOT_REQUEUEABLE":
        throw new ConflictError(
          `Only failed or interrupted jobs can be requeued; job is ${outcome.job.status}`,
          "JOB_NOT_REQUEUEABLE",
        );
      default:
        return outcome.job;
    }
  }
}
export const jobService = new JobService();
