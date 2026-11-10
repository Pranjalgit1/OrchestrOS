import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
let server;
let app;
let controls;
let WorkerGrid;
let JobDetail;
let pipeline;
let queue;
let consoleModule;
let PageHeader;
let ActivityLog;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  app = await server.ssrLoadModule("/src/App.jsx");
  controls = await server.ssrLoadModule("/src/components/ControlPanel.jsx");
  ({ WorkerGrid } = await server.ssrLoadModule("/src/components/WorkerGrid.jsx"));
  ({ JobDetail } = await server.ssrLoadModule("/src/components/JobDetail.jsx"));
  pipeline = await server.ssrLoadModule("/src/components/PipelineView.jsx");
  queue = await server.ssrLoadModule("/src/components/JobQueue.jsx");
  consoleModule = await server.ssrLoadModule("/src/OrchestratorConsole.jsx");
  ({ PageHeader } = await server.ssrLoadModule("/src/components/PageHeader.jsx"));
  ({ ActivityLog } = await server.ssrLoadModule("/src/components/ActivityLog.jsx"));
});
after(async () => { await server?.close(); });
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};

test("tabs come from the hash, and old section links land on the tab that holds them", () => {
  assert.deepEqual(app.TABS.map(([id]) => id), ["run", "autoscaling", "comparison", "monitoring"]);
  assert.equal(app.tabFromHash("#monitoring"), "monitoring");
  assert.equal(app.tabFromHash("#job-queue"), "run");
  assert.equal(app.tabFromHash("#benchmark"), "comparison");
  assert.equal(app.tabFromHash("#nonsense"), "run");
});

test("number keys switch views, but never while typing or with a modifier", () => {
  const key = (value, extra = {}) => app.shortcutTab({ key: value, target: { tagName: "BODY" }, ...extra });
  assert.equal(key("1"), "run");
  assert.equal(key("3"), "comparison");
  assert.equal(key("5"), null);
  assert.equal(key("a"), null);
  assert.equal(key("2", { target: { tagName: "INPUT" } }), null);
  assert.equal(key("2", { target: { tagName: "SELECT" } }), null);
  assert.equal(key("2", { ctrlKey: true }), null);
});

test("the page header shows the breadcrumb, title, status, and actions", () => {
  const html = render(PageHeader, { crumbs: ["workloads", "run"], title: "Run workload",
    status: { tone: "live", label: "Running" }, subtitle: "3 jobs in history", actions: createElement("button", null, "Go") });
  assert.match(html, /<p class="page-crumbs" aria-label="Location">workloads \/ run<\/p>/);
  assert.match(html, /<h1>Run workload<\/h1>/);
  assert.match(html, /class="page-status is-live"/);
  assert.match(html, /<div class="page-actions"><button>Go<\/button><\/div>/);
});

test("run actions add work, stop everything, and start or pause the orchestrator", () => {
  const idle = render(controls.RunActions, { autoRunning: false, busy: null, workloadOpen: false,
    onToggleWorkload: noop, onKillAll: noop, onToggleAuto: noop });
  assert.match(idle, /aria-expanded="false" aria-controls="workload-panel"[^>]*>.*Add workload/);
  assert.match(idle, /class="btn btn-stop"[^>]*>.*Kill all/);
  assert.match(idle, /class="btn btn-primary"[^>]*>.*Run orchestrator/);
  const running = render(controls.RunActions, { autoRunning: true, busy: null, workloadOpen: true,
    onToggleWorkload: noop, onKillAll: noop, onToggleAuto: noop });
  assert.match(running, />Pause</);
  assert.match(running, /aria-expanded="true"/);
});

test("run settings are one row: policy, placement, and rate; the quantum only for Round Robin", () => {
  const props = { policy: "FCFS", onPolicyChange: noop, strategy: "LEAST_LOADED", onStrategyChange: noop,
    timeQuantumSeconds: 10, onTimeQuantumChange: noop, jobsPerTick: 1, onJobsPerTickChange: noop, busy: null };
  const html = render(controls.RunSettings, props);
  assert.match(html, /class="run-settings"/);
  for (const label of ["Scheduling policy", "Placement", "Jobs started per tick"]) assert.ok(html.includes(label), label);
  assert.match(html, /FCFS — arrival order/);
  assert.match(html, /Least loaded — lowest reserved share/);
  assert.match(html, /1 every 2s — step-by-step demo/);
  assert.doesNotMatch(html, /id="quantum"/);
  assert.match(render(controls.RunSettings, { ...props, policy: "ROUND_ROBIN" }), /id="quantum"/);
});

test("the workload panel keeps generation and cleanup together", () => {
  const html = render(controls.WorkloadPanel, {
    form: { count: 10, arrival: "IMMEDIATE", seed: 42, profile: "SLEEP" }, onFormChange: noop,
    autoRunning: false, busy: null, onGenerate: noop, onDemo: noop, onClearGenerated: noop, onReset: noop,
  });
  assert.match(html, /id="workload-panel"/);
  assert.match(html, /Generate workload/);
  assert.match(html, /Try a demo/);
  assert.match(html, /Clear finished jobs/);
});

test("the pipeline numbers its stages, underlines stages with jobs, and explains early endings", () => {
  const stageCounts = { QUEUE: 0, SCHEDULER: 0, PLACEMENT: 0, RESERVATION: 0, EXECUTION: 1, COMPLETED: 104, TERMINATED: 22 };
  const statusCounts = { FAILED: 1, INTERRUPTED: 1, CANCELLED: 20, COMPLETED: 104 };
  const html = render(pipeline.PipelineView, { stageCounts, statusCounts, selected: null, onShowEnded: noop });
  assert.match(html, /pipeline-step-index">01</);
  assert.match(html, /pipeline-step-index">06</);
  assert.equal((html.match(/pipeline-step has-jobs/g) ?? []).length, 2);
  assert.match(html, /22 jobs didn&#x27;t finish — 1 failed, 1 interrupted, 20 cancelled/);
  assert.match(html, />Show in queue ›</);
  assert.doesNotMatch(render(pipeline.PipelineView, { stageCounts: { ...stageCounts, TERMINATED: 0 }, statusCounts: {}, selected: null }),
    /didn&#x27;t finish/);
});

const worker = (overrides = {}) => ({
  id: "w1", name: "worker-1", status: "IDLE", autoscaled: false, cpuUtilization: 0, memoryUtilization: 0,
  cpuAllocatedMillicores: 0, cpuCapacityMillicores: 500, memoryAllocatedMiB: 0, memoryCapacityMiB: 512,
  runningJobs: [], jobsCompleted: 14, jobsFailed: 1, ...overrides,
});

test("workers are a table with reserved bars, finished attempts, and total capacity", () => {
  const html = render(WorkerGrid, { onSelectJob: noop, settingsHref: "#autoscaling", workers: [
    worker(),
    worker({ id: "w2", name: "auto-worker-1", status: "BUSY", autoscaled: true, cpuAllocatedMillicores: 250,
      cpuCapacityMillicores: 1000, memoryCapacityMiB: 1024, runningJobs: [{ jobId: "j1", jobName: "workload-42-003" }] }),
  ] });
  assert.match(html, /<table class="data-table worker-table">/);
  assert.match(html, /idle · no container/);
  assert.match(html, /busy · <span><button type="button" class="link mono"[^>]*>workload-42-003<\/button>/);
  assert.match(html, />auto</);
  assert.match(html, /0 \/ 500m/);
  assert.match(html, /style="width:25%"/, "250 of 1000m is a quarter bar");
  assert.match(html, /<strong>14<\/strong> ok · 1 fail/);
  assert.match(html, /Total capacity <span class="mono">1500m · 1536 MiB<\/span>/);
  assert.match(html, /href="#autoscaling">Autoscaling settings</);
  assert.doesNotMatch(render(WorkerGrid, { onSelectJob: noop, workers: [worker()] }), /Autoscaling settings/);
});

test("the activity log shows time and what the backend reported", () => {
  const html = render(ActivityLog, { onClear: noop, entries: [{ id: 1, at: "01:11:47", kind: "info", label: "Idle", detail: "Nothing eligible" }] });
  assert.match(html, /<time class="mono">01:11:47<\/time><span><strong>Idle<\/strong> — Nothing eligible<\/span>/);
  assert.match(render(ActivityLog, { onClear: noop, entries: [] }), /No actions yet/);
});

test("the queue reports results honestly and can show every job that ended early", () => {
  assert.equal(queue.resultLabel({ status: "COMPLETED", execution: { status: "COMPLETED", exitCode: 0, elapsedSeconds: 8 } }), "exit 0 · 8s");
  assert.equal(queue.resultLabel({ status: "QUEUED", execution: null }), "waiting");
  assert.equal(queue.resultLabel({ status: "CANCELLED", execution: null }), "not started");
  const job = (status, name) => ({ id: name, name, status, workloadType: "SLEEP", priority: 1,
    estimatedDurationSeconds: 2, cpuRequiredMillicores: 250, memoryRequiredMiB: 64, createdAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-01T10:00:00Z", execution: null });
  const html = render(queue.JobQueue, { jobs: [job("COMPLETED", "a"), job("FAILED", "b"), job("CANCELLED", "c")],
    totalJobs: 126, workers: [], capturedAt: "2026-11-01T10:06:00Z", selectedJobId: null,
    filter: "ENDED", onFilterChange: noop, onSelectJob: noop });
  assert.match(html, /Job queue <span class="count mono">126<\/span>/);
  assert.match(html, /Ended early <span class="mono">2<\/span>/);
  assert.match(html, />b<\/button>/);
  assert.doesNotMatch(html, />a<\/button>/, "the completed job is filtered out");
  assert.match(html, /2 of 3 loaded · 126 total/);
});

test("the run subtitle uses only the state the backend returned", () => {
  const state = { capturedAt: "2026-11-01T01:11:47", totals: { jobs: 126, runningContainers: 0, waitingForArrival: 0 } };
  assert.match(consoleModule.runSubtitle(state, null), /^126 jobs in history · last read \d{2}:\d{2}:\d{2}$/);
  assert.match(consoleModule.runSubtitle({ ...state, totals: { jobs: 1, runningContainers: 2, waitingForArrival: 3 } },
    Date.parse("2026-11-01T01:12:00")), /^1 job in history · 2 running · 3 waiting for arrival time · last tick /);
  assert.equal(consoleModule.runSubtitle(null, null), "Reading jobs, workers, and reserved capacity…");
});

test("job details in the drawer has a labelled close button", () => {
  const job = { id: "j1", name: "workload-42-001", status: "COMPLETED", workloadType: "SLEEP", workloadSize: 4,
    cpuRequiredMillicores: 250, memoryRequiredMiB: 96, priority: 5, estimatedDurationSeconds: 4,
    stage: "COMPLETED", reservation: null, execution: null, result: null };
  const html = render(JobDetail, { job, busy: null, strategy: "FIRST_FIT", onClose: noop });
  assert.match(html, /aria-label="Close job details"/);
  assert.doesNotMatch(render(JobDetail, { job, busy: null, strategy: "FIRST_FIT" }), /Close job details/);
});
