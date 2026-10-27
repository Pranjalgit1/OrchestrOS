import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let AutoscalerView;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  ({ AutoscalerView } = await server.ssrLoadModule("/src/components/AutoscalerPanel.jsx"));
});
after(async () => { await server?.close(); });

const config = {
  enabled: false, maxWorkers: 3, workerCpuMillicores: 1000, workerMemoryMiB: 512,
  scaleUpQueueThreshold: 2, scaleUpUtilization: 0.75, scaleDownUtilization: 0.4,
  idleSeconds: 30, cooldownSeconds: 15,
};
const status = (overrides = {}) => ({
  config, pausedReason: null, loop: { enabled: true, intervalSeconds: 5 }, events: [],
  lastDecision: {
    action: "NONE", reason: "Autoscaling is off", applied: false, evaluatedAt: "2026-10-22T13:40:11Z",
    signals: { queuedJobs: 4, utilization: { cpu: 0.5, memory: 0.25 }, workerCount: 3, autoscaledWorkers: 1 },
  },
  ...overrides,
});
const render = (props) => renderToStaticMarkup(createElement(AutoscalerView, props));

test("the switch states the current setting and uses red for off, green for on", () => {
  const off = render({ status: status() });
  assert.match(off, /role="switch" aria-checked="false" class="btn autoscale-switch btn-stop"/);
  assert.match(off, /Autoscaling: Off/);
  const on = render({ status: status({ config: { ...config, enabled: true } }) });
  assert.match(on, /aria-checked="true" class="btn autoscale-switch btn-go"/);
  assert.match(on, /Autoscaling: On/);
});

test("scaling is automatic: there is no manual evaluate button", () => {
  const html = render({ status: status() });
  assert.doesNotMatch(html, /Evaluate now/);
  assert.match(html, /Checked automatically every 5s/);
});

test("signals are four compact stats and the rules stay inside a collapsed section", () => {
  const html = render({ status: status() });
  const stats = html.match(/<dl class="autoscaler-stats">([\s\S]*?)<\/dl>/)[1];
  assert.deepEqual([...stats.matchAll(/<dd>(\d+%?)/g)].map((match) => match[1]), ["4", "50%", "25%", "3"]);
  assert.match(stats, /<small>1 of 3 extra<\/small>/);
  assert.match(html, /<strong>No change<\/strong><span>Autoscaling is off<\/span>/);
  const rules = html.indexOf("<summary>Rules and thresholds</summary>");
  assert.ok(rules > 0 && html.indexOf("Adds a ") > rules, "the rule sentence is inside the details");
});

test("missing signals show dashes, and a benchmark hold is explained", () => {
  const html = render({ status: status({ lastDecision: null, pausedReason: "a policy benchmark needs fixed capacity" }) });
  assert.equal((html.match(/<dd>—/g) ?? []).length, 4);
  assert.match(html, /No evaluation yet/);
  assert.match(html, /Held while a policy benchmark needs fixed capacity/);
  assert.match(render({ status: null }), /Loading autoscaler/);
});

const mlStatus = (overrides = {}) => status({
  config: { ...config, strategy: "ML", mlWindowPoints: 20, mlLookAheadSeconds: 60 },
  forecast: { queuedJobs: 3.25, peak: 0.82, queueSlopePerMinute: 1.5, lookAheadSeconds: 60, points: 6 },
  loadHistory: [0, 1, 1, 2, 3, 3].map((queuedJobs, index) => ({
    at: `2026-10-22T13:40:${String(index * 5).padStart(2, "0")}Z`, queuedJobs, peak: 0.5,
  })),
  ...overrides,
});

test("the strategy control selects exactly one of Reactive or ML predictive", () => {
  const reactive = render({ status: status() });
  assert.match(reactive, /<legend class="sr-only">Scaling strategy<\/legend>/);
  assert.match(reactive, /checked="" value="REACTIVE"/);
  assert.doesNotMatch(reactive, /checked="" value="ML"/);
  assert.match(reactive, /predicted 60s ahead from the last 20 checks/,
    "settings missing from an older backend fall back to defaults");
  assert.match(reactive, /Reactive autoscaling/);
  assert.doesNotMatch(reactive, /Forecast/, "the forecast only shows for the ML strategy");
  const ml = render({ status: mlStatus() });
  assert.match(ml, /checked="" value="ML"/);
  assert.match(ml, /ML-assisted autoscaling/);
});

test("the ML strategy shows its forecast, or that it is still collecting history", () => {
  const html = render({ status: mlStatus() });
  assert.match(html, /<strong>Forecast in 60s<\/strong>/);
  assert.match(html, /3\.3 waiting · 82% reserved · queue rising 1\.5 jobs\/min/);
  assert.match(html, /Linear regression over the last 6 checks/);
  assert.match(html, /<svg class="forecast-sparkline"[^>]*aria-hidden="true"/);
  const warming = render({ status: mlStatus({ forecast: null, loadHistory: [] }) });
  assert.match(warming, /Collecting load history \(0\/3 points\)/);
});

test("scaling history labels which strategy made each change", () => {
  const events = [
    { id: "1", createdAt: "2026-10-22T13:41:00Z", action: "SCALE_UP", workerName: "auto-worker-2",
      queuedJobs: 1, cpuUtilization: 0.5, memoryUtilization: 0.4, reason: "[ML] Forecast 4.0 job(s) waiting" },
    { id: "2", createdAt: "2026-10-22T13:40:00Z", action: "SCALE_UP", workerName: "auto-worker-1",
      queuedJobs: 4, cpuUtilization: 0.9, memoryUtilization: 0.4, reason: "4 job(s) waiting" },
  ];
  const html = render({ status: status({ events }) });
  const rows = [...html.matchAll(/<tr><td><time[^>]*>[^<]*<\/time><\/td><td>([^<]+)<\/td>/g)].map((match) => match[1]);
  assert.deepEqual(rows, ["ML", "Reactive"]);
  assert.match(html, /<th scope="col">Strategy<\/th>/);
});

test("the ML settings are editable alongside the shared thresholds", () => {
  const html = render({ status: mlStatus() });
  assert.match(html, /id="autoscale-mlWindowPoints"[^>]*value="20"/);
  assert.match(html, /id="autoscale-mlLookAheadSeconds"[^>]*value="60"/);
  const tuned = render({ status: mlStatus({ config: { ...config, strategy: "ML", mlWindowPoints: 8, mlLookAheadSeconds: 30 } }) });
  assert.match(tuned, /id="autoscale-mlWindowPoints"[^>]*value="8"/);
  assert.match(html, /predicted 60s ahead from the last 20 checks/);
});
