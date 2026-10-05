import { JobStatus } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { prisma } from "../../lib/prisma.js";
import { prismaResourceRepository } from "./resource.repository.js";
const prismaJobLookup = {
  findJobById: (jobId) => prisma.job.findUnique({ where: { id: jobId } }),
};
export class ResourceService {
  repository;
  jobs;
  constructor(repository = prismaResourceRepository, jobs = prismaJobLookup) {
    this.repository = repository;
    this.jobs = jobs;
  }
  async reserve(input) {
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
      case "JOB_NOT_RESERVABLE":
        throw new ConflictError("Job was cancelled or is no longer scheduled", "JOB_NOT_RESERVABLE");
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
  async release(input) {
    await this.requireJob(input.jobId);
    const outcome = await this.repository.release(input.jobId);
    switch (outcome.status) {
      case "RELEASED":
        return {
          allocation: outcome.allocation,
          worker: outcome.worker,
          alreadyReleased: false,
        };
      case "ALREADY_RELEASED":
        return {
          allocation: outcome.allocation,
          worker: null,
          alreadyReleased: true,
        };
      case "NO_ALLOCATION":
        throw new ConflictError(
          "Job holds no resource allocation to release",
          "NO_ACTIVE_ALLOCATION",
        );
      default:
        throw new Error("Unhandled release outcome");
    }
  }
  listAllocations(query) {
    return this.repository.listAllocations(query);
  }
  async requireJob(jobId) {
    const job = await this.jobs.findJobById(jobId);
    if (!job) {
      throw new NotFoundError("Job");
    }
    return job;
  }
}
export const resourceService = new ResourceService();
