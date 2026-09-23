import { ExecutionStatus } from "@prisma/client";
import { z } from "zod";

/**
 * A start request carries only a job id. The image, command, environment, CPU,
 * memory, and timeout are all decided by the backend, so there is no field a
 * client could use to influence what runs inside the container.
 */
export const startExecutionSchema = z
  .object({
    jobId: z.uuid(),
  })
  .strict();

export const executionIdParamsSchema = z
  .object({
    executionId: z.uuid(),
  })
  .strict();

export const listExecutionsQuerySchema = z
  .object({
    jobId: z.uuid().optional(),
    workerId: z.uuid().optional(),
    status: z.nativeEnum(ExecutionStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type StartExecutionInput = z.infer<typeof startExecutionSchema>;
export type ExecutionIdParams = z.infer<typeof executionIdParamsSchema>;
export type ListExecutionsQuery = z.infer<typeof listExecutionsQuerySchema>;
