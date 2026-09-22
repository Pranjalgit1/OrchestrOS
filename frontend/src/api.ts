export interface HealthStatus {
  service: string;
  status: "ok" | "degraded";
  timestamp: string;
  dependencies: {
    database: "up" | "down";
  };
}

export async function fetchHealthStatus(signal?: AbortSignal): Promise<HealthStatus> {
  const response = await fetch("/api/health", { signal });
  const body = (await response.json()) as HealthStatus;

  if (!response.ok && response.status !== 503) {
    throw new Error(`Backend health check returned ${response.status}`);
  }

  return body;
}

export interface ClusterUtilization {
  workerCount: number;
  schedulableWorkers: number;
  cpuCapacityMillicores: number;
  cpuAllocatedMillicores: number;
  cpuAvailableMillicores: number;
  cpuUtilization: number;
  memoryCapacityMiB: number;
  memoryAllocatedMiB: number;
  memoryAvailableMiB: number;
  memoryUtilization: number;
  workersByStatus: Record<string, number>;
}

export interface WorkerMetric {
  workerId: string;
  name: string;
  status: string;
  cpuCapacityMillicores: number;
  cpuAllocatedMillicores: number;
  cpuUtilization: number;
  memoryCapacityMiB: number;
  memoryAllocatedMiB: number;
  memoryUtilization: number;
  reservedAllocations: number;
  runningExecutions: number;
  executionsRun: number;
  jobsCompleted: number;
  jobsFailed: number;
}

export interface RunningExecution {
  executionId: string;
  jobName: string;
  workerName: string;
  workloadType: string;
  attempt: number;
  containerId: string | null;
  elapsedSeconds: number;
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
    running: RunningExecution[];
  };
  reservations: { active: number };
  samples: { stored: number; latestAt: string | null };
}

export interface DurationStats {
  count: number;
  averageSeconds: number | null;
  minimumSeconds: number | null;
  maximumSeconds: number | null;
  p95Seconds: number | null;
}

export interface JobMetrics {
  windowMinutes: number;
  since: string;
  timings: Record<string, DurationStats>;
  completedInWindow: Record<string, number>;
  terminalInWindow: number;
  completionsPerMinute: number;
  successRate: number | null;
}

export interface UtilizationPoint {
  capturedAt: string;
  cpuUtilization: number;
  memoryUtilization: number;
  runningExecutions: number;
}

export interface SampleHistory {
  windowMinutes: number;
  pointCount: number;
  points: UtilizationPoint[];
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchOverview(signal?: AbortSignal): Promise<MonitoringOverview> {
  return getJson<MonitoringOverview>("/api/monitoring/overview", signal);
}

export function fetchJobMetrics(
  windowMinutes: number,
  signal?: AbortSignal,
): Promise<JobMetrics> {
  return getJson<JobMetrics>(`/api/monitoring/jobs?windowMinutes=${windowMinutes}`, signal);
}

export function fetchSampleHistory(
  windowMinutes: number,
  signal?: AbortSignal,
): Promise<SampleHistory> {
  return getJson<SampleHistory>(
    `/api/monitoring/samples?windowMinutes=${windowMinutes}&limit=600`,
    signal,
  );
}

export async function captureSample(): Promise<void> {
  const response = await fetch("/api/monitoring/sample", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Sample capture returned ${response.status}`);
  }
}
