import { z } from "zod";

/**
 * Monitoring is read-only apart from capturing a sample, and none of these
 * inputs can change orchestration state. Windows are bounded so a query cannot
 * ask the database to scan without limit.
 */

export const jobMetricsQuerySchema = z
  .object({
    windowMinutes: z.coerce.number().int().min(1).max(10_080).default(60),
  })
  .strict();

export const sampleHistoryQuerySchema = z
  .object({
    workerId: z.uuid().optional(),
    windowMinutes: z.coerce.number().int().min(1).max(10_080).default(60),
    limit: z.coerce.number().int().min(1).max(5_000).default(500),
  })
  .strict();

export type JobMetricsQuery = z.infer<typeof jobMetricsQuerySchema>;
export type SampleHistoryQuery = z.infer<typeof sampleHistoryQuerySchema>;
