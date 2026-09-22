import {
  JobStatus,
  type Job,
  type ResourceAllocation,
  type Worker,
} from "@prisma/client";

import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { prisma } from "../../lib/prisma.js";
import {
  prismaResourceRepository,
  type ResourceRepository,
} from "./resource.repository.js";
import type {
  ListAllocationsQuery,
  ReleaseResourcesInput,
  ReserveResourcesInput,
} from "./resource.schemas.js";

export interface ReservationResult {
  allocation: ResourceAllocation;
  worker: Worker;
  lockWaitMs: number;
}

export interface ReleaseResult {
  allocation: ResourceAllocation;
  worker: Worker | null;
  alreadyReleased: boolean;
}

export interface JobLookup {
  findJobById(jobId: string): Promise<Job | null>;
}

const prismaJobLookup: JobLookup = {
  findJobById: (jobId) => prisma.job.findUnique({ where: { id: jobId } }),
};

export class ResourceService {
  constructor(
    private readonly repository: ResourceRepository = prismaResourceRepository,
    private readonly jobs: JobLookup = prismaJobLookup,
  ) {}

  async reserve(input: ReserveResourcesInput): Promise<ReservationResult> {
    const job = await this.requireJob(input.jobId);

    if (job.status !== JobStatus.SCHEDULED) {
      throw new ConflictError(
        `Only scheduled jobs can reserve resources; job is ${job.status}`,
        "JOB_NOT_RESERVABLE",
      );
    }

    if (!job.assignedWorkerId) {
      throw new ConflictError(
        "Job must be placed on a worker before reserving resources",
        "JOB_NOT_PLACED",
      );
    }

    const outcome = await this.repository.reserve({
      jobId: job.id,
      workerId: job.assignedWorkerId,
      cpuMillicores: job.cpuRequiredMillicores,
      memoryMiB: job.memoryRequiredMiB,
    });

    switch (outcome.status) {
      case "RESERVED":
        return {
          allocation: outcome.allocation,
          worker: outcome.worker,
          lockWaitMs: outcome.lockWaitMs,
        };
      case "INSUFFICIENT_RESOURCES":
        throw new ConflictError(
          `Worker no longer has capacity: ${outcome.cpuAvailableMillicores}m CPU and ` +
            `${outcome.memoryAvailableMiB}MiB free, needs ${job.cpuRequiredMillicores}m and ` +
            `${job.memoryRequiredMiB}MiB`,
          "INSUFFICIENT_RESOURCES",
        );
      case "ALREADY_RESERVED":
        throw new ConflictError(
          "Job already holds a reservation",
          "ALREADY_RESERVED",
        );
      case "WORKER_NOT_FOUND":
        throw new NotFoundError("Worker");
      default:
        throw new Error("Unhandled reservation outcome");
    }
  }

  async release(input: ReleaseResourcesInput): Promise<ReleaseResult> {
    await this.requireJob(input.jobId);
    const outcome = await this.repository.release(input.jobId);

    switch (outcome.status) {
      case "RELEASED":
        return { allocation: outcome.allocation, worker: outcome.worker, alreadyReleased: false };
      case "ALREADY_RELEASED":
        return { allocation: outcome.allocation, worker: null, alreadyReleased: true };
      case "NO_ALLOCATION":
        throw new ConflictError(
          "Job holds no resource allocation to release",
          "NO_ACTIVE_ALLOCATION",
        );
      default:
        throw new Error("Unhandled release outcome");
    }
  }

  listAllocations(query: ListAllocationsQuery): Promise<ResourceAllocation[]> {
    return this.repository.listAllocations(query);
  }

  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.jobs.findJobById(jobId);
    if (!job) {
      throw new NotFoundError("Job");
    }
    return job;
  }
}

export const resourceService = new ResourceService();
