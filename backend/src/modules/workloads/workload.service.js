import { WorkloadPattern } from "@prisma/client";
import { NotFoundError } from "../../errors/app-error.js";
import {
  GENERATOR_VERSION,
  generateWorkloadSpecs,
} from "./workload.generator.js";
import { prismaWorkloadRepository } from "./workload.repository.js";
function normalizePattern(pattern) {
  return pattern === "SUDDEN_BURST"
    ? WorkloadPattern.BURST
    : WorkloadPattern[pattern];
}
function requestedStart(startAt, now) {
  return startAt ? new Date(startAt) : now();
}
export class WorkloadService {
  repository;
  now;
  constructor(repository = prismaWorkloadRepository, now = () => new Date()) {
    this.repository = repository;
    this.now = now;
  }
  generate(input) {
    const pattern = normalizePattern(input.pattern);
    const jobs = generateWorkloadSpecs({
      seed: input.seed,
      count: input.count,
      pattern,
      ...(input.custom ? { custom: input.custom } : {}),
    });
    const parameters = input.custom
      ? { mode: "custom", custom: input.custom }
      : { mode: "predefined", contract: GENERATOR_VERSION };
    return this.repository.createBatch({
      seed: input.seed,
      jobCount: input.count,
      pattern,
      generatorVersion: GENERATOR_VERSION,
      parameters,
      startsAt: requestedStart(input.startAt, this.now),
      jobs,
    });
  }
  async getById(id) {
    const batch = await this.repository.findBatchById(id);
    if (!batch) throw new NotFoundError("Workload batch");
    return batch;
  }
  async reuse(id, input) {
    const source = await this.getById(id);
    const jobs = source.jobs.map((job) => {
      if (job.batchSequence === null) {
        throw new Error(`Batch job ${job.id} is missing its batch sequence`);
      }
      return {
        sequence: job.batchSequence,
        name: job.name,
        workloadType: job.workloadType,
        workloadSize: job.workloadSize,
        cpuRequiredMillicores: job.cpuRequiredMillicores,
        memoryRequiredMiB: job.memoryRequiredMiB,
        estimatedDurationSeconds: job.estimatedDurationSeconds,
        priority: job.priority,
        arrivalOffsetSeconds: job.arrivalOffsetSeconds,
      };
    });
    return this.repository.createBatch({
      seed: source.seed,
      jobCount: jobs.length,
      pattern: source.pattern,
      generatorVersion: source.generatorVersion,
      parameters: source.parameters,
      startsAt: requestedStart(input.startAt, this.now),
      sourceBatchId: source.id,
      jobs,
    });
  }
}
export const workloadService = new WorkloadService();
