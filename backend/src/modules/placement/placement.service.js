import { JobStatus } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { buildSnapshot, evaluatePlacement } from "./placement.accounting.js";
import { prismaPlacementRepository } from "./placement.repository.js";
export class PlacementService {
  repository;
  now;
  constructor(repository = prismaPlacementRepository, now = () => new Date()) {
    this.repository = repository;
    this.now = now;
  }
  async capacity() {
    const [workers, loads] = await Promise.all([
      this.repository.listWorkers(),
      this.repository.assignedLoadByWorker(),
    ]);
    return workers.map((worker) =>
      buildSnapshot(
        worker,
        loads.get(worker.id) ?? { cpuMillicores: 0, memoryMiB: 0 },
      ),
    );
  }
  async preview(query) {
    const job = await this.requireJob(query.jobId);
    const snapshots = await this.capacity();
    return evaluatePlacement(snapshots, job, query.strategy);
  }
  async assign(input) {
    const job = await this.requireJob(input.jobId);
    if (job.status !== JobStatus.SCHEDULED) {
      throw new ConflictError(
        `Only scheduled jobs can be placed; job is ${job.status}`,
        "JOB_NOT_PLACEABLE",
      );
    }
    if (job.assignedWorkerId) {
      throw new ConflictError(
        "Job is already placed on a worker",
        "JOB_ALREADY_PLACED",
      );
    }
    const snapshots = await this.capacity();
    const evaluation = evaluatePlacement(snapshots, job, input.strategy);
    if (!evaluation.selected) {
      throw new ConflictError(
        "No worker has enough available CPU and memory for this job",
        "INSUFFICIENT_RESOURCES",
      );
    }
    const placed = await this.repository.assign({
      jobId: job.id,
      workerId: evaluation.selected.workerId,
      strategy: input.strategy,
      placedAt: this.now(),
    });
    if (!placed) {
      throw new ConflictError(
        "Job was placed or changed state concurrently",
        "PLACEMENT_CONFLICT",
      );
    }
    return { ...evaluation, job: await this.requireJob(job.id) };
  }
  async requireJob(jobId) {
    const job = await this.repository.findJobById(jobId);
    if (!job) {
      throw new NotFoundError("Job");
    }
    return job;
  }
}
export const placementService = new PlacementService();
