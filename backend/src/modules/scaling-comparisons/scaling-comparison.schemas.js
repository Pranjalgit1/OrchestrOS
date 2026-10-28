import { PlacementStrategy, SchedulingPolicy, WorkloadType } from "@prisma/client";
import { z } from "zod";
import { BENCHMARK_PATTERNS } from "../benchmarks/benchmark.schemas.js";

/** Reactive runs first, then ML, so every comparison reads the same way. */
export const STRATEGY_ORDER = ["REACTIVE", "ML"];

/**
 * One comparison runs real containers twice. Everything except the
 * autoscaling strategy is chosen here and held fixed for both runs. A ramp
 * (INCREASING) is the default because it is where prediction can help most.
 */
export const startScalingComparisonSchema = z
  .object({
    count: z.union([z.literal(10), z.literal(25), z.literal(50)]).default(25),
    pattern: z.enum(BENCHMARK_PATTERNS).default("INCREASING"),
    seed: z.number().int().min(0).max(2_147_483_647).default(42),
    workloadTypes: z.array(z.nativeEnum(WorkloadType)).min(1).max(5).default([WorkloadType.SLEEP]),
    policy: z.nativeEnum(SchedulingPolicy).default(SchedulingPolicy.FCFS),
    strategy: z.nativeEnum(PlacementStrategy).default(PlacementStrategy.LEAST_LOADED),
    /** Applies only when the policy is Round Robin. */
    timeQuantumSeconds: z.number().int().min(1).max(3_600).default(5),
    jobsPerTick: z.number().int().min(1).max(25).default(25),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.workloadTypes).size !== input.workloadTypes.length) {
      context.addIssue({ code: "custom", path: ["workloadTypes"], message: "Each workload type may appear only once" });
    }
  });

export const scalingComparisonIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const listScalingComparisonsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
  .strict();
