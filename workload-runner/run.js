"use strict";

/**
 * OrchestrOS controlled workload runner.
 *
 * This program is the ONLY thing a workload container ever executes. It accepts
 * no command, no script, and no formula. The workload is selected by name from a
 * fixed set and sized by a single integer, both supplied as environment
 * variables and validated before any work starts.
 *
 * Contract:
 *   stdin   unused
 *   stdout  exactly one JSON line describing the completed run
 *   stderr  a single diagnostic line when the run is refused or fails
 *   exit 0  the workload completed
 *   exit 64 the inputs were invalid (nothing was executed)
 *   exit 70 the workload failed while running
 */

const RUNNER_VERSION = "v1";

const WORKLOAD_TYPES = [
  "CPU_INTENSIVE",
  "MATRIX_MULTIPLICATION",
  "SORTING",
  "DATA_PROCESSING",
  "SLEEP",
];

const MIN_WORKLOAD_SIZE = 1;
const MAX_WORKLOAD_SIZE = 100000000;
const MAX_SEED = 4294967295;

/**
 * Per-type ceilings on the work actually performed. A nominal workload size is
 * an experiment input, not a promise about runtime, so the runner refuses to let
 * one container run unbounded. The applied ceiling is reported as
 * `effectiveSize` so recorded results never overstate what ran.
 */
const WORK_CEILINGS = {
  CPU_INTENSIVE: 50000000,
  MATRIX_MULTIPLICATION: 320,
  SORTING: 2000000,
  DATA_PROCESSING: 2000000,
  SLEEP: 120,
};

/** Approximate resident cost of the Node runtime itself, in MiB. */
const RUNTIME_OVERHEAD_MIB = 48;

/** Share of the remaining container memory the runner is willing to allocate. */
const ALLOCATION_SHARE = 0.6;

/** Budget used when the container has no memory limit. */
const UNBOUNDED_BUDGET_BYTES = 256 * 1024 * 1024;

function fail(exitCode, message) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function readInteger(name, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    fail(64, `${name} is required`);
  }
  if (!/^\d+$/.test(raw.trim())) {
    fail(64, `${name} must be a non-negative integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(64, `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function readWorkloadType() {
  const raw = process.env.ORCHESTROS_WORKLOAD_TYPE;
  if (!raw || !WORKLOAD_TYPES.includes(raw)) {
    fail(
      64,
      `ORCHESTROS_WORKLOAD_TYPE must be one of ${WORKLOAD_TYPES.join(", ")}`,
    );
  }
  return raw;
}

/** Same Mulberry32 the backend generator uses, so runs reproduce exactly. */
function createMulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Bytes the runner may allocate. Derived from the container memory limit so a
 * workload sizes itself to its reservation instead of being OOM-killed.
 */
function allocationBudgetBytes(memoryLimitMiB) {
  if (memoryLimitMiB <= 0) {
    return UNBOUNDED_BUDGET_BYTES;
  }
  const usableMiB = Math.max(2, Math.floor((memoryLimitMiB - RUNTIME_OVERHEAD_MIB) * ALLOCATION_SHARE));
  return usableMiB * 1024 * 1024;
}

function resolveEffectiveSize(workloadType, requestedSize, budgetBytes) {
  const ceiling = WORK_CEILINGS[workloadType];

  switch (workloadType) {
    case "SORTING":
      return Math.max(1, Math.min(requestedSize, ceiling, Math.floor(budgetBytes / 8)));
    case "DATA_PROCESSING":
      // One Float64 value plus one Uint8 group label per record.
      return Math.max(1, Math.min(requestedSize, ceiling, Math.floor(budgetBytes / 9)));
    case "MATRIX_MULTIPLICATION": {
      // Two operands and one product, each dimension^2 Float64 values.
      const byBudget = Math.floor(Math.sqrt(budgetBytes / 24));
      return Math.max(2, Math.min(requestedSize, ceiling, byBudget));
    }
    default:
      return Math.max(1, Math.min(requestedSize, ceiling));
  }
}

function runCpuIntensive(iterations, seed) {
  let accumulator = seed >>> 0;
  for (let index = 0; index < iterations; index += 1) {
    accumulator = (Math.imul(accumulator ^ index, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
    accumulator = (accumulator ^ (accumulator >>> 13)) >>> 0;
  }
  return {
    operations: iterations,
    signature: `cpu:${iterations}:${accumulator}`,
  };
}

function runMatrixMultiplication(dimension, seed) {
  const random = createMulberry32(seed);
  const cells = dimension * dimension;
  const left = new Float64Array(cells);
  const right = new Float64Array(cells);

  for (let index = 0; index < cells; index += 1) {
    left[index] = random();
    right[index] = random();
  }

  const product = new Float64Array(cells);
  for (let row = 0; row < dimension; row += 1) {
    const rowOffset = row * dimension;
    for (let inner = 0; inner < dimension; inner += 1) {
      const leftValue = left[rowOffset + inner];
      if (leftValue === 0) continue;
      const innerOffset = inner * dimension;
      for (let column = 0; column < dimension; column += 1) {
        product[rowOffset + column] += leftValue * right[innerOffset + column];
      }
    }
  }

  let trace = 0;
  let total = 0;
  for (let index = 0; index < cells; index += 1) {
    total += product[index];
  }
  for (let index = 0; index < dimension; index += 1) {
    trace += product[index * dimension + index];
  }

  return {
    operations: dimension * dimension * dimension,
    signature: `matrix:${dimension}:${total.toFixed(6)}:${trace.toFixed(6)}`,
  };
}

function runSorting(elements, seed) {
  const random = createMulberry32(seed);
  const values = new Float64Array(elements);
  for (let index = 0; index < elements; index += 1) {
    values[index] = random();
  }

  values.sort();

  for (let index = 1; index < elements; index += 1) {
    if (values[index - 1] > values[index]) {
      throw new Error("sort produced an unordered result");
    }
  }

  let total = 0;
  for (let index = 0; index < elements; index += 1) {
    total += values[index];
  }

  return {
    operations: elements,
    signature:
      `sort:${elements}:${values[0].toFixed(9)}:` +
      `${values[elements - 1].toFixed(9)}:${total.toFixed(6)}`,
  };
}

function runDataProcessing(records, seed) {
  const random = createMulberry32(seed);
  const groupCount = 64;
  const values = new Float64Array(records);
  const groups = new Uint8Array(records);

  for (let index = 0; index < records; index += 1) {
    values[index] = random() * 1000;
    groups[index] = index % groupCount;
  }

  const sums = new Float64Array(groupCount);
  const counts = new Float64Array(groupCount);
  const minimums = new Float64Array(groupCount).fill(Number.POSITIVE_INFINITY);
  const maximums = new Float64Array(groupCount).fill(Number.NEGATIVE_INFINITY);

  for (let index = 0; index < records; index += 1) {
    const group = groups[index];
    const value = values[index];
    sums[group] += value;
    counts[group] += 1;
    if (value < minimums[group]) minimums[group] = value;
    if (value > maximums[group]) maximums[group] = value;
  }

  const parts = [];
  for (let group = 0; group < groupCount; group += 1) {
    if (counts[group] === 0) continue;
    const mean = sums[group] / counts[group];
    parts.push(
      `${group}|${counts[group]}|${mean.toFixed(6)}|` +
        `${minimums[group].toFixed(6)}|${maximums[group].toFixed(6)}`,
    );
  }

  return {
    operations: records,
    signature: `data:${records}:${parts.join(";")}`,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runSleep(seconds, seed) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    await sleep(1000);
  }
  return {
    operations: seconds,
    signature: `sleep:${seconds}:${seed}`,
  };
}

async function runWorkload(workloadType, effectiveSize, seed) {
  switch (workloadType) {
    case "CPU_INTENSIVE":
      return runCpuIntensive(effectiveSize, seed);
    case "MATRIX_MULTIPLICATION":
      return runMatrixMultiplication(effectiveSize, seed);
    case "SORTING":
      return runSorting(effectiveSize, seed);
    case "DATA_PROCESSING":
      return runDataProcessing(effectiveSize, seed);
    case "SLEEP":
      return runSleep(effectiveSize, seed);
    default:
      throw new Error(`unsupported workload type ${workloadType}`);
  }
}

async function main() {
  const workloadType = readWorkloadType();
  const workloadSize = readInteger("ORCHESTROS_WORKLOAD_SIZE", MIN_WORKLOAD_SIZE, MAX_WORKLOAD_SIZE);
  const seed = readInteger("ORCHESTROS_SEED", 0, MAX_SEED);
  const memoryLimitMiB = process.env.ORCHESTROS_MEMORY_LIMIT_MIB
    ? readInteger("ORCHESTROS_MEMORY_LIMIT_MIB", 0, 131072)
    : 0;

  const budgetBytes = allocationBudgetBytes(memoryLimitMiB);
  const effectiveSize = resolveEffectiveSize(workloadType, workloadSize, budgetBytes);

  const startedAt = process.hrtime.bigint();
  const outcome = await runWorkload(workloadType, effectiveSize, seed);
  const durationMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);

  // durationMs is measured, so it is deliberately excluded from the checksum:
  // the same inputs must always produce the same checksum.
  process.stdout.write(
    `${JSON.stringify({
      runner: RUNNER_VERSION,
      workloadType,
      workloadSize,
      effectiveSize,
      seed,
      operations: outcome.operations,
      checksum: fnv1a32(`${RUNNER_VERSION}:${outcome.signature}`),
      durationMs,
    })}\n`,
  );
}

main().catch((error) => {
  fail(70, `workload failed: ${error instanceof Error ? error.message : String(error)}`);
});
