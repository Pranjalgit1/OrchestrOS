import { z } from "zod";

export const AutoScalerMode = {
  OFF: "OFF",
  REACTIVE: "REACTIVE",
  ML: "ML",
  BOTH: "BOTH",
};

export const ScaleDirection = {
  UP: "UP",
  DOWN: "DOWN",
  STABLE: "STABLE",
};

export const autoScalingConfigSchema = z
  .object({
    mode: z.enum(["OFF", "REACTIVE", "ML", "BOTH"]).default("OFF"),
    /** CPU utilization fraction (0–1) above which reactive scaler triggers scale-up. */
    cpuScaleUpThreshold: z.number().min(0).max(1).default(0.75),
    /** CPU utilization fraction (0–1) below which reactive scaler triggers scale-down. */
    cpuScaleDownThreshold: z.number().min(0).max(1).default(0.25),
    /** Number of queued eligible jobs above which reactive scaler triggers scale-up. */
    queueDepthScaleUpThreshold: z.number().int().min(1).default(5),
    /** Number of queued eligible jobs below which reactive scaler triggers scale-down. */
    queueDepthScaleDownThreshold: z.number().int().min(0).default(1),
    /** Minimum number of workers that must always remain. */
    minWorkers: z.number().int().min(1).default(1),
    /** Maximum number of workers the scaler may provision. */
    maxWorkers: z.number().int().min(1).default(8),
    /** How many historical monitoring points the ML scaler uses for regression. */
    mlWindowPoints: z.number().int().min(3).max(100).default(20),
    /** Seconds into the future ML scaler tries to predict load. */
    mlLookAheadSeconds: z.number().int().min(10).max(300).default(60),
  })
  .strict()
  .refine((d) => d.cpuScaleUpThreshold > d.cpuScaleDownThreshold, {
    message: "cpuScaleUpThreshold must be greater than cpuScaleDownThreshold",
    path: ["cpuScaleUpThreshold"],
  })
  .refine((d) => d.maxWorkers >= d.minWorkers, {
    message: "maxWorkers must be >= minWorkers",
    path: ["maxWorkers"],
  });

export const triggerAutoScalingSchema = z
  .object({
    dryRun: z.boolean().default(false),
  })
  .strict();
