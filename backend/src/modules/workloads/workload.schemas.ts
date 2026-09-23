import { WorkloadType } from "@prisma/client";
import { z } from "zod";

export const workloadCountSchema = z.union([
  z.literal(10),
  z.literal(25),
  z.literal(50),
  z.literal(100),
]);

export const inputPatternSchema = z.enum([
  "LIGHT",
  "MEDIUM",
  "HEAVY",
  "CONSTANT",
  "BURST",
  "SUDDEN_BURST",
  "INCREASING",
  "DECREASING",
  "PERIODIC",
  "CUSTOM",
]);

function integerRange(minimum: number, maximum: number) {
  return z
    .object({
      min: z.number().int().min(minimum).max(maximum),
      max: z.number().int().min(minimum).max(maximum),
    })
    .strict()
    .refine((range) => range.min <= range.max, {
      message: "Range minimum must not exceed maximum",
    });
}

export const customWorkloadConfigSchema = z
  .object({
    workloadTypes: z.array(z.nativeEnum(WorkloadType)).min(1).max(5),
    workloadSize: integerRange(1, 100_000_000),
    cpuRequiredMillicores: integerRange(100, 64_000),
    memoryRequiredMiB: integerRange(64, 131_072),
    estimatedDurationSeconds: integerRange(1, 86_400),
    priority: integerRange(1, 10),
    arrivalOffsetsSeconds: z.array(z.number().int().min(0).max(86_400)).min(10).max(100),
  })
  .strict();

export const generateWorkloadSchema = z
  .object({
    seed: z.number().int().min(0).max(2_147_483_647),
    count: workloadCountSchema,
    pattern: inputPatternSchema,
    startAt: z.string().datetime({ offset: true }).optional(),
    custom: customWorkloadConfigSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.pattern === "CUSTOM" && !input.custom) {
      context.addIssue({
        code: "custom",
        path: ["custom"],
        message: "Custom configuration is required for the CUSTOM pattern",
      });
      return;
    }

    if (input.pattern !== "CUSTOM" && input.custom) {
      context.addIssue({
        code: "custom",
        path: ["custom"],
        message: "Custom configuration is allowed only for the CUSTOM pattern",
      });
      return;
    }

    if (!input.custom) {
      return;
    }

    if (input.custom.arrivalOffsetsSeconds.length !== input.count) {
      context.addIssue({
        code: "custom",
        path: ["custom", "arrivalOffsetsSeconds"],
        message: "Arrival offset count must equal the requested job count",
      });
    }

    for (let index = 1; index < input.custom.arrivalOffsetsSeconds.length; index += 1) {
      const previous = input.custom.arrivalOffsetsSeconds[index - 1];
      const current = input.custom.arrivalOffsetsSeconds[index];
      if (previous !== undefined && current !== undefined && current < previous) {
        context.addIssue({
          code: "custom",
          path: ["custom", "arrivalOffsetsSeconds", index],
          message: "Arrival offsets must be nondecreasing",
        });
        break;
      }
    }
  });

export const reuseWorkloadSchema = z
  .object({
    startAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const workloadBatchIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type GenerateWorkloadInput = z.infer<typeof generateWorkloadSchema>;
export type CustomWorkloadConfig = z.infer<typeof customWorkloadConfigSchema>;
export type ReuseWorkloadInput = z.infer<typeof reuseWorkloadSchema>;
