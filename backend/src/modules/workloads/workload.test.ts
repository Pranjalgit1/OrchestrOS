import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  JobStatus,
  Prisma,
  WorkloadPattern,
  WorkloadType,
  type Job,
} from "@prisma/client";

import { AppError } from "../../errors/app-error.js";
import { createJobSchema } from "../jobs/job.schemas.js";
import {
  createMulberry32,
  derivedWorkloadSize,
  generateWorkloadSpecs,
  type GenerateSpecsInput,
} from "./workload.generator.js";
import type {
  PersistWorkloadBatchInput,
  WorkloadBatchWithJobs,
  WorkloadRepository,
} from "./workload.repository.js";
import {
  customWorkloadConfigSchema,
  generateWorkloadSchema,
} from "./workload.schemas.js";
import { WorkloadService } from "./workload.service.js";

const predefinedPatterns = [
  WorkloadPattern.LIGHT,
  WorkloadPattern.MEDIUM,
  WorkloadPattern.HEAVY,
  WorkloadPattern.CONSTANT,
  WorkloadPattern.BURST,
  WorkloadPattern.INCREASING,
  WorkloadPattern.DECREASING,
  WorkloadPattern.PERIODIC,
] as const;

const validCustom = {
  workloadTypes: [WorkloadType.SORTING, WorkloadType.DATA_PROCESSING],
  workloadSize: { min: 1_000, max: 2_000 },
  cpuRequiredMillicores: { min: 500, max: 1_000 },
  memoryRequiredMiB: { min: 256, max: 512 },
  estimatedDurationSeconds: { min: 5, max: 10 },
  priority: { min: 2, max: 8 },
  arrivalOffsetsSeconds: Array.from({ length: 10 }, (_, index) => index * 3),
} as const;

function comparableSpecs(specs: ReturnType<typeof generateWorkloadSpecs>): unknown[] {
  return specs.map(({ sequence, ...spec }) => ({ sequence, ...spec }));
}

function gaps(offsets: number[]): number[] {
  return offsets.slice(1).map((offset, index) => offset - (offsets[index] ?? 0));
}

function specHash(specs: ReturnType<typeof generateWorkloadSpecs>): string {
  return createHash("sha256").update(JSON.stringify(specs)).digest("hex").slice(0, 16);
}

class InMemoryWorkloadRepository implements WorkloadRepository {
  readonly created: PersistWorkloadBatchInput[] = [];
  private readonly batches = new Map<string, WorkloadBatchWithJobs>();

  async createBatch(input: PersistWorkloadBatchInput): Promise<WorkloadBatchWithJobs> {
    this.created.push(input);
    const id = randomUUID();
    const createdAt = new Date();
    const jobs: Job[] = input.jobs.map((spec) => ({
      id: randomUUID(),
      name: spec.name,
      workloadType: spec.workloadType,
      workloadSize: spec.workloadSize,
      status: JobStatus.QUEUED,
      cpuRequiredMillicores: spec.cpuRequiredMillicores,
      memoryRequiredMiB: spec.memoryRequiredMiB,
      estimatedDurationSeconds: spec.estimatedDurationSeconds,
      priority: spec.priority,
      workloadBatchId: id,
      batchSequence: spec.sequence,
      arrivalOffsetSeconds: spec.arrivalOffsetSeconds,
      arrivalAt: new Date(input.startsAt.getTime() + spec.arrivalOffsetSeconds * 1_000),
      schedulingPolicy: null,
      scheduledAt: null,
      timeQuantumSeconds: null,
      schedulingRounds: 0,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      assignedWorkerId: null,
      containerId: null,
      result: null,
      failureReason: null,
    }));
    const batch = {
      id,
      seed: input.seed,
      jobCount: input.jobCount,
      pattern: input.pattern,
      generatorVersion: input.generatorVersion,
      parameters: input.parameters as Prisma.JsonValue,
      startsAt: input.startsAt,
      sourceBatchId: input.sourceBatchId ?? null,
      createdAt,
      jobs,
    } satisfies WorkloadBatchWithJobs;
    this.batches.set(id, batch);
    return batch;
  }

  async findBatchById(id: string): Promise<WorkloadBatchWithJobs | null> {
    return this.batches.get(id) ?? null;
  }
}

test("same generator input produces identical specs and a different seed changes them", () => {
  const input: GenerateSpecsInput = {
    seed: 12_345,
    count: 25,
    pattern: WorkloadPattern.MEDIUM,
  };
  const first = generateWorkloadSpecs(input);
  const second = generateWorkloadSpecs(input);
  const different = generateWorkloadSpecs({ ...input, seed: 12_346 });

  assert.deepEqual(comparableSpecs(first), comparableSpecs(second));
  assert.notDeepEqual(comparableSpecs(first), comparableSpecs(different));
});

test("all supported counts and predefined patterns produce safe varied controlled jobs", () => {
  for (const count of [10, 25, 50, 100] as const) {
    for (const pattern of predefinedPatterns) {
      const specs = generateWorkloadSpecs({ seed: 77, count, pattern });
      const distinctTypes = new Set(specs.map((spec) => spec.workloadType)).size;
      assert.equal(specs.length, count);

      // Sampling is deterministic, so small batches may omit a type while larger ones cover all five.
      if (count >= 25) {
        assert.equal(distinctTypes, 5, `${pattern} at ${count} jobs covered ${distinctTypes} types`);
      } else {
        assert.ok(distinctTypes >= 3, `${pattern} at ${count} jobs covered ${distinctTypes} types`);
      }
      assert.ok(new Set(specs.map((spec) => spec.cpuRequiredMillicores)).size > 1);
      assert.ok(new Set(specs.map((spec) => spec.memoryRequiredMiB)).size > 1);
      assert.ok(new Set(specs.map((spec) => spec.estimatedDurationSeconds)).size > 1);
      assert.ok(new Set(specs.map((spec) => spec.priority)).size > 1);

      for (const spec of specs) {
        assert.equal(
          createJobSchema.safeParse({
            name: spec.name,
            workloadType: spec.workloadType,
            workloadSize: spec.workloadSize,
            cpuRequiredMillicores: spec.cpuRequiredMillicores,
            memoryRequiredMiB: spec.memoryRequiredMiB,
            estimatedDurationSeconds: spec.estimatedDurationSeconds,
            priority: spec.priority,
          }).success,
          true,
        );
      }
    }
  }
});

test("temporal patterns have their documented deterministic shapes", () => {
  const constant = generateWorkloadSpecs({ seed: 1, count: 10, pattern: WorkloadPattern.CONSTANT });
  assert.deepEqual(constant.map((job) => job.arrivalOffsetSeconds), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

  const burst = generateWorkloadSpecs({ seed: 1, count: 10, pattern: WorkloadPattern.BURST });
  assert.deepEqual(burst.map((job) => job.arrivalOffsetSeconds), [0, 0, 0, 0, 0, 30, 30, 30, 30, 30]);

  const increasing = gaps(
    generateWorkloadSpecs({ seed: 1, count: 10, pattern: WorkloadPattern.INCREASING }).map(
      (job) => job.arrivalOffsetSeconds,
    ),
  );
  assert.ok(increasing.every((gap, index) => index === 0 || gap <= (increasing[index - 1] ?? gap)));

  const decreasing = gaps(
    generateWorkloadSpecs({ seed: 1, count: 10, pattern: WorkloadPattern.DECREASING }).map(
      (job) => job.arrivalOffsetSeconds,
    ),
  );
  assert.ok(decreasing.every((gap, index) => index === 0 || gap >= (decreasing[index - 1] ?? gap)));

  const periodic = gaps(
    generateWorkloadSpecs({ seed: 1, count: 10, pattern: WorkloadPattern.PERIODIC }).map(
      (job) => job.arrivalOffsetSeconds,
    ),
  );
  assert.deepEqual(periodic.slice(0, 8), [2, 2, 2, 20, 2, 2, 2, 20]);
});

test("custom validation enforces safe ranges, exact count, and ordered offsets", () => {
  assert.equal(customWorkloadConfigSchema.safeParse(validCustom).success, true);
  assert.equal(
    generateWorkloadSchema.safeParse({ seed: 1, count: 10, pattern: "CUSTOM" }).success,
    false,
  );
  assert.equal(
    generateWorkloadSchema.safeParse({
      seed: 1,
      count: 10,
      pattern: "LIGHT",
      custom: validCustom,
    }).success,
    false,
  );
  assert.equal(
    generateWorkloadSchema.safeParse({
      seed: 1,
      count: 25,
      pattern: "CUSTOM",
      custom: validCustom,
    }).success,
    false,
  );
  assert.equal(
    generateWorkloadSchema.safeParse({
      seed: 1,
      count: 10,
      pattern: "CUSTOM",
      custom: { ...validCustom, arrivalOffsetsSeconds: [0, 2, 1, 3, 4, 5, 6, 7, 8, 9] },
    }).success,
    false,
  );
  assert.equal(
    generateWorkloadSchema.safeParse({ seed: 1, count: 12, pattern: "LIGHT" }).success,
    false,
  );
});

test("service normalizes burst alias and captures one deterministic start time", async () => {
  const repository = new InMemoryWorkloadRepository();
  const fixedNow = new Date("2026-09-21T12:00:00.000Z");
  const service = new WorkloadService(repository, () => fixedNow);
  const batch = await service.generate({ seed: 9, count: 10, pattern: "SUDDEN_BURST" });

  assert.equal(repository.created.length, 1);
  assert.equal(repository.created[0]?.pattern, WorkloadPattern.BURST);
  assert.equal(batch.startsAt.toISOString(), fixedNow.toISOString());
  assert.equal(batch.jobs.length, 10);
  assert.ok(batch.jobs.every((job) => job.status === JobStatus.QUEUED));
});

test("reuse clones persisted specs instead of regenerating them", async () => {
  const repository = new InMemoryWorkloadRepository();
  const service = new WorkloadService(repository, () => new Date("2026-09-21T12:00:00.000Z"));
  const source = await service.generate({ seed: 55, count: 10, pattern: "PERIODIC" });
  const reused = await service.reuse(source.id, { startAt: "2026-09-22T12:00:00.000Z" });

  assert.equal(reused.sourceBatchId, source.id);
  assert.notEqual(reused.id, source.id);
  assert.deepEqual(
    reused.jobs.map((job) => [job.workloadType, job.workloadSize, job.cpuRequiredMillicores, job.memoryRequiredMiB, job.estimatedDurationSeconds, job.priority, job.arrivalOffsetSeconds]),
    source.jobs.map((job) => [job.workloadType, job.workloadSize, job.cpuRequiredMillicores, job.memoryRequiredMiB, job.estimatedDurationSeconds, job.priority, job.arrivalOffsetSeconds]),
  );

  await assert.rejects(
    () => service.reuse(randomUUID(), {}),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});

test("generator v1 output is pinned so stored experiment inputs cannot drift", () => {
  const goldenBatches: Array<[WorkloadPattern, number, 10 | 25 | 50 | 100, string]> = [
    [WorkloadPattern.MEDIUM, 12_345, 10, "fb6e4752aeca6a9f"],
    [WorkloadPattern.CONSTANT, 34, 50, "f9ff061e2cb09b25"],
    [WorkloadPattern.CONSTANT, 80, 50, "e19cbdc74c4a0aaf"],
    [WorkloadPattern.BURST, 7, 25, "bf8ace1bf472d0f9"],
    [WorkloadPattern.LIGHT, 99, 100, "afe87cd09af1b21a"],
  ];

  for (const [pattern, seed, count, expected] of goldenBatches) {
    assert.equal(
      specHash(generateWorkloadSpecs({ seed, count, pattern })),
      expected,
      `${pattern} seed ${seed} changed; bump the generator version instead`,
    );
  }

  const random = createMulberry32(42);
  assert.deepEqual(
    [random(), random(), random()].map((value) => value.toFixed(12)),
    ["0.601103751920", "0.448290558998", "0.852465793490"],
  );
});

test("different seeds change every pattern, including fixed-arrival patterns", () => {
  for (const pattern of predefinedPatterns) {
    const first = specHash(generateWorkloadSpecs({ seed: 34, count: 50, pattern }));
    const second = specHash(generateWorkloadSpecs({ seed: 80, count: 50, pattern }));
    assert.notEqual(first, second, `${pattern} produced identical batches for different seeds`);
  }
});

test("seeded sampling avoids short repeating cycles within a batch", () => {
  const specs = generateWorkloadSpecs({ seed: 4_242, count: 100, pattern: WorkloadPattern.MEDIUM });
  const distinct = new Set(
    specs.map((spec) =>
      [
        spec.workloadType,
        spec.cpuRequiredMillicores,
        spec.memoryRequiredMiB,
        spec.estimatedDurationSeconds,
        spec.priority,
      ].join("|"),
    ),
  );

  assert.ok(distinct.size > 40, `expected varied specs, saw ${distinct.size}`);
  assert.notDeepEqual(specs[0], specs[20]);
});

test("workload size stays coherent with duration and CPU", () => {
  for (const pattern of predefinedPatterns) {
    for (const spec of generateWorkloadSpecs({ seed: 8_080, count: 50, pattern })) {
      assert.equal(
        spec.workloadSize,
        derivedWorkloadSize(
          spec.workloadType,
          spec.estimatedDurationSeconds,
          spec.cpuRequiredMillicores,
        ),
      );
      assert.ok(spec.workloadSize >= 1 && spec.workloadSize <= 100_000_000);

      if (spec.workloadType === WorkloadType.SLEEP) {
        assert.equal(spec.workloadSize, spec.estimatedDurationSeconds);
      }
    }
  }

  const slowSort = derivedWorkloadSize(WorkloadType.SORTING, 10, 2_000);
  const fastSort = derivedWorkloadSize(WorkloadType.SORTING, 1, 2_000);
  assert.ok(slowSort > fastSort);
});

test("seeded arrival gaps stay inside documented ranges", () => {
  const ranges: Array<[WorkloadPattern, number, number]> = [
    [WorkloadPattern.LIGHT, 20, 40],
    [WorkloadPattern.MEDIUM, 8, 16],
    [WorkloadPattern.HEAVY, 2, 6],
  ];

  for (const [pattern, minimum, maximum] of ranges) {
    const offsets = generateWorkloadSpecs({ seed: 31, count: 50, pattern }).map(
      (spec) => spec.arrivalOffsetSeconds,
    );
    for (const gap of gaps(offsets)) {
      assert.ok(gap >= minimum && gap <= maximum, `${pattern} gap ${gap} outside range`);
    }
  }
});

test("custom generation is deterministic and respects every requested bound", () => {
  const custom = customWorkloadConfigSchema.parse(validCustom);
  const input: GenerateSpecsInput = {
    seed: 2_024,
    count: 10,
    pattern: WorkloadPattern.CUSTOM,
    custom,
  };
  const specs = generateWorkloadSpecs(input);

  assert.equal(specHash(specs), "deffd19ee62da7a7");
  assert.deepEqual(comparableSpecs(specs), comparableSpecs(generateWorkloadSpecs(input)));
  assert.deepEqual(
    specs.map((spec) => spec.arrivalOffsetSeconds),
    [...validCustom.arrivalOffsetsSeconds],
  );

  for (const spec of specs) {
    assert.ok(custom.workloadTypes.includes(spec.workloadType));
    assert.ok(spec.workloadSize >= validCustom.workloadSize.min);
    assert.ok(spec.workloadSize <= validCustom.workloadSize.max);
    assert.ok(spec.cpuRequiredMillicores >= validCustom.cpuRequiredMillicores.min);
    assert.ok(spec.cpuRequiredMillicores <= validCustom.cpuRequiredMillicores.max);
    assert.ok(spec.memoryRequiredMiB >= validCustom.memoryRequiredMiB.min);
    assert.ok(spec.memoryRequiredMiB <= validCustom.memoryRequiredMiB.max);
    assert.ok(spec.estimatedDurationSeconds >= validCustom.estimatedDurationSeconds.min);
    assert.ok(spec.estimatedDurationSeconds <= validCustom.estimatedDurationSeconds.max);
    assert.ok(spec.priority >= validCustom.priority.min);
    assert.ok(spec.priority <= validCustom.priority.max);
  }
});
