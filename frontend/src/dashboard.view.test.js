import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let MonitoringView;
let ServiceHealth;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  ({ MonitoringView } = await server.ssrLoadModule("/src/MonitoringPanel.jsx"));
  ({ ServiceHealth } = await server.ssrLoadModule("/src/App.jsx"));
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

test("a failed health check overrides an old healthy response and recovery clears it", () => {
  const health = { status: "ok", dependencies: { database: "up" } };
  const failed = render(ServiceHealth, { health, error: "Request timed out", status: { lastCheckedAt: 1000 } });
  assert.match(failed, /API unavailable/);
  assert.match(failed, /database unknown/);
  assert.doesNotMatch(failed, /database connected/);
  const recovered = render(ServiceHealth, { health, error: null });
  assert.match(recovered, /API online/);
  assert.match(recovered, /database connected/);
  const degraded = render(ServiceHealth, { health: { status: "degraded", dependencies: { database: "down" } } });
  assert.match(degraded, /API degraded/);
  assert.match(degraded, /database down/);
});
