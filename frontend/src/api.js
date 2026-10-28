export const STATE_CHANGED_EVENT = "orchestros:state-changed";

export async function fetchHealthStatus(signal) {
  const response = await fetch("/api/health", { signal });
  const body = await response.json();
  if (!response.ok && response.status !== 503) {
    throw new Error(`Backend health check returned ${response.status}`);
  }
  return body;
}
async function getJson(path, signal) {
  const response = await fetch(path, { signal, cache: "no-store" });
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
async function postJson(path, payload) {
  const result = await requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(STATE_CHANGED_EVENT));
  }
  return result;
}
export function fetchOrchestratorState(signal) {
  return requestJson("/api/orchestrator/state?limit=120", { signal, cache: "no-store" });
}
export function runOrchestrator(input) {
  return postJson("/api/orchestrator/run", input);
}
export const MIXED_COMPUTE_TYPES = [
  "CPU_INTENSIVE",
  "MATRIX_MULTIPLICATION",
  "SORTING",
  "DATA_PROCESSING",
];
/** The backend owns resource profiles and derives work units for each type. */
export function generateWorkload(request) {
  return postJson("/api/workloads/generate", {
    seed: request.seed,
    count: request.count,
    pattern: request.arrival,
    workloadTypes: request.profile === "MIXED_COMPUTE"
      ? MIXED_COMPUTE_TYPES
      : [request.profile],
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
export function requeueJob(jobId) {
  return postJson(`/api/jobs/${jobId}/requeue`, {});
}
export function fetchAutoscaler(signal) {
  return requestJson("/api/autoscaler", { signal, cache: "no-store" });
}
export async function updateAutoscaler(patch) {
  const result = await requestJson("/api/autoscaler", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(STATE_CHANGED_EVENT));
  }
  return result;
}
export function clearFinishedJobs() {
  return postJson("/api/orchestrator/clear-finished", {});
}
export function clearGeneratedWorkload() {
  return postJson("/api/workloads/clear-generated", {});
}
export function killAllWorkloads() {
  return postJson("/api/orchestrator/kill-all", {});
}
/* Multi-policy benchmarks: the backend runs the suite; the browser only starts, polls, and stops it. */
export function fetchBenchmarks(signal) {
  return requestJson("/api/benchmarks?limit=10", { signal, cache: "no-store" });
}
export function startBenchmark(input) {
  return postJson("/api/benchmarks", input);
}
export function abortBenchmark(id) {
  return postJson(`/api/benchmarks/${id}/abort`, {});
}
/* Reactive-vs-ML autoscaling comparisons: same pattern as the benchmarks. */
export function fetchScalingComparisons(signal) {
  return requestJson("/api/scaling-comparisons?limit=10", { signal, cache: "no-store" });
}
export function fetchScalingComparison(id, signal) {
  return requestJson(`/api/scaling-comparisons/${id}`, { signal, cache: "no-store" });
}
export function startScalingComparison(input) {
  return postJson("/api/scaling-comparisons", input);
}
export function abortScalingComparison(id) {
  return postJson(`/api/scaling-comparisons/${id}/abort`, {});
}
