import { SchedulingPolicy } from "@prisma/client";
import { z } from "zod";

export const comparisonSimulateSchema = z
  .object({
    seed: z.number().int().min(0).max(2_147_483_647).default(42),
    count: z.number().int().min(1).max(200).default(20),
    /** Arrival pattern (maps to workload generator pattern). */
    pattern: z
      .enum([
        "IMMEDIATE",
        "LIGHT",
        "MEDIUM",
        "HEAVY",
        "CONSTANT",
        "BURST",
        "INCREASING",
        "DECREASING",
        "PERIODIC",
      ])
      .default("IMMEDIATE"),
    /** Which scheduling policies to compare. Minimum 2. */
    policies: z
      .array(z.nativeEnum(SchedulingPolicy))
      .min(1)
      .max(4)
      .default(["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"]),
    /** Optional time quantum for ROUND_ROBIN (seconds). */
    timeQuantumSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .strict();
