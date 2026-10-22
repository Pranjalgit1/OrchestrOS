import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { formatMetric, metricBars, policyClass, suiteProgress } from "../src/benchmark.chart.js";

let server;
let BenchmarkView;
let DEFAULT_BENCHMARK_FORM;
let toBenchmarkRequest;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  ({ BenchmarkView, DEFAULT_BENCHMARK_FORM, toBenchmarkRequest } =
    await server.ssrLoadModule("/src/components/BenchmarkPanel.jsx"));
});
after(async () => { await server?.close(); });

test("bars share a zero baseline and an unmeasured value gets no bar", () => {
  const chart = metricBars([
    { policy: "FCFS", value: 10 }, { policy: "SJF", value: 5 }, { policy: "PRIORITY", value: null },
  ], { width: 200, barHeight: 20, gap: 10 });
  assert.deepEqual(chart.bars.map((bar) => bar.width), [200, 100, 0]);
  assert.deepEqual(chart.bars.map((bar) => bar.y), [0, 30, 60]);
  assert.equal(chart.bars[2].measured, false);
  assert.equal(chart.height, 80);
  const zeros = metricBars([{ policy: "FCFS", value: 0 }, { policy: "SJF", value: 0 }]);
  assert.ok(zeros.bars.every((bar) => bar.width === 0 && bar.measured), "all-zero does not divide by zero");
});

test("metrics format by unit and never print an unmeasured value as zero", () => {
  assert.equal(formatMetric(null, "s"), "—");
  assert.equal(formatMetric(3.14159, "s"), "3.14s");
  assert.equal(formatMetric(12.345, "jobs/min"), "12.3/min");
  assert.equal(formatMetric(0, ""), "0");
});

test("each policy maps to its own colour class", () => {
  const classes = ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"].map(policyClass);
  assert.equal(new Set(classes).size, 4);
  assert.equal(policyClass("UNKNOWN"), "policy-other");
});

test("progress counts finished runs plus the share of the current one", () => {
  const runs = (statuses) => statuses.map((status, index) => ({ id: String(index), status }));
  assert.equal(suiteProgress({ runs: runs(["COMPLETED", "RUNNING", "PENDING", "PENDING"]),
    progress: { finishedJobs: 5, totalJobs: 10 } }), 0.375);
  assert.equal(suiteProgress({ runs: [] }), 0);
});

test("the request keeps policy order fixed and expands mixed compute", () => {
  const body = toBenchmarkRequest({ ...DEFAULT_BENCHMARK_FORM, policies: ["ROUND_ROBIN", "FCFS"],
    profile: "MIXED_COMPUTE", seed: "7" });
  assert.deepEqual(body.policies, ["FCFS", "ROUND_ROBIN"]);
  assert.equal(body.seed, 7);
  assert.ok(body.workloadTypes.length > 1 && !body.workloadTypes.includes("SLEEP"));
});

const run = (policy, position, overrides = {}) => ({
  id: `run-${position}`, policy, position, status: "COMPLETED", jobCount: 10, completedJobs: 10,
  failedJobs: 0, workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072, failureReason: null,
  ...overrides,
});
const metric = (key, label, unit, better, values, best) => ({ key, label, unit, better, values, best });
const suite = {
  id: "11111111-1111-4111-8111-111111111111", status: "COMPLETED", jobCount: 10, pattern: "IMMEDIATE",
  seed: 42, placementStrategy: "LEAST_LOADED", timeQuantumSeconds: 5, startedAt: "2026-10-22T10:00:00Z",
  failureReason: null, progress: null, abortRequested: false,
  runs: [run("FCFS", 0), run("SJF", 1)],
  comparison: {
    comparable: true, fairCapacity: true, identicalWork: true, finishedRuns: 2, notes: [],
    metrics: [
      metric("avgWaitSeconds", "Average waiting time", "s", "lower",
        [{ policy: "FCFS", value: 8 }, { policy: "SJF", value: 4 }], ["SJF"]),
      metric("makespanSeconds", "Makespan", "s", "lower",
        [{ policy: "FCFS", value: 30 }, { policy: "SJF", value: 30 }], []),
    ],
  },
};
const view = (props = {}) => renderToStaticMarkup(createElement(BenchmarkView, {
  data: { activeSuiteId: null, suites: [suite] }, selectedId: null, onSelect() {},
  form: DEFAULT_BENCHMARK_FORM, onFormChange() {}, onStart() {}, onAbort() {}, ...props,
}));

test("a finished suite shows a table and charts with the best value marked in text", () => {
  const html = view();
  assert.match(html, /Benchmark/);
  assert.match(html, /byte-identical work/);
  assert.match(html, /<td class="is-best">4.00s<span class="bench-best"> best<\/span><\/td>/);
  assert.match(html, /aria-label="Average waiting time: FCFS 8.00s, SJF 4.00s. Best: SJF."/);
  assert.match(html, /aria-label="Makespan: FCFS 30.00s, SJF 30.00s. No single winner."/);
  assert.match(html, /class="bench-bar policy-sjf is-best"/);
  assert.match(html, /class="bench-bar policy-fcfs"/, "every policy keeps its own colour");
  assert.match(html, /<h2>Policy comparison<\/h2>/);
  assert.match(html, /class="bench-legend"/);
  assert.match(html, /<span class="policy-swatch policy-sjf" aria-hidden="true"><\/span>SJF/);
  assert.match(html, /Run 4 policies/);
});

test("a running suite locks the form, shows progress, and offers stop instead of start", () => {
  const live = { ...suite, status: "RUNNING",
    runs: [run("FCFS", 0, { status: "RUNNING", completedJobs: 0 }), run("SJF", 1, { status: "PENDING" })],
    progress: { policy: "FCFS", position: 0, totalRuns: 2, finishedJobs: 4, totalJobs: 10 },
    comparison: { ...suite.comparison, finishedRuns: 0, metrics: [] } };
  const html = view({ data: { activeSuiteId: live.id, suites: [live] } });
  assert.match(html, /Running FCFS \(1 of 2\) · 4\/10 jobs finished/);
  assert.match(html, /<progress max="100" value="20"/);
  assert.match(html, /Stop benchmark/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.match(html, /<fieldset class="bench-policies" disabled="">/);
  assert.match(html, /nothing to compare/);
});

test("an unfair suite explains why and lists failed runs; empty and loading states are distinct", () => {
  const unfair = { ...suite, status: "FAILED", failureReason: "Docker is not reachable",
    runs: [run("FCFS", 0), run("SJF", 1, { status: "FAILED", failureReason: "Docker is not reachable" })],
    comparison: { ...suite.comparison, comparable: false, finishedRuns: 1,
      notes: ["1 run(s) did not complete and are left out."] } };
  const html = view({ data: { activeSuiteId: null, suites: [unfair] } });
  assert.match(html, /bench-caution/);
  assert.match(html, /did not complete and are left out/);
  assert.match(html, /Docker is not reachable/);
  assert.doesNotMatch(html, /bench-charts/, "one finished run has nothing to chart against");
  assert.doesNotMatch(html, /bench-legend/);
  assert.match(view({ data: { activeSuiteId: null, suites: [] } }), /No benchmarks yet/);
  assert.match(view({ data: null }), /Loading benchmarks/);
  assert.match(view({ form: { ...DEFAULT_BENCHMARK_FORM, policies: [] } }), /type="submit" class="btn btn-primary" disabled=""/);
});
