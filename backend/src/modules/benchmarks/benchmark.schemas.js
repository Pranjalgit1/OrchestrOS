import { PlacementStrategy, SchedulingPolicy, WorkloadType } from "@prisma/client";
import { z } from "zod";

/** Patterns a benchmark can use. CUSTOM needs a hand-written config, so it is left out. */
export const BENCHMARK_PATTERNS = [
  "IMMEDIATE",
  "LIGHT",
  "MEDIUM",
  "HEAVY",
  "CONSTANT",
  "BURST",
  "INCREASING",
  "DECREASING",
  "PERIODIC",
];

export const ALL_POLICIES = [
  SchedulingPolicy.FCFS,
  SchedulingPolicy.SJF,
  SchedulingPolicy.PRIORITY,
  SchedulingPolicy.ROUND_ROBIN,
];

/**
 * A suite runs real containers once per policy, so its size is bounded: up to
 * 50 jobs and four policies keeps a full comparison to minutes, not hours.
 */
export const startBenchmarkSchema = z
  .object({
    policies: z.array(z.nativeEnum(SchedulingPolicy)).min(1).max(4).default(ALL_POLICIES),
    strategy: z.nativeEnum(PlacementStrategy).default(PlacementStrategy.LEAST_LOADED),
    count: z.union([z.literal(10), z.literal(25), z.literal(50)]).default(10),
    pattern: z.enum(BENCHMARK_PATTERNS).default("IMMEDIATE"),
    seed: z.number().int().min(0).max(2_147_483_647).default(42),
    workloadTypes: z.array(z.nativeEnum(WorkloadType)).min(1).max(5).default([WorkloadType.SLEEP]),
    /** Applies to the Round Robin run only. */
    timeQuantumSeconds: z.number().int().min(1).max(3_600).default(5),
    jobsPerTick: z.number().int().min(1).max(25).default(25),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.policies).size !== input.policies.length) {
      context.addIssue({ code: "custom", path: ["policies"], message: "Each policy may appear only once" });
    }
    if (new Set(input.workloadTypes).size !== input.workloadTypes.length) {
      context.addIssue({ code: "custom", path: ["workloadTypes"], message: "Each workload type may appear only once" });
    }
  });

export const benchmarkIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const listBenchmarksQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
  .strict();
