import { SchedulingPolicy } from "@prisma/client";
import { z } from "zod";

export const DEFAULT_TIME_QUANTUM_SECONDS = 10;

export const dispatchSchema = z
  .object({
    policy: z.nativeEnum(SchedulingPolicy),
    count: z.number().int().min(1).max(100).default(1),
    timeQuantumSeconds: z.number().int().min(1).max(3_600).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.policy !== SchedulingPolicy.ROUND_ROBIN && input.timeQuantumSeconds !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["timeQuantumSeconds"],
        message: "A time quantum applies only to the ROUND_ROBIN policy",
      });
    }
  });

export const previewQuerySchema = z
  .object({
    policy: z.nativeEnum(SchedulingPolicy),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type DispatchInput = z.infer<typeof dispatchSchema>;
export type PreviewQuery = z.infer<typeof previewQuerySchema>;
