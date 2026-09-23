import { WorkloadPattern, WorkloadType } from "@prisma/client";

import type { CustomWorkloadConfig } from "./workload.schemas.js";

export const GENERATOR_VERSION = "v1";

const MIN_WORKLOAD_SIZE = 1;
const MAX_WORKLOAD_SIZE = 100_000_000;

export interface GeneratedWorkloadSpec {
  sequence: number;
  name: string;
  workloadType: WorkloadType;
  workloadSize: number;
  cpuRequiredMillicores: number;
  memoryRequiredMiB: number;
  estimatedDurationSeconds: number;
  priority: number;
  arrivalOffsetSeconds: number;
}

export interface GenerateSpecsInput {
  seed: number;
  count: 10 | 25 | 50 | 100;
  pattern: WorkloadPattern;
  custom?: CustomWorkloadConfig;
}

type ResourceProfileName = "LIGHT" | "MEDIUM" | "HEAVY";

interface ResourceProfile {
  cpu: readonly number[];
  memory: readonly number[];
  duration: readonly number[];
  priority: readonly number[];
}

const workloadTypes = Object.values(WorkloadType);

const profiles: Record<ResourceProfileName, ResourceProfile> = {
  LIGHT: {
    cpu: [100, 250, 500],
    memory: [64, 128, 256, 512],
    duration: [1, 5, 10],
    priority: [1, 2, 3, 4, 5],
  },
  MEDIUM: {
    cpu: [500, 1_000, 1_500, 2_000],
    memory: [256, 512, 1_024, 2_048],
    duration: [10, 20, 30, 45],
    priority: [2, 4, 6, 8],
  },
  HEAVY: {
    cpu: [2_000, 3_000, 4_000],
    memory: [2_048, 3_072, 4_096],
    duration: [30, 45, 60, 90],
    priority: [5, 7, 9, 10],
  },
};

export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomInteger(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error("Generator pool must not be empty");
  }
  return value;
}

function clampSize(value: number): number {
  return Math.min(MAX_WORKLOAD_SIZE, Math.max(MIN_WORKLOAD_SIZE, value));
}

/**
 * Derives workload size from the estimated duration and requested CPU so that the
 * persisted size reflects roughly the amount of work the estimate represents.
 */
export function derivedWorkloadSize(
  workloadType: WorkloadType,
  estimatedDurationSeconds: number,
  cpuRequiredMillicores: number,
): number {
  const cpuSeconds = (estimatedDurationSeconds * cpuRequiredMillicores) / 1_000;

  switch (workloadType) {
    case WorkloadType.SLEEP:
      return clampSize(estimatedDurationSeconds);
    case WorkloadType.CPU_INTENSIVE:
      return clampSize(Math.round(cpuSeconds * 200_000));
    case WorkloadType.SORTING:
      return clampSize(Math.round(cpuSeconds * 120_000));
    case WorkloadType.DATA_PROCESSING:
      return clampSize(Math.round(cpuSeconds * 2_000));
    case WorkloadType.MATRIX_MULTIPLICATION:
      return clampSize(Math.max(2, Math.round(Math.cbrt(cpuSeconds * 50_000_000))));
    default:
      return clampSize(Math.round(cpuSeconds * 1_000));
  }
}

function profileFor(pattern: WorkloadPattern, index: number, count: number): ResourceProfileName {
  if (pattern === WorkloadPattern.LIGHT) return "LIGHT";
  if (pattern === WorkloadPattern.HEAVY) return "HEAVY";
  if (pattern === WorkloadPattern.INCREASING) {
    const progress = index / Math.max(1, count - 1);
    return progress < 1 / 3 ? "LIGHT" : progress < 2 / 3 ? "MEDIUM" : "HEAVY";
  }
  if (pattern === WorkloadPattern.DECREASING) {
    const progress = index / Math.max(1, count - 1);
    return progress < 1 / 3 ? "HEAVY" : progress < 2 / 3 ? "MEDIUM" : "LIGHT";
  }
  if (pattern === WorkloadPattern.PERIODIC) {
    return (["LIGHT", "MEDIUM", "HEAVY", "MEDIUM"] as const)[index % 4] ?? "MEDIUM";
  }
  if (pattern === WorkloadPattern.BURST) {
    return Math.floor(index / 5) % 2 === 0 ? "HEAVY" : "LIGHT";
  }
  return "MEDIUM";
}

function arrivalOffsets(
  pattern: WorkloadPattern,
  count: number,
  random: () => number,
  custom?: CustomWorkloadConfig,
): number[] {
  if (pattern === WorkloadPattern.CUSTOM) {
    if (!custom) throw new Error("CUSTOM pattern requires custom configuration");
    return [...custom.arrivalOffsetsSeconds];
  }

  if (pattern === WorkloadPattern.BURST) {
    return Array.from({ length: count }, (_, index) => Math.floor(index / 5) * 30);
  }

  if (pattern === WorkloadPattern.CONSTANT) {
    return Array.from({ length: count }, (_, index) => index * 10);
  }

  const offsets = [0];
  const periodicGaps = [2, 2, 2, 20] as const;

  for (let index = 1; index < count; index += 1) {
    let gap: number;
    if (pattern === WorkloadPattern.LIGHT) gap = randomInteger(random, 20, 40);
    else if (pattern === WorkloadPattern.MEDIUM) gap = randomInteger(random, 8, 16);
    else if (pattern === WorkloadPattern.HEAVY) gap = randomInteger(random, 2, 6);
    else if (pattern === WorkloadPattern.INCREASING) {
      gap = Math.round(20 - (18 * index) / Math.max(1, count - 1));
    } else if (pattern === WorkloadPattern.DECREASING) {
      gap = Math.round(2 + (18 * index) / Math.max(1, count - 1));
    } else {
      gap = periodicGaps[(index - 1) % periodicGaps.length] ?? 2;
    }
    offsets.push((offsets[index - 1] ?? 0) + gap);
  }

  return offsets;
}

export function generateWorkloadSpecs(input: GenerateSpecsInput): GeneratedWorkloadSpec[] {
  const random = createMulberry32(input.seed);
  const offsets = arrivalOffsets(input.pattern, input.count, random, input.custom);
  const typePool = input.custom?.workloadTypes ?? workloadTypes;

  return Array.from({ length: input.count }, (_, index) => {
    const sequence = index + 1;
    const name = `workload-${input.seed}-${String(sequence).padStart(3, "0")}`;
    const workloadType = pick(random, typePool);

    if (input.custom) {
      const custom = input.custom;
      return {
        sequence,
        name,
        workloadType,
        workloadSize: randomInteger(random, custom.workloadSize.min, custom.workloadSize.max),
        cpuRequiredMillicores: randomInteger(
          random,
          custom.cpuRequiredMillicores.min,
          custom.cpuRequiredMillicores.max,
        ),
        memoryRequiredMiB: randomInteger(
          random,
          custom.memoryRequiredMiB.min,
          custom.memoryRequiredMiB.max,
        ),
        estimatedDurationSeconds: randomInteger(
          random,
          custom.estimatedDurationSeconds.min,
          custom.estimatedDurationSeconds.max,
        ),
        priority: randomInteger(random, custom.priority.min, custom.priority.max),
        arrivalOffsetSeconds: offsets[index] ?? 0,
      };
    }

    const profile = profiles[profileFor(input.pattern, index, input.count)];
    const cpuRequiredMillicores = pick(random, profile.cpu);
    const memoryRequiredMiB = pick(random, profile.memory);
    const estimatedDurationSeconds = pick(random, profile.duration);
    const priority = pick(random, profile.priority);

    return {
      sequence,
      name,
      workloadType,
      workloadSize: derivedWorkloadSize(
        workloadType,
        estimatedDurationSeconds,
        cpuRequiredMillicores,
      ),
      cpuRequiredMillicores,
      memoryRequiredMiB,
      estimatedDurationSeconds,
      priority,
      arrivalOffsetSeconds: offsets[index] ?? 0,
    };
  });
}
