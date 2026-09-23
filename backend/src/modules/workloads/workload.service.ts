import { Prisma, WorkloadPattern } from "@prisma/client";

import { NotFoundError } from "../../errors/app-error.js";
import {
  GENERATOR_VERSION,
  generateWorkloadSpecs,
  type GeneratedWorkloadSpec,
} from "./workload.generator.js";
import {
  prismaWorkloadRepository,
  type WorkloadBatchWithJobs,
  type WorkloadRepository,
} from "./workload.repository.js";
import type {
  GenerateWorkloadInput,
  ReuseWorkloadInput,
} from "./workload.schemas.js";

function normalizePattern(pattern: GenerateWorkloadInput["pattern"]): WorkloadPattern {
  return pattern === "SUDDEN_BURST" ? WorkloadPattern.BURST : WorkloadPattern[pattern];
}

function requestedStart(startAt: string | undefined, now: () => Date): Date {
  return startAt ? new Date(startAt) : now();
}

export class WorkloadService {
  constructor(
    private readonly repository: WorkloadRepository = prismaWorkloadRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  generate(input: GenerateWorkloadInput): Promise<WorkloadBatchWithJobs> {
    const pattern = normalizePattern(input.pattern);
    const jobs = generateWorkloadSpecs({
      seed: input.seed,
      count: input.count,
      pattern,
      ...(input.custom ? { custom: input.custom } : {}),
    });
    const parameters: Prisma.InputJsonValue = input.custom
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

  async getById(id: string): Promise<WorkloadBatchWithJobs> {
    const batch = await this.repository.findBatchById(id);
    if (!batch) throw new NotFoundError("Workload batch");
    return batch;
  }

  async reuse(id: string, input: ReuseWorkloadInput): Promise<WorkloadBatchWithJobs> {
    const source = await this.getById(id);
    const jobs: GeneratedWorkloadSpec[] = source.jobs.map((job) => {
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
      parameters: source.parameters as Prisma.InputJsonValue,
      startsAt: requestedStart(input.startAt, this.now),
      sourceBatchId: source.id,
      jobs,
    });
  }
}

export const workloadService = new WorkloadService();
