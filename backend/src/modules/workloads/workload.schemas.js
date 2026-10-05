import { WorkloadType } from "@prisma/client";
import { z } from "zod";
import { derivedWorkloadSize, STUDY_LIMITS } from "./workload.generator.js";
export const workloadCountSchema = z.union([
  z.literal(10),
  z.literal(25),
  z.literal(50),
  z.literal(100),
]);
export const inputPatternSchema = z.enum([
  "IMMEDIATE",
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
function integerRange(minimum, maximum) {
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
    cpuRequiredMillicores: integerRange(100, STUDY_LIMITS.cpuMillicores),
    memoryRequiredMiB: integerRange(64, STUDY_LIMITS.memoryMiB),
    estimatedDurationSeconds: integerRange(1, STUDY_LIMITS.durationSeconds),
    priority: integerRange(1, 10),
    arrivalOffsetsSeconds: z
      .array(z.number().int().min(0).max(86_400))
      .min(10)
      .max(100),
  })
  .strict()
  .superRefine((custom, context) => {
    // A shared custom size must be safe for every selected workload type.
    for (const type of custom.workloadTypes) {
      const ceiling = derivedWorkloadSize(type, STUDY_LIMITS.durationSeconds, STUDY_LIMITS.cpuMillicores);
      if (custom.workloadSize.max > ceiling) {
        context.addIssue({ code: "custom", path: ["workloadSize", "max"],
          message: `${type} study workloads must not exceed ${ceiling} work units` });
      }
    }
  });
export const generateWorkloadSchema = z
  .object({
    seed: z.number().int().min(0).max(2_147_483_647),
    count: workloadCountSchema,
    pattern: inputPatternSchema,
    workloadTypes: z.array(z.nativeEnum(WorkloadType)).min(1).max(5).optional(),
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
    if (input.workloadTypes) {
      context.addIssue({ code: "custom", path: ["workloadTypes"],
        message: "For CUSTOM, specify workload types inside custom configuration" });
    }
    if (input.custom.arrivalOffsetsSeconds.length !== input.count) {
      context.addIssue({
        code: "custom",
        path: ["custom", "arrivalOffsetsSeconds"],
        message: "Arrival offset count must equal the requested job count",
      });
    }
    for (
      let index = 1;
      index < input.custom.arrivalOffsetsSeconds.length;
      index += 1
    ) {
      const previous = input.custom.arrivalOffsetsSeconds[index - 1];
      const current = input.custom.arrivalOffsetsSeconds[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current < previous
      ) {
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
