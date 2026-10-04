export async function fetchHealthStatus(signal) {
  const response = await fetch("/api/health", { signal });
  const body = await response.json();
  if (!response.ok && response.status !== 503) {
    throw new Error(`Backend health check returned ${response.status}`);
  }
  return body;
}
async function getJson(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return await response.json();
}
export function fetchOverview(signal) {
  return getJson("/api/monitoring/overview", signal);
}
export function fetchJobMetrics(windowMinutes, signal) {
  return getJson(`/api/monitoring/jobs?windowMinutes=${windowMinutes}`, signal);
}
export function fetchSampleHistory(windowMinutes, signal) {
  return getJson(
    `/api/monitoring/samples?windowMinutes=${windowMinutes}&limit=600`,
    signal,
  );
}
export async function captureSample() {
  const response = await fetch("/api/monitoring/sample", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Sample capture returned ${response.status}`);
  }
}
async function requestJson(path, init) {
  const response = await fetch(path, init);
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body?.error?.message ?? `${path} returned ${response.status}`;
    throw new Error(message);
  }
  return body;
}
function postJson(path, payload) {
  return requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
export function fetchOrchestratorState(signal) {
  return requestJson("/api/orchestrator/state?limit=120", { signal });
}
export function runOrchestrator(input) {
  return postJson("/api/orchestrator/run", input);
}
const MIXED_COMPUTE_TYPES = [
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
export function generateWorkload(request) {
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
      workloadSize: sleeping
        ? { min: 4, max: 10 }
        : { min: 150_000, max: 300_000 },
      cpuRequiredMillicores: {
        min: request.cpuMillicores,
        max: request.cpuMillicores,
      },
      memoryRequiredMiB: { min: request.memoryMiB, max: request.memoryMiB },
      estimatedDurationSeconds: sleeping
        ? { min: 4, max: 10 }
        : { min: 3, max: 8 },
      priority: { min: 1, max: 10 },
      arrivalOffsetsSeconds: Array.from({ length: request.count }, () => 0),
    },
  });
}
/* Individual pipeline stages, kept available for step-by-step demonstration. */
export function dispatchScheduler(policy, count, timeQuantumSeconds) {
  return postJson("/api/scheduler/dispatch", {
    policy,
    count,
    ...(policy === "ROUND_ROBIN" && timeQuantumSeconds
      ? { timeQuantumSeconds }
      : {}),
  });
}
export function assignPlacement(jobId, strategy) {
  return postJson("/api/placement/assign", { jobId, strategy });
}
export function reserveResources(jobId) {
  return postJson("/api/resources/reserve", { jobId });
}
export function startExecution(jobId) {
  return postJson("/api/executions/start", { jobId });
}
export function releaseResources(jobId) {
  return postJson("/api/resources/release", { jobId });
}
export function cancelJob(jobId) {
  return postJson(`/api/jobs/${jobId}/cancel`, {});
}
export function clearFinishedJobs() {
  return postJson("/api/orchestrator/clear-finished", {});
}
