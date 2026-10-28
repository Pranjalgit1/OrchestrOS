import { BenchmarkStatus, SchedulingPolicy } from "@prisma/client";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors/app-error.js";
import { autoscalerService } from "../autoscaler/autoscaler.service.js";
import { clusterUtilization } from "../autoscaler/autoscaler.policy.js";
import { measureBatch } from "../benchmarks/benchmark.metrics.js";
import { DEFAULT_RUN_TIMEOUT_MS, DEFAULT_TICK_MS, WAIT_CODES } from "../benchmarks/benchmark.service.js";
import { registerExperiment, runningExperiment, sentenceStart } from "../benchmarks/experiment.registry.js";
import { executionService } from "../executions/execution.service.js";
import { orchestratorService } from "../orchestrator/orchestrator.service.js";
import { workloadService } from "../workloads/workload.service.js";
import { compareScaling, measureScaling } from "./scaling-comparison.metrics.js";
import { prismaScalingComparisonRepository } from "./scaling-comparison.repository.js";
import { STRATEGY_ORDER } from "./scaling-comparison.schemas.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** How this experiment is named in messages from the other one. */
export const SCALING_COMPARISON = "an autoscaling comparison";
export const DEFAULT_SAMPLE_MS = 2_000;

/** Autoscaler settings both runs share; recorded with the comparison. */
const SHARED_SETTINGS = [
  "maxWorkers", "workerCpuMillicores", "workerMemoryMiB", "scaleUpQueueThreshold",
  "scaleUpUtilization", "scaleDownUtilization", "idleSeconds", "cooldownSeconds",
  "mlWindowPoints", "mlLookAheadSeconds",
];

/** Run fields copied from the batch metrics; the rest of measureBatch is not stored. */
const JOB_FIELDS = [
  "jobCount", "completedJobs", "failedJobs", "cancelledJobs", "avgWaitSeconds", "p95WaitSeconds",
  "avgTurnaroundSeconds", "makespanSeconds", "throughputPerMinute", "checksumDigest",
];
const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, source[key] ?? null]));

/**
 * Reactive-vs-ML autoscaling comparison.
 *
 * Runs one seeded workload twice through the real pipeline: first with the
 * reactive strategy, then with ML. Only the strategy changes. The scheduling
 * policy, placement, thresholds, limits, and the work itself (the second run
 * reuses the first run's batch) are identical.
 *
 * Before each run the cluster goes back to its base workers, the autoscaler's
 * cooldown is allowed to expire, and its load history is cleared, so neither
 * run inherits anything from the other. While a run is in progress the
 * timeline is sampled every couple of seconds.
 *
 * Like the policy benchmark, it needs an idle cluster, locks out pipeline
 * changes through the route guard, and runs one at a time in this process.
 * The two experiments refuse to start while the other runs. The autoscaler's
 * enabled state and strategy are restored afterwards.
 */
export class ScalingComparisonService {
  active = null;

  constructor(
    repository = prismaScalingComparisonRepository,
    {
      workloads = workloadService,
      orchestrator = orchestratorService,
      executions = executionService,
      autoscaler = autoscalerService,
      clock = () => new Date(),
      wait = sleep,
      tickMs = DEFAULT_TICK_MS,
      sampleMs = DEFAULT_SAMPLE_MS,
      runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    } = {},
  ) {
    Object.assign(this, {
      repository, workloads, orchestrator, executions, autoscaler, clock, wait, tickMs, sampleMs, runTimeoutMs,
    });
  }

  get isRunning() {
    return this.active !== null;
  }

  /** Checks the preconditions, records the comparison, and starts it in the background. */
  async start(input) {
    if (this.active) {
      throw new ConflictError("An autoscaling comparison is already running", "COMPARISON_RUNNING");
    }
    const other = runningExperiment(SCALING_COMPARISON);
    if (other) {
      throw new ConflictError(`${sentenceStart(other)} is running. Wait for it to finish first.`, "BENCHMARK_RUNNING");
    }
    // Reserve the slot before any await, so two requests cannot both pass.
    this.active = { comparisonId: null, abortRequested: false, progress: null, runId: null, samples: [], done: null };
    try {
      if (!this.autoscaler.loopEnabled) {
        throw new ConflictError(
          "The autoscaler's timer is off (AUTOSCALE_INTERVAL_SECONDS=0), so neither strategy would ever act. " +
            "Set it above 0 and restart the backend.",
          "AUTOSCALER_LOOP_DISABLED",
        );
      }
      if (this.autoscaler.config.maxWorkers < 1) {
        throw new ConflictError(
          "The autoscaler may not add any extra workers (Most extra workers is 0), so both runs would be identical.",
          "AUTOSCALER_NO_CAPACITY",
        );
      }
      const unfinished = await this.repository.countUnfinishedJobs();
      if (unfinished > 0) {
        throw new ConflictError(
          `${unfinished} job(s) are still unfinished. A comparison needs an idle cluster, ` +
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
      const settings = pick(this.autoscaler.config, SHARED_SETTINGS);
      const comparison = await this.repository.createComparison({
        schedulingPolicy: input.policy,
        placementStrategy: input.strategy,
        pattern: input.pattern,
        seed: input.seed,
        jobCount: input.count,
        workloadTypes: input.workloadTypes,
        timeQuantumSeconds: input.timeQuantumSeconds,
        jobsPerTick: input.jobsPerTick,
        autoscalerSettings: settings,
        startedAt: this.clock(),
      }, STRATEGY_ORDER);
      this.active.comparisonId = comparison.id;
      this.active.done = this.runComparison(comparison, input, settings).finally(() => {
        this.active = null;
      });
      return this.present(comparison);
    } catch (error) {
      if (!this.active?.comparisonId) this.active = null;
      throw error;
    }
  }

  /** Asks the running comparison to stop; its current run is cancelled and recorded. */
  abort(comparisonId) {
    if (!this.active || this.active.comparisonId !== comparisonId) {
      throw new ConflictError("That comparison is not running", "COMPARISON_NOT_RUNNING");
    }
    this.active.abortRequested = true;
    return { comparisonId, abortRequested: true };
  }

  /** One comparison with both runs' timelines; a live run includes the samples so far. */
  async get(comparisonId) {
    const comparison = await this.repository.findComparison(comparisonId);
    if (!comparison) throw new NotFoundError("Comparison");
    return this.present(comparison, { samples: true });
  }

  /** Recent comparisons with their results, without timelines. */
  async list(limit) {
    const comparisons = await this.repository.listComparisons(limit);
    return {
      activeComparisonId: this.active?.comparisonId ?? null,
      comparisons: comparisons.map((comparison) => this.present(comparison)),
    };
  }

  async awaitCompletion() {
    await this.active?.done;
  }

  present(comparison, { samples = false } = {}) {
    const live = this.active?.comparisonId === comparison.id ? this.active : null;
    const runs = (comparison.runs ?? []).map(({ samples: stored, ...run }) => {
      if (!samples) return run;
      const timeline = live?.runId === run.id ? live.samples : stored ?? [];
      return { ...run, samples: timeline };
    });
    return {
      ...comparison,
      runs,
      progress: live?.progress ?? null,
      abortRequested: live?.abortRequested ?? false,
      comparison: compareScaling(runs),
    };
  }

  async runComparison(comparison, input, settings) {
    const previous = { enabled: this.autoscaler.config.enabled, strategy: this.autoscaler.config.strategy };
    let sourceBatchId = null;
    let outcome = { status: BenchmarkStatus.COMPLETED, reason: null };
    try {
      for (const run of comparison.runs) {
        if (this.active.abortRequested) {
          outcome = { status: BenchmarkStatus.ABORTED, reason: "Stopped by the operator" };
          break;
        }
        await this.resetCluster(settings);
        const batch = sourceBatchId
          ? await this.workloads.reuse(sourceBatchId, {})
          : await this.workloads.generate({
              seed: input.seed,
              count: input.count,
              pattern: input.pattern,
              workloadTypes: input.workloadTypes,
            });
        sourceBatchId ??= batch.id;
        const result = await this.runStrategy(run, batch, input, settings);
        if (result.status !== BenchmarkStatus.COMPLETED) {
          outcome = result;
          break;
        }
      }
    } catch (error) {
      outcome = { status: BenchmarkStatus.FAILED, reason: error instanceof Error ? error.message : String(error) };
      await this.stopEverything();
    } finally {
      try {
        this.autoscaler.updateConfig(previous);
      } catch (error) {
        console.error("The autoscaler settings could not be restored:", error.message);
      }
      this.autoscaler.resume();
      try {
        await this.repository.finishComparison(comparison.id, outcome.status, outcome.reason);
      } catch (error) {
        console.error(`Comparison ${comparison.id} could not be recorded as finished:`, error.message);
      }
    }
  }

  /**
   * Back to the base cluster: freeze the autoscaler, retire every extra
   * worker, and wait out any cooldown left from earlier scaling, so a run
   * can scale as soon as it needs to.
   */
  async resetCluster(settings) {
    this.autoscaler.pause("an autoscaling comparison is resetting the cluster between runs");
    const { remaining } = await this.repository.retireAutoscaledWorkers();
    if (remaining > 0) {
      throw new Error(`${remaining} extra worker(s) still hold work, so the cluster could not be reset`);
    }
    const lastAction = await this.repository.lastScalingEventAt();
    if (lastAction) {
      const left = settings.cooldownSeconds * 1_000 - (this.clock().getTime() - lastAction.getTime());
      if (left > 0) await this.wait(left);
    }
  }

  /** One timeline point: waiting jobs, workers, utilization, and the ML forecast. */
  async sample(startedAt, strategy) {
    const now = this.clock();
    const { queuedJobs, workers } = await this.repository.readLoad(now);
    const extra = workers.filter((worker) => worker.autoscaled);
    const forecast = strategy === "ML" ? this.autoscaler.forecast() : null;
    return {
      at: now,
      offsetSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 10) / 100),
      queuedJobs,
      workersInService: workers.length,
      extraWorkers: extra.length,
      idleExtraWorkers: extra.filter((worker) =>
        worker.cpuAllocatedMillicores === 0 && worker.memoryAllocatedMiB === 0).length,
      peakUtilization: clusterUtilization(workers).peak,
      forecastQueuedJobs: forecast?.queuedJobs ?? null,
      forecastPeak: forecast?.peak ?? null,
    };
  }

  /** Drives one strategy's batch until every job in it has finished, sampling as it goes. */
  async runStrategy(run, batch, input, settings) {
    this.autoscaler.updateConfig({ enabled: true, strategy: run.strategy });
    this.autoscaler.resetHistory();
    const capacity = await this.repository.readCapacity();
    const startedAt = this.clock();
    await this.repository.startRun(run.id, {
      workloadBatchId: batch.id,
      capacity,
      jobCount: batch.jobs?.length ?? batch.jobCount,
      startedAt,
    });
    const samples = [];
    Object.assign(this.active, { runId: run.id, samples });
    this.autoscaler.resume();

    const lastArrivalMs = Math.max(0, ...(batch.jobs ?? []).map((job) => job.arrivalOffsetSeconds ?? 0)) * 1_000;
    const deadline = startedAt.getTime() + lastArrivalMs + this.runTimeoutMs;
    const request = {
      policy: input.policy,
      strategy: input.strategy,
      maxJobs: input.jobsPerTick,
      ...(input.policy === SchedulingPolicy.ROUND_ROBIN ? { timeQuantumSeconds: input.timeQuantumSeconds } : {}),
    };
    let lastSampleMs = Number.NEGATIVE_INFINITY;
    const finish = (status, reason) => this.closeRun(run, batch, settings, samples, startedAt, status, reason);

    for (;;) {
      if (this.clock().getTime() - lastSampleMs >= this.sampleMs) {
        samples.push(await this.sample(startedAt, run.strategy));
        lastSampleMs = this.clock().getTime();
      }
      const progress = await this.repository.batchProgress(batch.id);
      this.active.progress = {
        runId: run.id,
        strategy: run.strategy,
        position: run.position,
        totalRuns: STRATEGY_ORDER.length,
        finishedJobs: progress.finished,
        totalJobs: progress.total,
      };
      if (progress.total > 0 && progress.unfinished === 0) break;

      if (this.active.abortRequested) {
        await this.stopEverything();
        return finish(BenchmarkStatus.ABORTED, "Stopped by the operator");
      }
      if (this.clock().getTime() > deadline) {
        await this.stopEverything();
        return finish(BenchmarkStatus.FAILED,
          `The ${run.strategy} run did not finish within ${Math.round(this.runTimeoutMs / 60_000)} minutes ` +
            "of its last arrival");
      }
      try {
        const result = await this.orchestrator.run(request);
        if (result.stoppedBecause && !WAIT_CODES.has(result.stoppedBecause)) {
          if (result.stoppedBecause === "WORKLOADS_STOPPING") {
            return finish(BenchmarkStatus.ABORTED, "Workloads were stopped");
          }
          const failed = result.steps.flatMap((step) => step.stages).find((stage) => stage.status === "FAILED");
          await this.stopEverything();
          return finish(BenchmarkStatus.FAILED, failed?.detail ?? `The orchestrator stopped with ${result.stoppedBecause}`);
        }
      } catch (error) {
        if (error?.code === "WORKLOADS_STOPPING") return finish(BenchmarkStatus.ABORTED, "Workloads were stopped");
        throw error;
      }
      await this.wait(this.tickMs);
    }

    samples.push(await this.sample(startedAt, run.strategy));
    return finish(BenchmarkStatus.COMPLETED, null);
  }

  /**
   * Freezes the autoscaler so nothing changes while the run is measured, then
   * stores job and scaling results and the timeline. Cancelled jobs make a
   * completed run aborted, because it no longer did the full work.
   */
  async closeRun(run, batch, settings, samples, startedAt, status, reason) {
    this.autoscaler.pause("an autoscaling comparison is measuring a finished run");
    const endedAt = this.clock();
    const [jobs, actions] = await Promise.all([
      this.repository.readBatchJobs(batch.id),
      this.repository.listActions(startedAt, endedAt),
    ]);
    const jobMetrics = measureBatch(jobs);
    const scaling = measureScaling({ samples, actions, settings, endedAt, sampleIntervalMs: this.sampleMs });
    let finalStatus = status;
    let finalReason = reason;
    if (status === BenchmarkStatus.COMPLETED && jobMetrics.cancelledJobs > 0) {
      finalStatus = BenchmarkStatus.ABORTED;
      finalReason = "Some jobs were cancelled during the run";
    }
    await this.repository.finishRun(run.id, finalStatus, {
      ...pick(jobMetrics, JOB_FIELDS),
      ...scaling,
      scalingActions: actions.map((action) => ({ ...action, at: action.at.toISOString() })),
    }, finalReason, samples);
    this.active.runId = null;
    return { status: finalStatus, reason: finalReason };
  }

  async stopEverything() {
    try {
      await this.orchestrator.killAll();
    } catch (error) {
      if (error?.code !== "WORKLOADS_STOPPING") {
        console.error("Comparison could not stop its workloads:", error.message);
      }
    }
  }
}

export const scalingComparisonService = new ScalingComparisonService();
registerExperiment(SCALING_COMPARISON, () => scalingComparisonService.isRunning);
