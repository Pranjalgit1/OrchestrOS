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

/* ------------------------------------------------------------------ */
/* Orchestrator control surface                                        */
/* ------------------------------------------------------------------ */

export type SchedulingPolicy = "FCFS" | "SJF" | "PRIORITY" | "ROUND_ROBIN";
export type PlacementStrategy = "FIRST_FIT" | "LEAST_LOADED" | "RESOURCE_AWARE";
export type WorkloadTypeName =
  | "CPU_INTENSIVE"
  | "MATRIX_MULTIPLICATION"
  | "SORTING"
  | "DATA_PROCESSING"
  | "SLEEP";

export type PipelineStage =
  | "QUEUE"
  | "SCHEDULER"
  | "PLACEMENT"
  | "RESERVATION"
  | "EXECUTION"
  | "COMPLETED"
  | "TERMINATED";

export interface JobStateView {
  id: string;
  name: string;
  workloadType: string;
  workloadSize: number;
  cpuRequiredMillicores: number;
  memoryRequiredMiB: number;
  priority: number;
  estimatedDurationSeconds: number;
  status: string;
  stage: PipelineStage;
  arrivalAt: string;
  eligibleNow: boolean;
  secondsUntilEligible: number;
  schedulingPolicy: string | null;
  placementStrategy: string | null;
  assignedWorkerId: string | null;
  assignedWorkerName: string | null;
  reservation: { cpuMillicores: number; memoryMiB: number; reservedAt: string } | null;
  execution: {
    id: string;
    status: string;
    attempt: number;
    containerId: string | null;
    containerShortId: string | null;
    startedAt: string | null;
    completedAt: string | null;
    elapsedSeconds: number | null;
    exitCode: number | null;
    failureReason: string | null;
  } | null;
  result: {
    checksum?: string;
    operations?: number;
    effectiveSize?: number;
    runnerDurationMs?: number;
  } | null;
  failureReason: string | null;
}

export interface WorkerStateView {
  id: string;
  name: string;
  status: string;
  cpuCapacityMillicores: number;
  cpuAllocatedMillicores: number;
  cpuUtilization: number;
  memoryCapacityMiB: number;
  memoryAllocatedMiB: number;
  memoryUtilization: number;
  runningJobs: { jobId: string; jobName: string; containerShortId: string | null }[];
}

export interface OrchestratorState {
  capturedAt: string;
  jobs: JobStateView[];
  workers: WorkerStateView[];
  stageCounts: Record<PipelineStage, number>;
  statusCounts: Record<string, number>;
  totals: {
    jobs: number;
    eligibleNow: number;
    waitingForArrival: number;
    activeReservations: number;
    runningContainers: number;
  };
}

export interface StageOutcome {
  stage: "SCHEDULE" | "PLACEMENT" | "RESERVATION" | "EXECUTION";
  status: "OK" | "SKIPPED" | "FAILED";
  detail: string;
  code: string | null;
}

export interface RunStepResult {
  advanced: boolean;
  jobId: string | null;
  jobName: string | null;
  stages: StageOutcome[];
  worker: { id: string; name: string } | null;
  reservation: { cpuMillicores: number; memoryMiB: number; lockWaitMs: number } | null;
  execution: {
    id: string;
    containerId: string;
    image: string;
    timeoutSeconds: number;
  } | null;
  stoppedBecause: string | null;
}

export interface RunOrchestratorResult {
  policy: SchedulingPolicy;
  strategy: PlacementStrategy;
  requested: number;
  startedCount: number;
  steps: RunStepResult[];
  stoppedBecause: string | null;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      (body as { error?: { message?: string; code?: string } } | null)?.error?.message ??
      `${path} returned ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchOrchestratorState(signal?: AbortSignal): Promise<OrchestratorState> {
  return requestJson<OrchestratorState>("/api/orchestrator/state?limit=120", { signal });
}

export function runOrchestrator(input: {
  policy: SchedulingPolicy;
  strategy: PlacementStrategy;
  maxJobs: number;
  timeQuantumSeconds?: number;
}): Promise<RunOrchestratorResult> {
  return postJson<RunOrchestratorResult>("/api/orchestrator/run", input);
}

/** Arrival spacing choices. `IMMEDIATE` uses the CUSTOM pattern with zero offsets. */
export type ArrivalChoice =
  | "IMMEDIATE"
  | "LIGHT"
  | "MEDIUM"
  | "HEAVY"
  | "CONSTANT"
  | "BURST"
  | "INCREASING"
  | "DECREASING"
  | "PERIODIC";

export interface GenerateWorkloadRequest {
  count: 10 | 25 | 50 | 100;
  arrival: ArrivalChoice;
  seed: number;
  /** Only used by the IMMEDIATE preset, which drives the CUSTOM pattern. */
  profile: "SLEEP" | "MIXED_COMPUTE";
  cpuMillicores: number;
  memoryMiB: number;
}

const MIXED_COMPUTE_TYPES: WorkloadTypeName[] = [
  "CPU_INTENSIVE",
  "MATRIX_MULTIPLICATION",
  "SORTING",
  "DATA_PROCESSING",
];

/**
 * Builds the existing generate request from form values.
 *
 * The generator itself stays in the backend; this only fills in the request the
 * API already accepts. `IMMEDIATE` is the CUSTOM pattern with every arrival
 * offset set to zero, so nothing has to wait before it is eligible.
 */
export function generateWorkload(
  request: GenerateWorkloadRequest,
): Promise<{ id: string; seed: number; jobCount: number; pattern: string }> {
  if (request.arrival !== "IMMEDIATE") {
    return postJson("/api/workloads/generate", {
      seed: request.seed,
      count: request.count,
      pattern: request.arrival,
    });
  }

  const sleeping = request.profile === "SLEEP";

  return postJson("/api/workloads/generate", {
    seed: request.seed,
    count: request.count,
    pattern: "CUSTOM",
    custom: {
      workloadTypes: sleeping ? ["SLEEP"] : MIXED_COMPUTE_TYPES,
      // For SLEEP the runner reads size as seconds; for compute types it is work units.
      workloadSize: sleeping ? { min: 4, max: 10 } : { min: 150_000, max: 300_000 },
      cpuRequiredMillicores: { min: request.cpuMillicores, max: request.cpuMillicores },
      memoryRequiredMiB: { min: request.memoryMiB, max: request.memoryMiB },
      estimatedDurationSeconds: sleeping ? { min: 4, max: 10 } : { min: 3, max: 8 },
      priority: { min: 1, max: 10 },
      arrivalOffsetsSeconds: Array.from({ length: request.count }, () => 0),
    },
  });
}

/* Individual pipeline stages, kept available for step-by-step demonstration. */

export function dispatchScheduler(
  policy: SchedulingPolicy,
  count: number,
  timeQuantumSeconds?: number,
): Promise<unknown> {
  return postJson("/api/scheduler/dispatch", {
    policy,
    count,
    ...(policy === "ROUND_ROBIN" && timeQuantumSeconds ? { timeQuantumSeconds } : {}),
  });
}

export function assignPlacement(
  jobId: string,
  strategy: PlacementStrategy,
): Promise<unknown> {
  return postJson("/api/placement/assign", { jobId, strategy });
}

export function reserveResources(jobId: string): Promise<unknown> {
  return postJson("/api/resources/reserve", { jobId });
}

export function startExecution(jobId: string): Promise<unknown> {
  return postJson("/api/executions/start", { jobId });
}

export function releaseResources(jobId: string): Promise<unknown> {
  return postJson("/api/resources/release", { jobId });
}

export function cancelJob(jobId: string): Promise<unknown> {
  return postJson(`/api/jobs/${jobId}/cancel`, {});
}

export function clearFinishedJobs(): Promise<{
  deletedJobs: number;
  deletedExecutions: number;
}> {
  return postJson("/api/orchestrator/clear-finished", {});
}
