import { PlacementStrategy, SchedulingPolicy } from "@prisma/client";
import { z } from "zod";

/**
 * The orchestrator exposes the pipeline as one action so a client does not have
 * to call scheduling, placement, reservation, and execution in sequence itself.
 *
 * A request carries only the two decisions a user actually makes: which
 * scheduling policy and which placement strategy. Everything else, including
 * which job is next and whether it fits, stays a backend decision.
 */
export const runOrchestratorSchema = z
  .object({
    policy: z.nativeEnum(SchedulingPolicy),
    strategy: z.nativeEnum(PlacementStrategy),
    /** How many jobs to advance in this call. One is a single-step demo. */
    maxJobs: z.number().int().min(1).max(25).default(1),
    timeQuantumSeconds: z.number().int().min(1).max(3_600).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.policy !== SchedulingPolicy.ROUND_ROBIN &&
      input.timeQuantumSeconds !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["timeQuantumSeconds"],
        message: "A time quantum applies only to the ROUND_ROBIN policy",
      });
    }
  });

export const orchestratorStateQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(60),
  })
  .strict();

export type RunOrchestratorInput = z.infer<typeof runOrchestratorSchema>;
export type OrchestratorStateQuery = z.infer<typeof orchestratorStateQuerySchema>;
