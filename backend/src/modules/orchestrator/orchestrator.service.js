import { JobStatus } from "@prisma/client";
import { freemem, totalmem } from "node:os";
import { AppError, ConflictError } from "../../errors/app-error.js";
import { executionService } from "../executions/execution.service.js";
import { placementService } from "../placement/placement.service.js";
import { resourceService } from "../resources/resource.service.js";
import { schedulerService } from "../scheduler/scheduler.service.js";
import {
  derivePipelineStage,
  isEligibleNow,
  secondsUntilEligible,
} from "./orchestrator.pipeline.js";
import { prismaOrchestratorRepository } from "./orchestrator.repository.js";
function ratio(used, capacity) {
  if (capacity <= 0) return 0;
  return (
    Math.round(Math.min(1, Math.max(0, used / capacity)) * 10_000) / 10_000
  );
}
function describeError(error) {
  if (error instanceof AppError) {
    return { detail: error.message, code: error.code };
  }
  return {
    detail: error instanceof Error ? error.message : String(error),
    code: "INTERNAL_ERROR",
  };
}
export class OrchestratorService {
  repository;
  scheduler;
  placement;
  resources;
  executions;
  clock;
  stopping = false;
  activeRuns = new Set();
  constructor(
    repository = prismaOrchestratorRepository,
    scheduler = schedulerService,
    placement = placementService,
    resources = resourceService,
    executions = executionService,
    clock = () => new Date(),
  ) {
    this.repository = repository;
    this.scheduler = scheduler;
    this.placement = placement;
    this.resources = resources;
    this.executions = executions;
    this.clock = clock;
  }
  /**
   * Advances up to `maxJobs` jobs through the whole pipeline.
   *
   * Stops early and reports why when the queue is empty or the cluster is full,
   * because both are normal outcomes rather than errors: a full cluster simply
   * means the next job waits for a running one to release its capacity.
   */
  async run(input) {
    if (this.stopping) throw new ConflictError("Workloads are being stopped", "WORKLOADS_STOPPING");
    const request = this.runBatch(input);
    this.activeRuns.add(request);
    try {
      return await request;
    } finally {
      this.activeRuns.delete(request);
    }
  }
  async runBatch(input) {
    const steps = [];
    let startedCount = 0;
    let stoppedBecause = null;
    for (let index = 0; index < input.maxJobs; index += 1) {
      if (this.stopping) { stoppedBecause = "WORKLOADS_STOPPING"; break; }
      const step = await this.runNext(input);
      steps.push(step);
      if (step.execution) {
        startedCount += 1;
      }
      if (!step.advanced || step.stoppedBecause) {
        stoppedBecause = step.stoppedBecause;
        break;
      }
    }
    return {
      policy: input.policy,
      strategy: input.strategy,
      requested: input.maxJobs,
      startedCount,
      steps,
      stoppedBecause,
    };
  }
  /**
   * Moves exactly one job as far as it can go.
   *
   * A job left half-advanced by a previous single-stage call is resumed before a
   * new one is pulled off the queue, so clicking stages in any order cannot
   * strand work.
   */
  async runNext(input) {
    const stages = [];
    const resumable = await this.repository.findResumableJob();
    let jobId;
    let jobName;
    let assignedWorkerId;
    if (resumable) {
      jobId = resumable.id;
      jobName = resumable.name;
      assignedWorkerId = resumable.assignedWorkerId;
      stages.push({
        stage: "SCHEDULE",
        status: "SKIPPED",
        detail: `Already scheduled under ${resumable.schedulingPolicy ?? "an earlier policy"}; resuming it`,
        code: null,
      });
    } else {
      const dispatch = await this.scheduler.dispatch({
        policy: input.policy,
        count: 1,
        ...(input.timeQuantumSeconds === undefined
          ? {}
          : { timeQuantumSeconds: input.timeQuantumSeconds }),
      });
      const scheduled = dispatch.scheduled[0];
      if (!scheduled) {
        return {
          advanced: false,
          jobId: null,
          jobName: null,
          stages: [
            {
              stage: "SCHEDULE",
              status: "SKIPPED",
              detail:
                dispatch.eligibleCount === 0
                  ? "No queued job has reached its planned arrival time yet"
                  : "No queued job could be claimed",
              code: "NOTHING_ELIGIBLE",
            },
          ],
          worker: null,
          reservation: null,
          execution: null,
          stoppedBecause: "NOTHING_ELIGIBLE",
        };
      }
      jobId = scheduled.id;
      jobName = scheduled.name;
      assignedWorkerId = scheduled.assignedWorkerId;
      stages.push({
        stage: "SCHEDULE",
        status: "OK",
        detail: `Selected by ${dispatch.policy} from ${dispatch.eligibleCount} eligible job(s)`,
        code: null,
      });
    }
    let worker = null;
    // Placement
    if (assignedWorkerId) {
      worker = { id: assignedWorkerId, name: "" };
      stages.push({
        stage: "PLACEMENT",
        status: "SKIPPED",
        detail: "Job was already placed on a worker",
        code: null,
      });
    } else {
      try {
        const assignment = await this.placement.assign({
          jobId,
          strategy: input.strategy,
        });
        const selected = assignment.selected;
        if (selected) {
          worker = { id: selected.workerId, name: selected.name };
        }
        stages.push({
          stage: "PLACEMENT",
          status: "OK",
          detail: selected
            ? `${input.strategy} chose ${selected.name}`
            : `${input.strategy} made a decision`,
          code: null,
        });
      } catch (error) {
        const { detail, code } = describeError(error);
        stages.push({ stage: "PLACEMENT", status: "FAILED", detail, code });
        return {
          advanced: true,
          jobId,
          jobName,
          stages,
          worker: null,
          reservation: null,
          execution: null,
          stoppedBecause: code,
        };
      }
    }
    // Reservation
    let reservation = null;
    if (await this.repository.hasActiveReservation(jobId)) {
      stages.push({
        stage: "RESERVATION",
        status: "SKIPPED",
        detail: "Capacity was already reserved for this job",
        code: null,
      });
    } else {
      try {
        const reserved = await this.resources.reserve({ jobId });
        reservation = {
          cpuMillicores: reserved.allocation.cpuMillicores,
          memoryMiB: reserved.allocation.memoryMiB,
          lockWaitMs: reserved.lockWaitMs,
        };
        worker = { id: reserved.worker.id, name: reserved.worker.name };
        stages.push({
          stage: "RESERVATION",
          status: "OK",
          detail:
            `Committed ${reserved.allocation.cpuMillicores}m CPU and ` +
            `${reserved.allocation.memoryMiB}MiB on ${reserved.worker.name} ` +
            `under a row lock (waited ${reserved.lockWaitMs}ms)`,
          code: null,
        });
      } catch (error) {
        const { detail, code } = describeError(error);
        stages.push({ stage: "RESERVATION", status: "FAILED", detail, code });
        return {
          advanced: true,
          jobId,
          jobName,
          stages,
          worker,
          reservation: null,
          execution: null,
          stoppedBecause: code,
        };
      }
    }
    // Execution
    try {
      const started = await this.executions.start(jobId);
      stages.push({
        stage: "EXECUTION",
        status: "OK",
        detail:
          `Started container ${started.container.id.slice(0, 12)} from ` +
          `${started.container.image}, limited to ${started.container.cpuMillicores}m CPU ` +
          `and ${started.container.memoryMiB}MiB`,
        code: null,
      });
      return {
        advanced: true,
        jobId,
        jobName,
        stages,
        worker,
        reservation,
        execution: {
          id: started.execution.id,
          containerId: started.container.id,
          image: started.container.image,
          timeoutSeconds: started.timeoutSeconds,
        },
        stoppedBecause: null,
      };
    } catch (error) {
      const { detail, code } = describeError(error);
      stages.push({ stage: "EXECUTION", status: "FAILED", detail, code });
      return {
        advanced: true,
        jobId,
        jobName,
        stages,
        worker,
        reservation,
        execution: null,
        stoppedBecause: code,
      };
    }
  }
  /**
   * Clears finished jobs so a demonstration can restart from an empty queue.
   *
   * Running and reserved work is deliberately left alone.
   */
  clearFinished() {
    return this.repository.deleteFinishedJobs();
  }
  async killAll() {
    if (this.stopping) throw new ConflictError("Workloads are already being stopped", "WORKLOADS_STOPPING");
    this.stopping = true;
    try {
      await Promise.allSettled([...this.activeRuns]);
      return await this.executions.killAll();
    } finally {
      this.stopping = false;
    }
  }
  /** One read that gives the dashboard everything it needs to render. */
  async state(query) {
    const now = this.clock();
    const [rows, workers, statusCounts] = await Promise.all([
      this.repository.listJobStates(query.limit),
      this.repository.listWorkers(),
      this.repository.countJobsByStatus(),
    ]);
    const stageCounts = {
      QUEUE: 0,
      SCHEDULER: 0,
      PLACEMENT: 0,
      RESERVATION: 0,
      EXECUTION: 0,
      COMPLETED: 0,
      TERMINATED: 0,
    };
    const runningByWorker = new Map();
    let eligibleNow = 0;
    let waitingForArrival = 0;
    let activeReservations = 0;
    let runningContainers = 0;
    const jobs = rows.map((row) => {
      const { job } = row;
      const stage = derivePipelineStage({
        status: job.status,
        assignedWorkerId: job.assignedWorkerId,
        hasActiveReservation: row.hasActiveReservation,
        executionStatus: row.execution?.status ?? null,
      });
      stageCounts[stage] += 1;
      const eligible = isEligibleNow(job.status, job.arrivalAt, now);
      if (eligible) eligibleNow += 1;
      if (job.status === JobStatus.QUEUED && !eligible) waitingForArrival += 1;
      if (row.hasActiveReservation) activeReservations += 1;
      const execution = row.execution;
      const isRunning = job.status === JobStatus.RUNNING;
      if (isRunning) {
        runningContainers += 1;
        if (job.assignedWorkerId) {
          const entries = runningByWorker.get(job.assignedWorkerId) ?? [];
          entries.push({
            jobId: job.id,
            jobName: job.name,
            containerShortId: execution?.containerId?.slice(0, 12) ?? null,
          });
          runningByWorker.set(job.assignedWorkerId, entries);
        }
      }
      const elapsedSeconds = execution?.startedAt
        ? Math.max(
            0,
            Math.round(
              ((execution.completedAt ?? now).getTime() -
                execution.startedAt.getTime()) /
                1_000,
            ),
          )
        : null;
      return {
        id: job.id,
        name: job.name,
        workloadType: job.workloadType,
        workloadSize: job.workloadSize,
        cpuRequiredMillicores: job.cpuRequiredMillicores,
        memoryRequiredMiB: job.memoryRequiredMiB,
        priority: job.priority,
        estimatedDurationSeconds: job.estimatedDurationSeconds,
        status: job.status,
        stage,
        arrivalAt: job.arrivalAt.toISOString(),
        eligibleNow: eligible,
        secondsUntilEligible:
          job.status === JobStatus.QUEUED
            ? secondsUntilEligible(job.arrivalAt, now)
            : 0,
        schedulingPolicy: job.schedulingPolicy,
        placementStrategy: job.placementStrategy,
        assignedWorkerId: job.assignedWorkerId,
        assignedWorkerName: row.workerName,
        reservation: row.reservation
          ? {
              cpuMillicores: row.reservation.cpuMillicores,
              memoryMiB: row.reservation.memoryMiB,
              reservedAt: row.reservation.reservedAt.toISOString(),
            }
          : null,
        execution: execution
          ? {
              id: execution.id,
              status: execution.status,
              attempt: execution.attempt,
              containerId: execution.containerId,
              containerShortId: execution.containerId?.slice(0, 12) ?? null,
              startedAt: execution.startedAt?.toISOString() ?? null,
              completedAt: execution.completedAt?.toISOString() ?? null,
              elapsedSeconds,
              exitCode: execution.exitCode,
              failureReason: execution.failureReason,
            }
          : null,
        result: job.result,
        failureReason: job.failureReason,
      };
    });
    return {
      capturedAt: now.toISOString(),
      hostMemory: {
        totalMiB: Math.round(totalmem() / 1024 / 1024),
        freeMiB: Math.round(freemem() / 1024 / 1024),
        workerBudgetMiB: workers.reduce((sum, worker) => sum + worker.memoryCapacityMiB, 0),
      },
      jobs,
      workers: workers.map((entry) => ({
        id: entry.id,
        name: entry.name,
        status: entry.status,
        cpuCapacityMillicores: entry.cpuCapacityMillicores,
        cpuAllocatedMillicores: entry.cpuAllocatedMillicores,
        cpuUtilization: ratio(
          entry.cpuAllocatedMillicores,
          entry.cpuCapacityMillicores,
        ),
        memoryCapacityMiB: entry.memoryCapacityMiB,
        memoryAllocatedMiB: entry.memoryAllocatedMiB,
        memoryUtilization: ratio(
          entry.memoryAllocatedMiB,
          entry.memoryCapacityMiB,
        ),
        runningJobs: runningByWorker.get(entry.id) ?? [],
      })),
      stageCounts,
      statusCounts,
      totals: {
        jobs: Object.values(statusCounts).reduce(
          (sum, count) => sum + count,
          0,
        ),
        eligibleNow,
        waitingForArrival,
        activeReservations,
        runningContainers,
      },
    };
  }
}
export const orchestratorService = new OrchestratorService();
