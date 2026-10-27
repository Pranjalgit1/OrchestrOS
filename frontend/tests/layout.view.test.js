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
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  app = await server.ssrLoadModule("/src/App.jsx");
  controls = await server.ssrLoadModule("/src/components/ControlPanel.jsx");
  ({ WorkerGrid } = await server.ssrLoadModule("/src/components/WorkerGrid.jsx"));
  ({ JobDetail } = await server.ssrLoadModule("/src/components/JobDetail.jsx"));
});
after(async () => { await server?.close(); });

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};

test("tabs come from the hash, and old section links land on the tab that holds them", () => {
  assert.deepEqual(app.TABS.map(([id]) => id), ["run", "autoscaling", "comparison", "monitoring"]);
  assert.equal(app.tabFromHash("#monitoring"), "monitoring");
  assert.equal(app.tabFromHash("#comparison"), "comparison");
  assert.equal(app.tabFromHash("#job-queue"), "run");
  assert.equal(app.tabFromHash("#benchmark"), "comparison");
  assert.equal(app.tabFromHash(""), "run");
  assert.equal(app.tabFromHash("#nonsense"), "run");
});

const runBar = (props = {}) => render(controls.RunBar, {
  policy: "FCFS", onPolicyChange: noop, strategy: "LEAST_LOADED", onStrategyChange: noop,
  timeQuantumSeconds: 10, onTimeQuantumChange: noop, jobsPerTick: 1, onJobsPerTickChange: noop,
  autoRunning: false, busy: null, onKillAll: noop, onToggleAuto: noop, workloadOpen: false,
  onToggleWorkload: noop, ...props,
});

test("the run bar holds policy, placement, rate, and start/stop in one row", () => {
  const idle = runBar();
  assert.match(idle, /class="run-bar"/);
  assert.match(idle, /class="btn btn-primary"[^>]*>.*Run orchestrator/);
  assert.match(idle, /class="btn btn-stop"[^>]*>.*Kill all/);
  assert.match(idle, /aria-expanded="false" aria-controls="workload-panel"/);
  assert.doesNotMatch(idle, /id="quantum"/, "the quantum only appears for Round Robin");
  const running = runBar({ autoRunning: true, policy: "ROUND_ROBIN", workloadOpen: true });
  assert.match(running, /id="quantum"/);
  assert.match(running, />Pause</);
  assert.match(running, /aria-expanded="true"/);
  assert.match(running, /run-state is-running/);
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

test("worker cards carry finished attempts, so Monitoring needs no second worker table", () => {
  const html = render(WorkerGrid, { onSelectJob: noop, workers: [{
    id: "w1", name: "worker-1", status: "IDLE", autoscaled: false, cpuUtilization: 0, memoryUtilization: 0,
    cpuAllocatedMillicores: 0, cpuCapacityMillicores: 500, memoryAllocatedMiB: 0, memoryCapacityMiB: 512,
    runningJobs: [], jobsCompleted: 11, jobsFailed: 2,
  }] });
  assert.match(html, /11 completed · 2 failed/);
});

test("job details in the drawer has a labelled close button", () => {
  const job = { id: "j1", name: "workload-42-001", status: "COMPLETED", workloadType: "SLEEP", workloadSize: 4,
    cpuRequiredMillicores: 250, memoryRequiredMiB: 96, priority: 5, estimatedDurationSeconds: 4,
    stage: "COMPLETED", reservation: null, execution: null, result: null };
  const html = render(JobDetail, { job, busy: null, strategy: "FIRST_FIT", onClose: noop });
  assert.match(html, /aria-label="Close job details"/);
  assert.doesNotMatch(render(JobDetail, { job, busy: null, strategy: "FIRST_FIT" }), /Close job details/);
});
