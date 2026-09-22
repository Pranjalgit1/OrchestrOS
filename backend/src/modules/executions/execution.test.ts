import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  WorkerStatus,
  WorkloadType,
  type Job,
  type JobExecution,
  type ResourceAllocation,
  type Worker,
} from "@prisma/client";

import { AppError } from "../../errors/app-error.js";
import {
  DockerApiError,
  DockerUnavailableError,
  demultiplexLogStream,
  negotiateApiVersion,
} from "./docker.client.js";
import {
  RUNNER_EXIT_INVALID_INPUT,
  RUNNER_EXIT_WORKLOAD_FAILED,
  WORKLOAD_IMAGE,
  buildRunnerEnvironment,
  containerNameFor,
  describeExitCode,
  deriveWorkloadSeed,
  parseRunnerResult,
} from "./execution.contract.js";
import type {
  ClaimExecutionRequest,
  ClaimOutcome,
  ExecutionFilter,
  ExecutionRepository,
  FinalizeExecutionRequest,
  FinalizeOutcome,
} from "./execution.repository.js";
import {
  executionIdParamsSchema,
  listExecutionsQuerySchema,
  startExecutionSchema,
} from "./execution.schemas.js";
import { ExecutionService } from "./execution.service.js";
import {
  buildContainerSpec,
  type ContainerExit,
  type ContainerRuntime,
  type ExecutionPlan,
  type RuntimeDescription,
  type StartedContainer,
} from "./execution.runtime.js";

const now = new Date("2026-09-22T12:00:00.000Z");

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    name: "worker-1",
    cpuCapacityMillicores: 4_000,
    memoryCapacityMiB: 4_096,
    cpuAllocatedMillicores: 1_000,
    memoryAllocatedMiB: 512,
    status: WorkerStatus.BUSY,
    lastHeartbeat: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    name: "workload-42-001",
    workloadType: WorkloadType.SORTING,
    workloadSize: 10_000,
    status: JobStatus.SCHEDULED,
    cpuRequiredMillicores: 1_000,
    memoryRequiredMiB: 512,
    estimatedDurationSeconds: 20,
    priority: 5,
    workloadBatchId: null,
    batchSequence: null,
    arrivalOffsetSeconds: 0,
    arrivalAt: now,
    schedulingPolicy: null,
    scheduledAt: now,
    timeQuantumSeconds: null,
    schedulingRounds: 1,
    placementStrategy: null,
    placedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    assignedWorkerId: randomUUID(),
    containerId: null,
    result: null,
    failureReason: null,
    ...overrides,
  };
}

function makeAllocation(overrides: Partial<ResourceAllocation> = {}): ResourceAllocation {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    workerId: randomUUID(),
    cpuMillicores: 1_000,
    memoryMiB: 512,
    status: AllocationStatus.RESERVED,
    reservedAt: now,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<JobExecution> = {}): JobExecution {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    workerId: randomUUID(),
    allocationId: randomUUID(),
    attempt: 1,
    status: ExecutionStatus.PENDING,
    containerId: null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    stdout: null,
    stderr: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExit(overrides: Partial<ContainerExit> = {}): ContainerExit {
  return {
    exitCode: 0,
    oomKilled: false,
    daemonError: "",
    startedAt: "2026-09-22T12:00:00.000Z",
    finishedAt: "2026-09-22T12:00:01.000Z",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function runnerLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runner: "v1",
    workloadType: "SORTING",
    workloadSize: 10_000,
    effectiveSize: 10_000,
    seed: 123,
    operations: 10_000,
    checksum: "0a1b2c3d",
    durationMs: 42,
    ...overrides,
  });
}

class StubRepository implements ExecutionRepository {
  readonly claims: ClaimExecutionRequest[] = [];
  readonly finalizations: FinalizeExecutionRequest[] = [];
  readonly started: Array<{ executionId: string; containerId: string }> = [];

  constructor(
    private readonly claimOutcome: ClaimOutcome,
    private readonly finalizeOutcome: FinalizeOutcome = {
      status: "EXECUTION_NOT_FOUND",
    },
    private readonly stored: JobExecution | null = null,
  ) {}

  async claim(request: ClaimExecutionRequest): Promise<ClaimOutcome> {
    this.claims.push(request);
    return this.claimOutcome;
  }

  async markStarted(executionId: string, containerId: string): Promise<JobExecution> {
    this.started.push({ executionId, containerId });
    return makeExecution({
      id: executionId,
      containerId,
      status: ExecutionStatus.RUNNING,
      startedAt: now,
    });
  }

  async finalize(request: FinalizeExecutionRequest): Promise<FinalizeOutcome> {
    this.finalizations.push(request);
    return this.finalizeOutcome;
  }

  async findById(): Promise<JobExecution | null> {
    return this.stored;
  }

  async findJobForExecution(): Promise<Job> {
    return makeJob({ status: JobStatus.COMPLETED });
  }

  async list(_filter: ExecutionFilter): Promise<JobExecution[]> {
    return [];
  }
}

class StubRuntime implements ContainerRuntime {
  readonly plans: ExecutionPlan[] = [];
  readonly removed: string[] = [];
  waitCalls = 0;

  constructor(
    private readonly options: {
      imageAvailable?: boolean;
      startError?: Error;
      running?: boolean;
      isRunningError?: Error;
      exit?: ContainerExit;
      timedOut?: boolean;
      describeError?: Error;
    } = {},
  ) {}

  async describe(): Promise<RuntimeDescription> {
    if (this.options.describeError) throw this.options.describeError;
    return {
      serverVersion: "29.7.2",
      apiVersion: "1.55",
      image: WORKLOAD_IMAGE,
      imageAvailable: this.options.imageAvailable ?? true,
      socketPath: "/var/run/docker.sock",
    };
  }

  async start(plan: ExecutionPlan): Promise<StartedContainer> {
    this.plans.push(plan);
    if (this.options.startError) throw this.options.startError;
    return {
      containerId: "a".repeat(64),
      containerName: containerNameFor(plan.executionId),
    };
  }

  async isRunning(): Promise<boolean> {
    if (this.options.isRunningError) throw this.options.isRunningError;
    return this.options.running ?? false;
  }

  async waitForExit(): Promise<{ timedOut: boolean }> {
    this.waitCalls += 1;
    return { timedOut: this.options.timedOut ?? false };
  }

  async collect(): Promise<ContainerExit> {
    return this.options.exit ?? makeExit();
  }

  async remove(containerId: string): Promise<void> {
    this.removed.push(containerId);
  }
}

test("docker api version negotiation stays inside both supported ranges", () => {
  assert.equal(negotiateApiVersion("1.55", "1.40"), "1.44", "never newer than the adapter");
  assert.equal(negotiateApiVersion("1.41", "1.24"), "1.41", "never newer than the daemon");
  assert.equal(negotiateApiVersion("1.44", "1.44"), "1.44");
  assert.throws(
    () => negotiateApiVersion("1.60", "1.50"),
    (error: unknown) => error instanceof DockerUnavailableError,
    "a daemon that dropped old versions must fail loudly",
  );
});

test("multiplexed container output is split into stdout and stderr", () => {
  function frame(streamType: number, text: string): Buffer {
    const payload = Buffer.from(text, "utf8");
    const header = Buffer.alloc(8);
    header[0] = streamType;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  const stream = Buffer.concat([
    frame(1, '{"runner":"v1"}\n'),
    frame(2, "warning: slow\n"),
    frame(1, "tail\n"),
  ]);

  const logs = demultiplexLogStream(stream, 1_024);
  assert.equal(logs.stdout, '{"runner":"v1"}\ntail\n');
  assert.equal(logs.stderr, "warning: slow\n");
  assert.equal(logs.stdoutTruncated, false);
  assert.equal(logs.stderrTruncated, false);

  const capped = demultiplexLogStream(stream, 4);
  assert.equal(capped.stdout.length, 4, "output is capped at the configured limit");
  assert.equal(capped.stdoutTruncated, true);
  assert.equal(capped.stderrTruncated, true);

  assert.deepEqual(
    demultiplexLogStream(Buffer.alloc(0), 1_024),
    { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
    "an empty stream is not an error",
  );
});

test("the workload seed is derived deterministically from the job name", () => {
  const first = deriveWorkloadSeed("workload-550001-003");
  assert.equal(first, deriveWorkloadSeed("workload-550001-003"), "same name, same seed");
  assert.notEqual(first, deriveWorkloadSeed("workload-550001-004"));
  assert.ok(Number.isInteger(first) && first >= 0 && first <= 4_294_967_295);
});

test("runner output is only trusted when it matches the contract exactly", () => {
  const valid = parseRunnerResult(`noise\n${runnerLine()}\n`);
  assert.ok(valid, "a well-formed result line is accepted even with surrounding noise");
  assert.equal(valid?.checksum, "0a1b2c3d");

  assert.equal(parseRunnerResult(""), null);
  assert.equal(parseRunnerResult("not json"), null);
  assert.equal(parseRunnerResult(runnerLine({ runner: "v2" })), null, "version must match");
  assert.equal(parseRunnerResult(runnerLine({ checksum: "zz" })), null, "checksum shape is fixed");
  assert.equal(
    parseRunnerResult(runnerLine({ workloadType: "CRYPTO_MINING" })),
    null,
    "only known workload types are accepted",
  );
  assert.equal(
    parseRunnerResult(JSON.stringify({ ...JSON.parse(runnerLine()), extra: 1 })),
    null,
    "unexpected fields are rejected",
  );
});

test("the container specification is locked down and matches the reservation", () => {
  const plan: ExecutionPlan = {
    executionId: randomUUID(),
    jobId: randomUUID(),
    jobName: "workload-42-001",
    workerId: randomUUID(),
    allocationId: randomUUID(),
    workloadType: WorkloadType.CPU_INTENSIVE,
    workloadSize: 5_000,
    cpuMillicores: 1_500,
    memoryMiB: 768,
    seed: 99,
  };

  const spec = buildContainerSpec(plan);

  assert.equal(spec.Image, WORKLOAD_IMAGE, "only the controlled image is ever used");
  assert.deepEqual(spec.Env, [
    "ORCHESTROS_WORKLOAD_TYPE=CPU_INTENSIVE",
    "ORCHESTROS_WORKLOAD_SIZE=5000",
    "ORCHESTROS_SEED=99",
    "ORCHESTROS_MEMORY_LIMIT_MIB=768",
  ]);
  assert.equal(spec.HostConfig.Memory, 768 * 1024 * 1024, "memory limit equals the reservation");
  assert.equal(spec.HostConfig.MemorySwap, spec.HostConfig.Memory, "swap cannot exceed memory");
  assert.equal(spec.HostConfig.NanoCpus, 1_500_000_000, "1500 millicores is 1.5 CPUs");
  assert.equal(spec.HostConfig.NetworkMode, "none");
  assert.equal(spec.NetworkDisabled, true);
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.equal(spec.HostConfig.Privileged, false);
  assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges"]);
  assert.deepEqual(spec.HostConfig.Binds, [], "no host path is ever mounted into a workload");
  assert.equal(spec.HostConfig.RestartPolicy.Name, "no");
  assert.ok(spec.HostConfig.PidsLimit > 0);
  assert.equal(spec.Labels["orchestros.job.id"], plan.jobId);
  assert.equal(
    Object.keys(spec).includes("Cmd"),
    false,
    "the image entrypoint is never overridden",
  );

  assert.deepEqual(
    buildRunnerEnvironment({
      workloadType: WorkloadType.SLEEP,
      workloadSize: 3,
      seed: 1,
      memoryMiB: 64,
    }).map((entry) => entry.split("=")[0]),
    [
      "ORCHESTROS_WORKLOAD_TYPE",
      "ORCHESTROS_WORKLOAD_SIZE",
      "ORCHESTROS_SEED",
      "ORCHESTROS_MEMORY_LIMIT_MIB",
    ],
    "the container receives exactly four controlled variables",
  );
});

test("exit codes are translated into specific causes", () => {
  assert.match(describeExitCode(137, true), /memory/);
  assert.match(describeExitCode(0, true), /memory/, "an OOM kill is reported even with code 0");
  assert.match(describeExitCode(RUNNER_EXIT_INVALID_INPUT, false), /refused its inputs/);
  assert.match(describeExitCode(RUNNER_EXIT_WORKLOAD_FAILED, false), /failed while running/);
  assert.match(describeExitCode(3, false), /exited with code 3/);
});

test("container outcomes are classified into recorded execution results", () => {
  const completed = ExecutionService.classify(
    makeExit({ stdout: `${runnerLine()}\n` }),
    false,
    300,
    1,
  );
  assert.equal(completed.executionStatus, ExecutionStatus.COMPLETED);
  assert.equal(completed.failureReason, null);
  assert.equal(
    (completed.result as { checksum?: string } | null)?.checksum,
    "0a1b2c3d",
    "the runner checksum is preserved for reproducibility",
  );

  const timedOut = ExecutionService.classify(makeExit(), true, 120, 1);
  assert.equal(
    timedOut.executionStatus,
    ExecutionStatus.INTERRUPTED,
    "a timeout is an orchestrator interruption, not a workload failure",
  );
  assert.match(timedOut.failureReason ?? "", /120s limit/);
  assert.equal(timedOut.result, null);

  const failed = ExecutionService.classify(makeExit({ exitCode: 70 }), false, 300, 2);
  assert.equal(failed.executionStatus, ExecutionStatus.FAILED);
  assert.match(failed.failureReason ?? "", /failed while running/);

  const oom = ExecutionService.classify(
    makeExit({ exitCode: 137, oomKilled: true, daemonError: "" }),
    false,
    300,
    1,
  );
  assert.equal(oom.executionStatus, ExecutionStatus.FAILED);
  assert.match(oom.failureReason ?? "", /memory/);

  const silent = ExecutionService.classify(makeExit({ stdout: "hello\n" }), false, 300, 1);
  assert.equal(
    silent.executionStatus,
    ExecutionStatus.FAILED,
    "a zero exit without a valid result line is not a success",
  );
  assert.match(silent.failureReason ?? "", /no valid result line/);
});

test("starting an execution claims the job and launches one controlled container", async () => {
  const worker = makeWorker();
  const job = makeJob({ assignedWorkerId: worker.id, status: JobStatus.RUNNING });
  const allocation = makeAllocation({
    jobId: job.id,
    workerId: worker.id,
    cpuMillicores: 1_250,
    memoryMiB: 640,
  });
  const execution = makeExecution({
    jobId: job.id,
    workerId: worker.id,
    allocationId: allocation.id,
  });
  const repository = new StubRepository(
    { status: "CLAIMED", claimed: { execution, job, allocation } },
    {
      status: "FINALIZED",
      execution: makeExecution({ id: execution.id, status: ExecutionStatus.COMPLETED }),
      job: makeJob({ id: job.id, status: JobStatus.COMPLETED }),
      worker: makeWorker({ cpuAllocatedMillicores: 0, memoryAllocatedMiB: 0, status: WorkerStatus.IDLE }),
      released: true,
    },
  );
  const runtime = new StubRuntime({ exit: makeExit({ stdout: `${runnerLine()}\n` }) });
  const service = new ExecutionService(repository, runtime, 300);

  const result = await service.start(job.id);
  await service.awaitPendingSettlements();

  assert.deepEqual(repository.claims, [{ jobId: job.id }]);
  assert.equal(result.container.image, WORKLOAD_IMAGE);
  assert.equal(result.container.cpuMillicores, 1_250, "the container gets the reserved CPU");
  assert.equal(result.container.memoryMiB, 640, "the container gets the reserved memory");
  assert.equal(result.container.seed, deriveWorkloadSeed(job.name));
  assert.equal(result.execution.status, ExecutionStatus.RUNNING);
  assert.equal(result.timeoutSeconds, 300);
  assert.equal(repository.started.length, 1);
  assert.equal(runtime.plans.length, 1, "exactly one container is created");
  assert.equal(runtime.plans[0]?.workloadSize, job.workloadSize);

  // The background settlement is the normal completion path.
  assert.equal(runtime.waitCalls, 1, "the container exit is awaited without being polled");
  assert.equal(repository.finalizations.length, 1);
  assert.equal(repository.finalizations[0]?.executionStatus, ExecutionStatus.COMPLETED);
  assert.equal(repository.finalizations[0]?.exitCode, 0);
  assert.deepEqual(runtime.removed, ["a".repeat(64)], "the container is cleaned up afterwards");
});

test("execution is refused unless the job is scheduled, placed, and reserved", async () => {
  const runtime = new StubRuntime();

  const missing = new ExecutionService(new StubRepository({ status: "JOB_NOT_FOUND" }), runtime);
  await assert.rejects(
    () => missing.start(randomUUID()),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );

  const queued = new ExecutionService(
    new StubRepository({ status: "JOB_NOT_RUNNABLE", jobStatus: JobStatus.QUEUED }),
    runtime,
  );
  await assert.rejects(
    () => queued.start(randomUUID()),
    (error: unknown) => error instanceof AppError && error.code === "JOB_NOT_EXECUTABLE",
  );

  const unreserved = new ExecutionService(
    new StubRepository({ status: "NO_RESERVATION" }),
    runtime,
  );
  await assert.rejects(
    () => unreserved.start(randomUUID()),
    (error: unknown) => error instanceof AppError && error.code === "NO_ACTIVE_ALLOCATION",
  );

  const raced = new ExecutionService(
    new StubRepository({ status: "EXECUTION_ALREADY_CLAIMED" }),
    runtime,
  );
  await assert.rejects(
    () => raced.start(randomUUID()),
    (error: unknown) => error instanceof AppError && error.code === "EXECUTION_ALREADY_STARTED",
  );

  assert.equal(runtime.plans.length, 0, "a refused job never reaches the Docker daemon");
});

test("a missing workload image is reported before anything is claimed", async () => {
  const repository = new StubRepository({ status: "JOB_NOT_FOUND" });
  const service = new ExecutionService(
    repository,
    new StubRuntime({ imageAvailable: false }),
    300,
  );

  await assert.rejects(
    () => service.start(randomUUID()),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 503 &&
      error.code === "WORKLOAD_IMAGE_MISSING",
  );
  assert.equal(repository.claims.length, 0, "no job is claimed when the image is absent");
});

test("an unreachable docker daemon is surfaced as a dependency failure", async () => {
  const service = new ExecutionService(
    new StubRepository({ status: "JOB_NOT_FOUND" }),
    new StubRuntime({ describeError: new DockerUnavailableError("socket missing") }),
    300,
  );

  await assert.rejects(
    () => service.start(randomUUID()),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 503 &&
      error.code === "DOCKER_UNAVAILABLE",
  );
});

test("a container that cannot start is recorded as failed so capacity is not stranded", async () => {
  const worker = makeWorker();
  const job = makeJob({ assignedWorkerId: worker.id });
  const allocation = makeAllocation({ jobId: job.id, workerId: worker.id });
  const execution = makeExecution({ jobId: job.id, workerId: worker.id });
  const repository = new StubRepository(
    { status: "CLAIMED", claimed: { execution, job, allocation } },
    {
      status: "FINALIZED",
      execution: makeExecution({ id: execution.id, status: ExecutionStatus.FAILED }),
      job: makeJob({ id: job.id, status: JobStatus.FAILED }),
      worker: makeWorker({ cpuAllocatedMillicores: 0, status: WorkerStatus.IDLE }),
      released: true,
    },
  );
  const service = new ExecutionService(
    repository,
    new StubRuntime({ startError: new Error("no such image") }),
    300,
  );

  await assert.rejects(() => service.start(job.id), /no such image/);

  assert.equal(repository.finalizations.length, 1, "the failed start is finalized");
  assert.equal(repository.finalizations[0]?.executionStatus, ExecutionStatus.FAILED);
  assert.match(repository.finalizations[0]?.failureReason ?? "", /could not be started/);
  assert.equal(repository.started.length, 0);
});

test("settling refuses while the container is still running", async () => {
  const execution = makeExecution({
    status: ExecutionStatus.RUNNING,
    containerId: "b".repeat(64),
    startedAt: now,
  });
  const service = new ExecutionService(
    new StubRepository({ status: "JOB_NOT_FOUND" }, { status: "EXECUTION_NOT_FOUND" }, execution),
    new StubRuntime({ running: true }),
    300,
  );

  await assert.rejects(
    () => service.settle(execution.id),
    (error: unknown) => error instanceof AppError && error.code === "EXECUTION_STILL_RUNNING",
  );
});

test("settling an already recorded execution changes nothing", async () => {
  const execution = makeExecution({
    status: ExecutionStatus.COMPLETED,
    containerId: "c".repeat(64),
    startedAt: now,
    completedAt: now,
  });
  const repository = new StubRepository(
    { status: "JOB_NOT_FOUND" },
    {
      status: "ALREADY_FINALIZED",
      execution,
      job: makeJob({ status: JobStatus.COMPLETED }),
    },
    execution,
  );
  const service = new ExecutionService(repository, new StubRuntime(), 300);

  const settled = await service.settle(execution.id);

  assert.equal(settled.alreadySettled, true);
  assert.equal(settled.released, false, "a second settle must not release capacity again");
});

test("an open execution whose container vanished is settled as an honest failure", async () => {
  const execution = makeExecution({
    status: ExecutionStatus.RUNNING,
    containerId: "f".repeat(64),
    startedAt: now,
  });
  const repository = new StubRepository(
    { status: "JOB_NOT_FOUND" },
    {
      status: "FINALIZED",
      execution: makeExecution({ id: execution.id, status: ExecutionStatus.FAILED }),
      job: makeJob({ status: JobStatus.FAILED }),
      worker: makeWorker({ cpuAllocatedMillicores: 0, status: WorkerStatus.IDLE }),
      released: true,
    },
    execution,
  );
  const service = new ExecutionService(
    repository,
    new StubRuntime({ isRunningError: new DockerApiError("No such container", 404) }),
    300,
  );

  const settled = await service.settle(execution.id);

  assert.equal(settled.alreadySettled, false);
  assert.equal(settled.released, true, "a lost container must not strand its reservation");
  assert.equal(repository.finalizations[0]?.executionStatus, ExecutionStatus.FAILED);
  assert.match(repository.finalizations[0]?.failureReason ?? "", /no longer present/);
  assert.equal(
    repository.finalizations[0]?.exitCode,
    null,
    "an unrecoverable outcome is recorded as unknown rather than invented",
  );
});

test("an execution that never reached a container is settled as failed", async () => {
  const execution = makeExecution({ status: ExecutionStatus.PENDING, containerId: null });
  const repository = new StubRepository(
    { status: "JOB_NOT_FOUND" },
    {
      status: "FINALIZED",
      execution: makeExecution({ id: execution.id, status: ExecutionStatus.FAILED }),
      job: makeJob({ status: JobStatus.FAILED }),
      worker: null,
      released: true,
    },
    execution,
  );
  const service = new ExecutionService(repository, new StubRuntime(), 300);

  const settled = await service.settle(execution.id);

  assert.equal(settled.alreadySettled, false);
  assert.equal(repository.finalizations[0]?.executionStatus, ExecutionStatus.FAILED);
  assert.match(repository.finalizations[0]?.failureReason ?? "", /never reached a container/);
});

test("execution request input is strictly validated", () => {
  const id = randomUUID();

  assert.equal(startExecutionSchema.safeParse({ jobId: id }).success, true);
  assert.equal(startExecutionSchema.safeParse({}).success, false);
  assert.equal(
    startExecutionSchema.safeParse({ jobId: id, image: "alpine" }).success,
    false,
    "clients cannot choose an image",
  );
  assert.equal(
    startExecutionSchema.safeParse({ jobId: id, command: "sh -c whoami" }).success,
    false,
    "clients cannot supply a command",
  );
  assert.equal(
    startExecutionSchema.safeParse({ jobId: id, env: { PATH: "/" } }).success,
    false,
    "clients cannot inject environment variables",
  );
  assert.equal(
    startExecutionSchema.safeParse({ jobId: id, timeoutSeconds: 99_999 }).success,
    false,
    "clients cannot extend the timeout",
  );

  assert.equal(executionIdParamsSchema.safeParse({ executionId: id }).success, true);
  assert.equal(executionIdParamsSchema.safeParse({ executionId: "nope" }).success, false);

  assert.equal(listExecutionsQuerySchema.safeParse({}).data?.limit, 50);
  assert.equal(
    listExecutionsQuerySchema.safeParse({ status: "RUNNING", limit: "10" }).success,
    true,
  );
  assert.equal(listExecutionsQuerySchema.safeParse({ status: "RESERVED" }).success, false);
  assert.equal(listExecutionsQuerySchema.safeParse({ limit: "0" }).success, false);
});

test("container names are derived from the execution, so a retry cannot collide", () => {
  const first = randomUUID();
  const second = randomUUID();
  assert.notEqual(containerNameFor(first), containerNameFor(second));
  assert.match(containerNameFor(first), /^orchestros-exec-/);
});
