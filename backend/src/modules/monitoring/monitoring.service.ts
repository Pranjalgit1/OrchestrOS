import { JobStatus, WorkerStatus } from "@prisma/client";

import {
  completionRatePerMinute,
  ratio,
  round,
  summariseCluster,
  summariseTimings,
  utilizationSeries,
  type ClusterUtilization,
  type TimingSummary,
  type UtilizationPoint,
} from "./monitoring.metrics.js";
import {
  prismaMonitoringRepository,
  type MonitoringRepository,
  type RunningExecutionRow,
} from "./monitoring.repository.js";
import type {
  JobMetricsQuery,
  SampleHistoryQuery,
} from "./monitoring.schemas.js";

export interface WorkerMetric {
  workerId: string;
  name: string;
  status: WorkerStatus;
  cpuCapacityMillicores: number;
  cpuAllocatedMillicores: number;
  cpuAvailableMillicores: number;
  cpuUtilization: number;
  memoryCapacityMiB: number;
  memoryAllocatedMiB: number;
  memoryAvailableMiB: number;
  memoryUtilization: number;
  reservedAllocations: number;
  runningExecutions: number;
  executionsRun: number;
  jobsCompleted: number;
  jobsFailed: number;
}

export interface MonitoringOverview {
  capturedAt: string;
  cluster: ClusterUtilization;
  workers: WorkerMetric[];
  queue: {
    byStatus: Record<string, number>;
    total: number;
    waitingToRun: number;
    active: number;
    finished: number;
  };
  executions: {
    byStatus: Record<string, number>;
    running: RunningExecutionRow[];
  };
  reservations: {
    active: number;
  };
  samples: {
    stored: number;
    latestAt: string | null;
  };
}

export interface JobMetrics {
  windowMinutes: number;
  since: string;
  timings: TimingSummary;
  completedInWindow: Record<string, number>;
  terminalInWindow: number;
  completionsPerMinute: number;
  successRate: number | null;
}

export interface SampleHistory {
  windowMinutes: number;
  pointCount: number;
  points: UtilizationPoint[];
}

export interface SampleCaptureResult {
  capturedAt: string;
  workersRecorded: number;
  prunedSamples: number;
}

/** Job states that have not started running yet. */
const WAITING_STATES: readonly JobStatus[] = [
  JobStatus.CREATED,
  JobStatus.QUEUED,
  JobStatus.WAITING,
  JobStatus.SCHEDULED,
];

const FINISHED_STATES: readonly JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.INTERRUPTED,
  JobStatus.CANCELLED,
];

function sumOf(counts: Record<string, number>, keys: readonly string[]): number {
  return keys.reduce((total, key) => total + (counts[key] ?? 0), 0);
}

export class MonitoringService {
  constructor(
    private readonly repository: MonitoringRepository = prismaMonitoringRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The live view: one consistent read of cluster, queue, and execution state. */
  async overview(): Promise<MonitoringOverview> {
    const now = this.clock();
    const [data, activity] = await Promise.all([
      this.repository.overview(now),
      this.repository.workerActivity(),
    ]);

    const activityById = new Map(activity.map((entry) => [entry.workerId, entry]));
    const jobTotal = Object.values(data.jobsByStatus).reduce((sum, count) => sum + count, 0);

    return {
      capturedAt: now.toISOString(),
      cluster: summariseCluster(data.workers),
      workers: data.workers.map((worker) => {
        const stats = activityById.get(worker.id);
        return {
          workerId: worker.id,
          name: worker.name,
          status: worker.status,
          cpuCapacityMillicores: worker.cpuCapacityMillicores,
          cpuAllocatedMillicores: worker.cpuAllocatedMillicores,
          cpuAvailableMillicores: Math.max(
            0,
            worker.cpuCapacityMillicores - worker.cpuAllocatedMillicores,
          ),
          cpuUtilization: round(
            ratio(worker.cpuAllocatedMillicores, worker.cpuCapacityMillicores),
          ),
          memoryCapacityMiB: worker.memoryCapacityMiB,
          memoryAllocatedMiB: worker.memoryAllocatedMiB,
          memoryAvailableMiB: Math.max(0, worker.memoryCapacityMiB - worker.memoryAllocatedMiB),
          memoryUtilization: round(
            ratio(worker.memoryAllocatedMiB, worker.memoryCapacityMiB),
          ),
          reservedAllocations: stats?.reservedAllocations ?? 0,
          runningExecutions: stats?.runningExecutions ?? 0,
          executionsRun: stats?.executionsRun ?? 0,
          jobsCompleted: stats?.jobsCompleted ?? 0,
          jobsFailed: stats?.jobsFailed ?? 0,
        };
      }),
      queue: {
        byStatus: data.jobsByStatus,
        total: jobTotal,
        waitingToRun: sumOf(data.jobsByStatus, WAITING_STATES),
        active: data.jobsByStatus[JobStatus.RUNNING] ?? 0,
        finished: sumOf(data.jobsByStatus, FINISHED_STATES),
      },
      executions: {
        byStatus: data.executionsByStatus,
        running: data.runningExecutions,
      },
      reservations: {
        active: data.reservedAllocations,
      },
      samples: {
        stored: data.sampleCount,
        latestAt: data.latestSampleAt?.toISOString() ?? null,
      },
    };
  }

  /**
   * Lifecycle timings and completion rate over a window.
   *
   * Timings cover jobs created inside the window, so a stage that has not
   * happened yet simply reports a zero count. Completion counts are anchored on
   * when a job finished, which is what a rate should measure.
   */
  async jobMetrics(query: JobMetricsQuery): Promise<JobMetrics> {
    const now = this.clock();
    const since = new Date(now.getTime() - query.windowMinutes * 60_000);

    const [rows, completed] = await Promise.all([
      this.repository.jobTimings(since),
      this.repository.terminalJobCounts(since),
    ]);

    const terminal = Object.values(completed).reduce((sum, count) => sum + count, 0);
    const succeeded = completed[JobStatus.COMPLETED] ?? 0;

    return {
      windowMinutes: query.windowMinutes,
      since: since.toISOString(),
      timings: summariseTimings(rows),
      completedInWindow: completed,
      terminalInWindow: terminal,
      completionsPerMinute: completionRatePerMinute(terminal, query.windowMinutes),
      successRate: terminal === 0 ? null : round(succeeded / terminal),
    };
  }

  /** Recorded utilization history, collapsed into cluster points over time. */
  async sampleHistory(query: SampleHistoryQuery): Promise<SampleHistory> {
    const now = this.clock();
    const samples = await this.repository.listSamples(
      {
        workerId: query.workerId,
        sinceMinutes: query.windowMinutes,
        limit: query.limit,
      },
      now,
    );

    const points = utilizationSeries(samples);
    return {
      windowMinutes: query.windowMinutes,
      pointCount: points.length,
      points,
    };
  }

  /**
   * Records one sampling pass and prunes history past the retention window.
   *
   * Pruning happens here rather than on a separate schedule so that history
   * cannot grow without bound whether sampling is periodic or on demand.
   */
  async captureSample(retentionHours: number): Promise<SampleCaptureResult> {
    const capturedAt = this.clock();
    const workersRecorded = await this.repository.captureSample(capturedAt);
    const prunedSamples =
      retentionHours > 0
        ? await this.repository.pruneSamples(
            new Date(capturedAt.getTime() - retentionHours * 3_600_000),
          )
        : 0;

    return {
      capturedAt: capturedAt.toISOString(),
      workersRecorded,
      prunedSamples,
    };
  }
}

export const monitoringService = new MonitoringService();
