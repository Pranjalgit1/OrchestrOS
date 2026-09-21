import { JobStatus, type Job } from "@prisma/client";

import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import type { CreateJobInput, ListJobsQuery } from "./job.schemas.js";
import { prismaJobRepository, type JobRepository } from "./job.repository.js";
import { assertJobTransition } from "./job.transitions.js";

export class JobService {
  constructor(private readonly repository: JobRepository = prismaJobRepository) {}

  create(input: CreateJobInput): Promise<Job> {
    return this.repository.create({
      ...input,
      name: input.name.trim(),
      status: JobStatus.QUEUED,
    });
  }

  list(query: ListJobsQuery): Promise<Job[]> {
    return this.repository.findAll(query.status, query.limit);
  }

  async getById(id: string): Promise<Job> {
    const job = await this.repository.findById(id);

    if (!job) {
      throw new NotFoundError("Job");
    }

    return job;
  }

  async cancel(id: string): Promise<Job> {
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
