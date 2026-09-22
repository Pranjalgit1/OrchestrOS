import { WorkloadType } from "@prisma/client";
import { z } from "zod";

/**
 * The contract between OrchestrOS and the workload container.
 *
 * Everything here is a constant on purpose. The image is not configurable, the
 * command is not configurable, and the only inputs the container receives are
 * the four controlled environment variables below. There is no code path that
 * can run an operator-supplied image, command, script, or formula.
 */

/** The single image OrchestrOS is allowed to run. Built from `workload-runner/`. */
export const WORKLOAD_IMAGE = "orchestros/workload-runner:v1";

/** Runner protocol version this backend understands. */
export const WORKLOAD_RUNNER_VERSION = "v1";

/** The complete set of environment variables passed into a workload container. */
export const RUNNER_ENV_KEYS = [
  "ORCHESTROS_WORKLOAD_TYPE",
  "ORCHESTROS_WORKLOAD_SIZE",
  "ORCHESTROS_SEED",
  "ORCHESTROS_MEMORY_LIMIT_MIB",
] as const;

export const CONTAINER_NAME_PREFIX = "orchestros-exec-";

export const CONTAINER_LABEL_MANAGED = "orchestros.managed";

/** Runner exit code used when the container refused its inputs. */
export const RUNNER_EXIT_INVALID_INPUT = 64;

/** Runner exit code used when the workload itself threw. */
export const RUNNER_EXIT_WORKLOAD_FAILED = 70;

/** Exit code Docker reports for a container killed by the kernel OOM killer. */
export const EXIT_CODE_OOM_KILLED = 137;

/** Grace period given to a stop request before the kernel kills the container. */
export const CONTAINER_STOP_TIMEOUT_SECONDS = 5;

export function containerNameFor(executionId: string): string {
  return `${CONTAINER_NAME_PREFIX}${executionId}`;
}

/**
 * Deterministic 32-bit seed derived from the job name.
 *
 * Generated job names already encode the batch seed and sequence, so a
 * reproduced batch reproduces the same workload seed, and therefore the same
 * runner checksum, without storing an extra column.
 */
export function deriveWorkloadSeed(jobName: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < jobName.length; index += 1) {
    hash ^= jobName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function buildRunnerEnvironment(input: {
  workloadType: WorkloadType;
  workloadSize: number;
  seed: number;
  memoryMiB: number;
}): string[] {
  return [
    `ORCHESTROS_WORKLOAD_TYPE=${input.workloadType}`,
    `ORCHESTROS_WORKLOAD_SIZE=${input.workloadSize}`,
    `ORCHESTROS_SEED=${input.seed}`,
    `ORCHESTROS_MEMORY_LIMIT_MIB=${input.memoryMiB}`,
  ];
}

/** Shape of the single JSON line the runner prints on success. */
export const runnerResultSchema = z
  .object({
    runner: z.literal(WORKLOAD_RUNNER_VERSION),
    workloadType: z.nativeEnum(WorkloadType),
    workloadSize: z.number().int().positive(),
    effectiveSize: z.number().int().positive(),
    seed: z.number().int().min(0),
    operations: z.number().int().min(0),
    checksum: z.string().regex(/^[0-9a-f]{8}$/),
    durationMs: z.number().int().min(0),
  })
  .strict();

export type RunnerResult = z.infer<typeof runnerResultSchema>;

/**
 * Parses the runner's stdout. Returns null when the output is missing or does
 * not match the contract, so a malformed result is recorded as a failure rather
 * than silently trusted.
 */
export function parseRunnerResult(stdout: string): RunnerResult | null {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{") && entry.endsWith("}"))
    .pop();

  if (!line) return null;

  try {
    const parsed = runnerResultSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Human-readable reason for a non-zero exit, used for `failureReason`. */
export function describeExitCode(exitCode: number, oomKilled: boolean): string {
  if (oomKilled || exitCode === EXIT_CODE_OOM_KILLED) {
    return "container exceeded its memory reservation and was killed by the kernel";
  }
  if (exitCode === RUNNER_EXIT_INVALID_INPUT) {
    return "workload runner refused its inputs";
  }
  if (exitCode === RUNNER_EXIT_WORKLOAD_FAILED) {
    return "workload failed while running";
  }
  return `container exited with code ${exitCode}`;
}
