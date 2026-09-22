import {
  ExecutionStatus,
  type Job,
  type JobExecution,
  type Prisma,
  type Worker,
} from "@prisma/client";

import { env } from "../../config/env.js";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors/app-error.js";
import { DockerApiError, DockerUnavailableError } from "./docker.client.js";
import {
  WORKLOAD_IMAGE,
  describeExitCode,
  deriveWorkloadSeed,
  parseRunnerResult,
} from "./execution.contract.js";
import {
  TERMINAL_EXECUTION_STATUSES,
  prismaExecutionRepository,
  type ExecutionFilter,
  type ExecutionRepository,
  type FinalizeExecutionRequest,
} from "./execution.repository.js";
import {
  dockerContainerRuntime,
  type ContainerExit,
  type ContainerRuntime,
  type RuntimeDescription,
} from "./execution.runtime.js";
import type { ListExecutionsQuery } from "./execution.schemas.js";

export interface StartExecutionResult {
  execution: JobExecution;
  job: Job;
  container: {
    id: string;
    name: string;
    image: string;
    cpuMillicores: number;
    memoryMiB: number;
    seed: number;
  };
  timeoutSeconds: number;
}

export interface SettleExecutionResult {
  execution: JobExecution;
  job: Job;
  worker: Worker | null;
  released: boolean;
  alreadySettled: boolean;
}

interface ExecutionOutcome {
  executionStatus: FinalizeExecutionRequest["executionStatus"];
  failureReason: string | null;
  result: Prisma.InputJsonValue | null;
}

export class ExecutionService {
  /** Background settlements, so shutdown and tests can wait for them. */
  private readonly pending = new Map<string, Promise<void>>();

  private imageVerified = false;

  constructor(
    private readonly repository: ExecutionRepository = prismaExecutionRepository,
    private readonly runtime: ContainerRuntime = dockerContainerRuntime,
    private readonly timeoutSeconds: number = env.EXECUTION_TIMEOUT_SECONDS,
  ) {}

  describeRuntime(): Promise<RuntimeDescription> {
    return this.runtime.describe().catch((error: unknown) => {
      throw ExecutionService.toRuntimeError(error);
    });
  }

  /**
   * Claims the job, launches its container, and returns immediately.
   *
   * The container is awaited in the background and settled by `settle()`, which
   * is idempotent, so the same finalisation path serves both the automatic
   * completion and a manual recovery call.
   */
  async start(jobId: string): Promise<StartExecutionResult> {
    await this.requireWorkloadImage();

    const outcome = await this.repository.claim({ jobId });

    switch (outcome.status) {
      case "JOB_NOT_FOUND":
        throw new NotFoundError("Job");
      case "JOB_NOT_RUNNABLE":
        throw new ConflictError(
          `Only scheduled jobs placed on a worker can execute; job is ${outcome.jobStatus}`,
          "JOB_NOT_EXECUTABLE",
        );
      case "NO_RESERVATION":
        throw new ConflictError(
          "Job must hold a resource reservation before it can execute",
          "NO_ACTIVE_ALLOCATION",
        );
      case "EXECUTION_ALREADY_CLAIMED":
        throw new ConflictError(
          "Another request already started this job",
          "EXECUTION_ALREADY_STARTED",
        );
      default:
        break;
    }

    const { execution, job, allocation } = outcome.claimed;
    const seed = deriveWorkloadSeed(job.name);

    let started: { containerId: string; containerName: string };
    try {
      started = await this.runtime.start({
        executionId: execution.id,
        jobId: job.id,
        jobName: job.name,
        workerId: allocation.workerId,
        allocationId: allocation.id,
        workloadType: job.workloadType,
        workloadSize: job.workloadSize,
        cpuMillicores: allocation.cpuMillicores,
        memoryMiB: allocation.memoryMiB,
        seed,
      });
    } catch (error) {
      // The claim already moved the job to RUNNING, so a container that never
      // started has to be recorded as a failed execution. That also releases the
      // reservation, leaving no capacity held for work that is not happening.
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.finalize({
        executionId: execution.id,
        executionStatus: ExecutionStatus.FAILED,
        exitCode: null,
        stdout: null,
        stderr: null,
        failureReason: `container could not be started: ${message}`,
        result: null,
        completedAt: new Date(),
      });
      throw ExecutionService.toRuntimeError(error);
    }

    const runningExecution = await this.repository.markStarted(
      execution.id,
      started.containerId,
    );

    this.track(execution.id, started.containerId);

    return {
      execution: runningExecution,
      job,
      container: {
        id: started.containerId,
        name: started.containerName,
        image: WORKLOAD_IMAGE,
        cpuMillicores: allocation.cpuMillicores,
        memoryMiB: allocation.memoryMiB,
        seed,
      },
      timeoutSeconds: this.timeoutSeconds,
    };
  }

  /**
   * Records a finished container's outcome and releases its reservation.
   *
   * Safe to call repeatedly: a settled execution is returned untouched.
   */
  async settle(executionId: string): Promise<SettleExecutionResult> {
    const execution = await this.repository.findById(executionId);
    if (!execution) {
      throw new NotFoundError("Execution");
    }

    // An already recorded execution is answered from the database alone. Its
    // container has normally been removed by then, so touching the daemon would
    // only produce a spurious failure.
    if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
      const job = await this.repository.findJobForExecution(executionId);
      return {
        execution,
        job,
        worker: null,
        released: false,
        alreadySettled: true,
      };
    }

    if (!execution.containerId) {
      return this.finalize(
        executionId,
        {
          executionStatus: ExecutionStatus.FAILED,
          failureReason: "execution never reached a container",
          result: null,
        },
        null,
      );
    }

    let running: boolean;
    try {
      running = await this.runtime.isRunning(execution.containerId);
    } catch (error) {
      if (!ExecutionService.isMissingContainer(error)) {
        throw ExecutionService.toRuntimeError(error);
      }
      // The container is gone while the execution is still open, so its exit
      // code and output are unrecoverable. That is recorded as a failure rather
      // than guessed at, and the reservation is released.
      return this.finalize(
        executionId,
        {
          executionStatus: ExecutionStatus.FAILED,
          failureReason:
            "container is no longer present on the Docker daemon, so its outcome cannot be recovered",
          result: null,
        },
        null,
      );
    }

    if (running) {
      throw new ConflictError(
        "Container is still running; it will settle on its own when it exits",
        "EXECUTION_STILL_RUNNING",
      );
    }

    const exit = await this.runtime
      .collect(execution.containerId)
      .catch((error: unknown) => {
        throw ExecutionService.toRuntimeError(error);
      });

    const settled = await this.finalize(
      executionId,
      ExecutionService.classify(exit, false, this.timeoutSeconds, execution.attempt),
      exit,
    );

    await this.removeContainer(execution.containerId);
    return settled;
  }

  async get(executionId: string): Promise<JobExecution> {
    const execution = await this.repository.findById(executionId);
    if (!execution) {
      throw new NotFoundError("Execution");
    }
    return execution;
  }

  list(query: ListExecutionsQuery): Promise<JobExecution[]> {
    const filter: ExecutionFilter = {
      jobId: query.jobId,
      workerId: query.workerId,
      status: query.status,
      limit: query.limit,
    };
    return this.repository.list(filter);
  }

  /** Waits for every in-flight background settlement. Used by tests and shutdown. */
  async awaitPendingSettlements(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()]);
    }
  }

  private async requireWorkloadImage(): Promise<void> {
    if (this.imageVerified) return;

    const description = await this.describeRuntime();
    if (!description.imageAvailable) {
      throw new ServiceUnavailableError(
        `Workload image ${WORKLOAD_IMAGE} is not present on the Docker daemon. ` +
          "Build it with `npm run docker:images` before starting executions.",
        "WORKLOAD_IMAGE_MISSING",
      );
    }
    this.imageVerified = true;
  }

  /** Awaits the container in the background and settles it once it exits. */
  private track(executionId: string, containerId: string): void {
    const settlement = (async () => {
      try {
        const { timedOut } = await this.runtime.waitForExit(
          containerId,
          this.timeoutSeconds * 1_000,
        );
        const exit = await this.runtime.collect(containerId);
        const execution = await this.repository.findById(executionId);

        await this.finalize(
          executionId,
          ExecutionService.classify(
            exit,
            timedOut,
            this.timeoutSeconds,
            execution?.attempt ?? 1,
          ),
          exit,
        );
        await this.removeContainer(containerId);
      } catch (error) {
        // The execution stays RUNNING and its reservation stays held. `settle`
        // is the documented recovery path; nothing is silently marked complete.
        console.error(
          `Background settlement failed for execution ${executionId}:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        this.pending.delete(executionId);
      }
    })();

    this.pending.set(executionId, settlement);
  }

  private async finalize(
    executionId: string,
    outcome: ExecutionOutcome,
    exit: ContainerExit | null,
  ): Promise<SettleExecutionResult> {
    const result = await this.repository.finalize({
      executionId,
      executionStatus: outcome.executionStatus,
      exitCode: exit ? exit.exitCode : null,
      stdout: exit ? ExecutionService.annotate(exit.stdout, exit.stdoutTruncated) : null,
      stderr: exit ? ExecutionService.annotate(exit.stderr, exit.stderrTruncated) : null,
      failureReason: outcome.failureReason,
      result: outcome.result,
      completedAt: new Date(),
    });

    if (result.status === "EXECUTION_NOT_FOUND") {
      throw new NotFoundError("Execution");
    }

    if (result.status === "ALREADY_FINALIZED") {
      return {
        execution: result.execution,
        job: result.job,
        worker: null,
        released: false,
        alreadySettled: true,
      };
    }

    return {
      execution: result.execution,
      job: result.job,
      worker: result.worker,
      released: result.released,
      alreadySettled: false,
    };
  }

  private async removeContainer(containerId: string): Promise<void> {
    try {
      await this.runtime.remove(containerId);
    } catch (error) {
      // A leftover container is an operational annoyance, not a data problem:
      // the exit code and logs are already committed.
      console.error(
        `Failed to remove container ${containerId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Turns a container exit into a recorded execution outcome. */
  static classify(
    exit: ContainerExit,
    timedOut: boolean,
    timeoutSeconds: number,
    attempt: number,
  ): ExecutionOutcome {
    if (timedOut) {
      return {
        // Interrupted rather than failed: the workload did not misbehave, the
        // orchestrator stopped it. Interrupted jobs stay eligible for requeue.
        executionStatus: ExecutionStatus.INTERRUPTED,
        failureReason: `execution exceeded the ${timeoutSeconds}s limit and the container was stopped`,
        result: null,
      };
    }

    if (exit.exitCode !== 0) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        failureReason: exit.daemonError
          ? `${describeExitCode(exit.exitCode, exit.oomKilled)}: ${exit.daemonError}`
          : describeExitCode(exit.exitCode, exit.oomKilled),
        result: null,
      };
    }

    const parsed = parseRunnerResult(exit.stdout);
    if (!parsed) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        failureReason: "workload runner exited successfully but produced no valid result line",
        result: null,
      };
    }

    return {
      executionStatus: ExecutionStatus.COMPLETED,
      failureReason: null,
      result: {
        runner: parsed.runner,
        workloadType: parsed.workloadType,
        requestedSize: parsed.workloadSize,
        effectiveSize: parsed.effectiveSize,
        seed: parsed.seed,
        operations: parsed.operations,
        checksum: parsed.checksum,
        runnerDurationMs: parsed.durationMs,
        exitCode: exit.exitCode,
        attempt,
        ...(exit.startedAt ? { containerStartedAt: exit.startedAt } : {}),
        ...(exit.finishedAt ? { containerFinishedAt: exit.finishedAt } : {}),
      },
    };
  }

  private static annotate(output: string, truncated: boolean): string | null {
    if (output.length === 0) return truncated ? "[truncated]" : null;
    return truncated ? `${output}\n[truncated]` : output;
  }

  /** True when the daemon no longer knows about the container. */
  private static isMissingContainer(error: unknown): boolean {
    return error instanceof DockerApiError && error.statusCode === 404;
  }

  private static toRuntimeError(error: unknown): Error {
    if (error instanceof DockerUnavailableError) {
      return new ServiceUnavailableError(error.message, "DOCKER_UNAVAILABLE");
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

export const executionService = new ExecutionService();
