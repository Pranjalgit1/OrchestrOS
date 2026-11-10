import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let MonitoringView;
let app;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  ({ MonitoringView } = await server.ssrLoadModule("/src/MonitoringPanel.jsx"));
  app = await server.ssrLoadModule("/src/App.jsx");
});
after(async () => { await server?.close(); });

const overview = {
  capturedAt: "2026-10-11T12:00:00Z",
  cluster: { cpuUtilization: 0, memoryUtilization: 0, cpuCapacityMillicores: 500,
    cpuAllocatedMillicores: 0, memoryCapacityMiB: 512, memoryAllocatedMiB: 0 },
  queue: { total: 0, waitingToRun: 0, active: 0, finished: 0, byStatus: {} },
  reservations: { active: 0 }, executions: { running: [] }, workers: [], samples: { stored: 0, latestAt: null },
};
const jobs = { windowMinutes: 60, terminalInWindow: 0, completionsPerMinute: 0, successRate: null, timings: {} };
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const monitoring = (props = {}) => render(MonitoringView, { overview, jobs: null, history: null, ...props });
const throughput = (html) => html.match(/<h3>Throughput[\s\S]*?<\/article>/)[0];

test("pending and failed job metrics do not claim a measured zero", () => {
  const pending = throughput(monitoring());
  assert.match(pending, /<dd>—<\/dd>/);
  assert.doesNotMatch(pending, /<dd>0<\/dd>/);
  assert.match(pending, /Loading job metrics/);
  const failed = throughput(monitoring({ readStatus: { jobs: { error: "Request timed out" } } }));
  assert.match(failed, /Job metrics unavailable/);
  assert.doesNotMatch(failed, /<dd>0<\/dd>/);
});

test("real zero metrics remain zero; failed refreshes identify saved values", () => {
  assert.match(throughput(monitoring({ jobs })), /<dd>0<\/dd>/);
  const saved = throughput(monitoring({ jobs: { ...jobs, terminalInWindow: 7 },
    readStatus: { jobs: { error: "Request failed", lastSuccessAt: Date.parse(overview.capturedAt) } } }));
  assert.match(saved, /<dd>7<\/dd>/);
  assert.match(saved, /Showing the last successful read/);
  assert.match(saved, /Last read/);
});

test("history exposes reservation units, actual time spacing and numerical sample values", () => {
  const history = { windowMinutes: 60, pointCount: 3, points: [
    { capturedAt: "2026-10-11T11:00:00Z", cpuUtilization: 0.2, memoryUtilization: 0.1 },
    { capturedAt: "2026-10-11T11:00:15Z", cpuUtilization: 0.5, memoryUtilization: 0.25 },
    { capturedAt: "2026-10-11T12:00:00Z", cpuUtilization: 0.1, memoryUtilization: 0.05 },
  ] };
  const html = monitoring({ jobs, history });
  assert.match(html, /M0.0,72.0 L2.5,45.0 L600.0,81.0/);
  assert.match(html, /percentages of worker capacity/);
  assert.match(html, /Time between samples is unmeasured/);
  assert.match(html, /CPU reserved \(%\)/);
  assert.match(html, /dateTime="2026-10-11T11:00:15Z"/i);
  assert.match(html, /<td>50%<\/td><td>25%<\/td>/);
});

test("an empty or single-sample chart does not promise an enabled sampler", () => {
  const empty = monitoring({ history: { windowMinutes: 60, pointCount: 0, points: [] } });
  assert.match(empty, /No recorded samples in this window/);
  assert.match(empty, /Use Save snapshot/);
  assert.doesNotMatch(empty, /sampler writes/);
  const single = monitoring({ history: { windowMinutes: 60, pointCount: 1, points: [
    { capturedAt: overview.capturedAt, cpuUtilization: 0.5, memoryUtilization: 0.25 },
  ] } });
  assert.match(single, /spark-point-cpu/);
  assert.match(single, /<td>50%<\/td>/);
});

test("capacity, queue, throughput, and running containers share one 2 × 2 block", () => {
  const html = monitoring({ jobs });
  const block = html.match(/<div class="monitor-grid quad">([\s\S]*?)<article class="tile wide">/)[1];
  const titles = [...block.matchAll(/<h3>([^<]+)/g)].map((match) => match[1]);
  assert.deepEqual(titles, ["Reserved capacity", "Queue", "Throughput (60 min)", "Running now"]);
  assert.match(html, /<article class="tile timings-tile"><h3>Lifecycle timings<\/h3>/);
});

test("a failed health check overrides an old healthy response and recovery clears it", () => {
  const health = { status: "ok", dependencies: { database: "up" } };
  const rows = (input, extra) => Object.fromEntries(app.serviceRows(app.systemStatus(input), extra)
    .map((row) => [row.key, row]));
  const failed = rows({ health, healthError: "Request timed out", runtime: {} }, { latencyMs: 12 });
  assert.equal(failed.api.value, "down", "an old healthy response does not keep the API up");
  assert.equal(failed.database.value, "unknown");
  const recovered = rows({ health, runtime: {} }, { latencyMs: 12, runningContainers: 0, workerCount: 3 });
  assert.equal(recovered.api.value, "12ms", "the measured round trip");
  assert.equal(recovered.database.value, "up");
  assert.equal(recovered.docker.value, "0 / 3", "running containers / workers in service");
  const degraded = rows({ health: { status: "degraded", dependencies: { database: "down" } }, runtimeError: "Docker: 503" });
  assert.equal(degraded.database.state, "down");
  assert.equal(degraded.docker.value, "down");
  assert.equal(rows({}).api.value, "…", "nothing is claimed before the first check");
});