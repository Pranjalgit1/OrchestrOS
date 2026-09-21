import { JobStatus, WorkloadType } from "@prisma/client";
import { z } from "zod";

export const createJobSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    workloadType: z.nativeEnum(WorkloadType),
    cpuRequiredMillicores: z.number().int().min(100).max(64_000),
    memoryRequiredMiB: z.number().int().min(64).max(131_072),
    estimatedDurationSeconds: z.number().int().min(1).max(86_400),
    priority: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const listJobsQuerySchema = z
  .object({
    status: z.nativeEnum(JobStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const jobIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
