import { JobStatus } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { prismaJobRepository } from "./job.repository.js";
import { assertJobTransition } from "./job.transitions.js";
export class JobService {
  repository;
  constructor(repository = prismaJobRepository) {
    this.repository = repository;
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
  async cancel(id) {
    const cancelled = await this.repository.cancelQueued(id, new Date());
    if (cancelled) {
      return this.getById(id);
    }
    const current = await this.repository.findById(id);
    if (!current) {
      throw new NotFoundError("Job");
    }
    if (current.status === JobStatus.CANCELLED) {
      return current;
    }
    assertJobTransition(current.status, JobStatus.CANCELLED);
    throw new ConflictError(
      `Job in ${current.status} cannot be cancelled until runtime cleanup is available`,
      "JOB_NOT_CANCELLABLE",
    );
  }
}
export const jobService = new JobService();
