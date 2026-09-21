import { z } from "zod";

export const createWorkerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Use letters, numbers, hyphens, or underscores"),
    cpuCapacityMillicores: z.number().int().min(100).max(64_000),
    memoryCapacityMiB: z.number().int().min(128).max(131_072),
  })
  .strict();

export const workerIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;
