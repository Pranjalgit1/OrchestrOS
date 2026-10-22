import { BenchmarkStatus, SchedulingPolicy } from "@prisma/client";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors/app-error.js";
import { autoscalerService } from "../autoscaler/autoscaler.service.js";
import { executionService } from "../executions/execution.service.js";
import { orchestratorService } from "../orchestrator/orchestrator.service.js";
import { workloadService } from "../workloads/workload.service.js";
import { comparePolicies, measureBatch } from "./benchmark.metrics.js";
import { prismaBenchmarkRepository } from "./benchmark.repository.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Codes from the orchestrator that mean "wait and ask again", not failure. */
const WAIT_CODES = new Set([
  "NOTHING_ELIGIBLE",
  "INSUFFICIENT_RESOURCES",
  // Both leave the job SCHEDULED; the next tick places it again.
  "PLACEMENT_CONFLICT",
  "WORKER_NOT_SCHEDULABLE",
]);

export const DEFAULT_TICK_MS = 1_000;
/** One run that never drains is a stuck run, not a slow one. */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

/**
 * Multi-policy benchmark runner.
 *
 * Runs the same seeded workload once per scheduling policy, through the real
 * pipeline (scheduler, placement, row-locked reservation, Docker execution),
 * one policy at a time. The first run generates the batch; every later run
 * reuses it, so job names, resources, seeds, and therefore result checksums are
 * identical across policies. Only arrival times are rebased to each run's start.
 *
 * The scheduler is global by design, so a run is only meaningful on a quiet
 * cluster. The suite refuses to start unless nothing else is unfinished, and
 * while it runs, other pipeline-changing requests are refused by the route
 * guard. Autoscaling is switched off for the duration and restored afterwards,
 * because added or retired workers would change capacity between runs.
 *
 * One suite runs at a time, in this process. A restart abandons it, and
 * `abandonInterruptedSuites` records that at the next boot.
 */
export class BenchmarkService {
  repository;
  workloads;
  orchestrator;
  executions;
  autoscaler;
  clock;
  wait;
  tickMs;
  runTimeoutMs;
  active = null;

  constructor(
    repository = prismaBenchmarkRepository,
    {
      workloads = workloadService,
      orchestrator = orchestratorService,
      executions = executionService,
      autoscaler = autoscalerService,
      clock = () => new Date(),
      wait = sleep,
      tickMs = DEFAULT_TICK_MS,
      runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    } = {},
  ) {
    this.repository = repository;
    this.workloads = workloads;
    this.orchestrator = orchestrator;
    this.executions = executions;
    this.autoscaler = autoscaler;
    this.clock = clock;
    this.wait = wait;
    this.tickMs = tickMs;
    this.runTimeoutMs = runTimeoutMs;
  }

  get isRunning() {
    return this.active !== null;
  }

  /** Checks the preconditions, records the suite, and starts it in the background. */
  async start(input) {
    if (this.active) {
      throw new ConflictError("A benchmark is already running", "BENCHMARK_RUNNING");
    }
    // Reserve the slot before any await, so two requests cannot both pass.
    this.active = { suiteId: null, abortRequested: false, progress: null, done: null };
    try {
      const unfinished = await this.repository.countUnfinishedJobs();
      if (unfinished > 0) {
        throw new ConflictError(
          `${unfinished} job(s) are still unfinished. A benchmark needs an idle cluster, ` +
            "because the scheduler considers every queued job. Let them finish or stop them first.",
          "CLUSTER_NOT_IDLE",
        );
      }
      const runtime = await this.executions.describeRuntime();
      if (!runtime.imageAvailable) {
        throw new ServiceUnavailableError(
          `Workload image ${runtime.image} is not built. Run \`npm run docker:images\` first.`,
          "WORKLOAD_IMAGE_MISSING",
        );
      }
      const suite = await this.repository.createSuite({
        placementStrategy: input.strategy,
        pattern: input.pattern,
        seed: input.seed,
        jobCount: input.count,
        workloadTypes: input.workloadTypes,
        timeQuantumSeconds: input.timeQuantumSeconds,
        jobsPerTick: input.jobsPerTick,
        startedAt: this.clock(),
      }, input.policies);
      this.active.suiteId = suite.id;
      this.active.done = this.runSuite(suite, input).finally(() => {
        this.active = null;
      });
      return this.present(suite);
    } catch (error) {
      if (!this.active?.suiteId) this.active = null;
      throw error;
    }
  }

  /** Asks the running suite to stop; the runner cancels its work and records it. */
  abort(suiteId) {
    if (!this.active || this.active.suiteId !== suiteId) {
      throw new ConflictError("That benchmark is not running", "BENCHMARK_NOT_RUNNING");
    }
    this.active.abortRequested = true;
    return { suiteId, abortRequested: true };
  }

  async get(suiteId) {
    const suite = await this.repository.findSuite(suiteId);
    if (!suite) throw new NotFoundError("Benchmark");
    return this.present(suite);
  }

  async list(limit) {
    const suites = await this.repository.listSuites(limit);
    return {
      activeSuiteId: this.active?.suiteId ?? null,
      suites: suites.map((suite) => this.present(suite)),
    };
  }

  /** Resolves once the running suite (if any) has finished. Used by tests and shutdown. */
  async awaitCompletion() {
    await this.active?.done;
  }

  present(suite) {
    const live = this.active?.suiteId === suite.id ? this.active : null;
    return {
      ...suite,
      progress: live?.progress ?? null,
      abortRequested: live?.abortRequested ?? false,
      comparison: comparePolicies(suite.runs ?? []),
    };
  }

  async runSuite(suite, input) {
    let sourceBatchId = null;
    let outcome = { status: BenchmarkStatus.COMPLETED, reason: null };
    try {
      // Frozen, not switched off: a disabled autoscaler still retires idle
      // workers, which would change capacity between runs.
      this.autoscaler.pause("a policy benchmark needs fixed capacity");

      for (const run of suite.runs) {
        if (this.active.abortRequested) {
          outcome = { status: BenchmarkStatus.ABORTED, reason: "Stopped by the operator" };
          break;
        }
        const batch = sourceBatchId
          ? await this.workloads.reuse(sourceBatchId, {})
          : await this.workloads.generate({
              seed: input.seed,
              count: input.count,
              pattern: input.pattern,
              workloadTypes: input.workloadTypes,
            });
        sourceBatchId ??= batch.id;

        const result = await this.runPolicy(run, batch, input);
        if (result.status !== BenchmarkStatus.COMPLETED) {
          outcome = result;
          break;
        }
      }
    } catch (error) {
      outcome = {
        status: BenchmarkStatus.FAILED,
        reason: error instanceof Error ? error.message : String(error),
      };
      // Do not leave half a run queued behind a failed suite.
      await this.stopEverything();
    } finally {
      this.autoscaler.resume();
      try {
        await this.repository.finishSuite(suite.id, outcome.status, outcome.reason);
      } catch (error) {
        console.error(`Benchmark ${suite.id} could not be recorded as finished:`, error.message);
      }
    }
  }

  /** Drives one policy's batch until every job in it has finished. */
  async runPolicy(run, batch, input) {
    const capacity = await this.repository.readCapacity();
    await this.repository.startRun(run.id, {
      workloadBatchId: batch.id,
      capacity,
      jobCount: batch.jobs?.length ?? batch.jobCount,
    });
    const startedAt = this.clock().getTime();
    // Spread-out patterns cannot finish before their last arrival, so the
    // allowance starts counting from there.
    const lastArrivalMs = Math.max(0, ...(batch.jobs ?? []).map((job) => job.arrivalOffsetSeconds ?? 0)) * 1_000;
    const deadline = startedAt + lastArrivalMs + this.runTimeoutMs;
    const request = {
      policy: run.policy,
      strategy: input.strategy,
      maxJobs: input.jobsPerTick,
      ...(run.policy === SchedulingPolicy.ROUND_ROBIN
        ? { timeQuantumSeconds: input.timeQuantumSeconds }
        : {}),
    };

    for (;;) {
      const progress = await this.repository.batchProgress(batch.id);
      this.active.progress = {
        runId: run.id,
        policy: run.policy,
        position: run.position,
        totalRuns: input.policies.length,
        finishedJobs: progress.finished,
        totalJobs: progress.total,
      };
      if (progress.total > 0 && progress.unfinished === 0) break;

      if (this.active.abortRequested) {
        await this.stopEverything();
        return this.closeRun(run, batch, BenchmarkStatus.ABORTED, "Stopped by the operator");
      }
      if (this.clock().getTime() > deadline) {
        await this.stopEverything();
        return this.closeRun(run, batch, BenchmarkStatus.FAILED,
          `The ${run.policy} run did not finish within ${Math.round(this.runTimeoutMs / 60_000)} minutes ` +
            "of its last arrival");
      }

      try {
        const result = await this.orchestrator.run(request);
        if (result.stoppedBecause && !WAIT_CODES.has(result.stoppedBecause)) {
          // A rejected start (for example a missing image) will not fix itself.
          const failed = result.steps.flatMap((step) => step.stages)
            .find((stage) => stage.status === "FAILED");
          if (result.stoppedBecause === "WORKLOADS_STOPPING") {
            return this.closeRun(run, batch, BenchmarkStatus.ABORTED, "Workloads were stopped");
          }
          await this.stopEverything();
          return this.closeRun(run, batch, BenchmarkStatus.FAILED,
            failed?.detail ?? `The orchestrator stopped with ${result.stoppedBecause}`);
        }
      } catch (error) {
        if (error?.code === "WORKLOADS_STOPPING") {
          return this.closeRun(run, batch, BenchmarkStatus.ABORTED, "Workloads were stopped");
        }
        throw error;
      }
      await this.wait(this.tickMs);
    }

    // The batch has drained; settlement already released every reservation.
    const jobs = await this.repository.readBatchJobs(batch.id);
    const metrics = measureBatch(jobs);
    if (metrics.cancelledJobs > 0) {
      await this.repository.finishRun(run.id, BenchmarkStatus.ABORTED, metrics,
        "Some jobs were cancelled during the run");
      return { status: BenchmarkStatus.ABORTED, reason: "Jobs were cancelled during the run" };
    }
    await this.repository.finishRun(run.id, BenchmarkStatus.COMPLETED, metrics);
    return { status: BenchmarkStatus.COMPLETED, reason: null };
  }

  async closeRun(run, batch, status, reason) {
    const metrics = measureBatch(await this.repository.readBatchJobs(batch.id));
    await this.repository.finishRun(run.id, status, metrics, reason);
    return { status, reason };
  }

  async stopEverything() {
    try {
      await this.orchestrator.killAll();
    } catch (error) {
      // Already stopping is fine; anything else is worth knowing about.
      if (error?.code !== "WORKLOADS_STOPPING") {
        console.error("Benchmark could not stop its workloads:", error.message);
      }
    }
  }
}

export const benchmarkService = new BenchmarkService();
