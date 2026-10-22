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
