import { z } from "zod";
const ratio = z.number().min(0.05).max(1);
/** Runtime settings an operator may change. Every field is optional. */
export const updateAutoscalerSchema = z
  .object({
    enabled: z.boolean(),
    /** REACTIVE scales on measured load, ML on predicted load; one at a time. */
    strategy: z.enum(["REACTIVE", "ML"]),
    maxWorkers: z.number().int().min(0).max(20),
    workerCpuMillicores: z.number().int().min(100).max(64_000),
    workerMemoryMiB: z.number().int().min(128).max(131_072),
    scaleUpQueueThreshold: z.number().int().min(1).max(1_000),
    scaleUpUtilization: ratio,
    scaleDownUtilization: ratio,
    idleSeconds: z.number().int().min(0).max(3_600),
    cooldownSeconds: z.number().int().min(0).max(3_600),
    mlWindowPoints: z.number().int().min(3).max(100),
    mlLookAheadSeconds: z.number().int().min(5).max(300),
  })
  .partial()
  .strict();
