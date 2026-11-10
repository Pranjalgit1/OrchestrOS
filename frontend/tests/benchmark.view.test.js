import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { allEqual, barWidths, formatMetric, metricBars, percentChange, policyClass, resultSummary, suiteProgress, unfinishedPolicies } from "../src/benchmark.chart.js";

let server;
let BenchmarkView;
let DEFAULT_BENCHMARK_FORM;
let toBenchmarkRequest;
let rerunBenchmarkRequest;
let suiteSetupText;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  ({ BenchmarkView, DEFAULT_BENCHMARK_FORM, toBenchmarkRequest, rerunBenchmarkRequest, suiteSetupText } =
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
  id: `run-${position}`, policy, position, status: "COMPLETED", jobCount: 25, completedJobs: 25,
  failedJobs: 0, workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072, failureReason: null,
  ...overrides,
});
const metric = (key, label, unit, better, values, best) => ({ key, label, unit, better, values, best });
const values = (fcfs, sjf, extra = []) => [{ policy: "FCFS", value: fcfs }, { policy: "SJF", value: sjf }, ...extra];
const twoWay = [
  metric("avgWaitSeconds", "Average waiting time", "s", "lower", values(7.45, 6.66), ["SJF"]),
  metric("p95WaitSeconds", "p95 waiting time", "s", "lower", values(16.06, 12.71), ["SJF"]),
  metric("avgTurnaroundSeconds", "Average turnaround", "s", "lower", values(13.17, 11.93), ["SJF"]),
  metric("p95TurnaroundSeconds", "p95 turnaround", "s", "lower", values(21.86, 20.76), ["SJF"]),
  metric("avgResponseSeconds", "Average response time", "s", "lower", values(7.45, 6.66), ["SJF"]),
  metric("makespanSeconds", "Makespan", "s", "lower", values(22.86, 23.8), ["FCFS"]),
  metric("throughputPerMinute", "Throughput", "jobs/min", "higher", values(65.3, 62.5), ["FCFS"]),
  metric("preemptions", "Preemptions", "", "lower", values(0, 0), []),
];
const suite = {
  id: "11111111-1111-4111-8111-111111111111", status: "ABORTED", jobCount: 25, pattern: "IMMEDIATE",
  seed: 77, placementStrategy: "LEAST_LOADED", timeQuantumSeconds: 5, jobsPerTick: 25, workloadTypes: ["SLEEP"],
  startedAt: "2026-10-22T20:46:00Z", failureReason: "The backend restarted during this benchmark.",
  progress: null, abortRequested: false,
  runs: [run("FCFS", 0), run("SJF", 1),
    run("PRIORITY", 2, { status: "ABORTED", completedJobs: 0, failureReason: "The backend restarted during this benchmark." }),
    run("ROUND_ROBIN", 3, { status: "ABORTED", completedJobs: 0, workerCount: null, cpuCapacityMillicores: null,
      memoryCapacityMiB: null, failureReason: "The backend restarted during this benchmark." })],
  comparison: { comparable: false, fairCapacity: true, identicalWork: true, finishedRuns: 2,
    notes: ["2 run(s) did not complete and are left out."], metrics: twoWay },
};
const view = (props = {}) => renderToStaticMarkup(createElement(BenchmarkView, {
  data: { activeSuiteId: null, suites: [suite] }, selectedId: null, onSelect() {}, onRerun() {},
  form: DEFAULT_BENCHMARK_FORM, onFormChange() {}, onStart() {}, onAbort() {}, unfinishedJobs: 0, ...props,
}));

test("results helpers: change against the baseline, shared-zero bars, and exact ties", () => {
  assert.equal(percentChange(6.66, 7.45), "\u221211%");
  assert.equal(percentChange(23.8, 22.86), "+4%");
  assert.equal(percentChange(5, 0), null, "a percentage of zero means nothing");
  assert.deepEqual(barWidths([{ value: 10 }, { value: 5 }, { value: null }]), [100, 50, 0]);
  assert.equal(allEqual(values(0, 0)), true);
  assert.equal(allEqual(values(1, 2)), false);
  assert.deepEqual(unfinishedPolicies(suite), ["PRIORITY", "ROUND_ROBIN"]);
});

test("the summary names the winner, where it won, and where the other policy did better", () => {
  assert.equal(resultSummary({ metrics: twoWay }),
    "SJF wins 5 of 8 metrics with shorter waits, turnaround and response time. FCFS finished the whole batch 0.94s sooner.");
  assert.match(resultSummary({ metrics: [metric("makespanSeconds", "Makespan", "s", "lower", values(1, 1), [])] }),
    /Every metric was a tie/);
});

test("the page leads with the tabs, title, cluster state, and a compact new-benchmark form", () => {
  const html = view({ modeSwitch: createElement("div", { className: "tabs-here" }) });
  assert.ok(html.indexOf("tabs-here") < html.indexOf("<h1>"), "the tabs sit above the title");
  assert.match(html, /<h1>Scheduling policy comparison<\/h1>/);
  assert.match(html, /class="page-status is-idle"[^>]*><span aria-hidden="true"><\/span>Cluster idle/);
  assert.match(html, /<h2>New benchmark<\/h2>/);
  assert.equal((html.match(/<input type="checkbox" checked=""/g) ?? []).length, 4);
  assert.match(html, /policy-swatch policy-sjf/);
  assert.match(html, /<span aria-hidden="true">sec<\/span>/);
  assert.match(html, /Run 4 policies/);
  assert.match(view({ unfinishedJobs: 3 }), /3 jobs unfinished/);
  assert.match(view({ unfinishedJobs: 3 }), /3 unfinished jobs must finish or be stopped first/);
});

test("a stopped run explains what is missing and offers to run every policy again", () => {
  const html = view();
  assert.match(html, /<h2>Latest run<\/h2>/);
  assert.match(html, /25 jobs · immediate · seed 77 · least loaded · quantum 5s · started /);
  assert.match(html, /<strong>The backend restarted during this benchmark.<\/strong>/);
  assert.match(html, /Priority and Round Robin didn&#x27;t finish and are left out of the results below. Run them again to compare all 4./);
  assert.match(html, />Run all 4 again</);
  assert.match(html, /Not started/);
  assert.match(html, /bench-caution/);
  assert.deepEqual(rerunBenchmarkRequest(suite).policies, ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"]);
  assert.equal(rerunBenchmarkRequest(suite).seed, 77);
  assert.equal(suiteSetupText(suite).startsWith("25 jobs"), true);
});

test("results show a bar per policy, the change against the first, bold winners, and ties in words", () => {
  const html = view();
  assert.match(html, /Results: FCFS vs SJF/);
  assert.match(html, /SJF wins 5 of 8 metrics/);
  assert.doesNotMatch(html, /Results: FCFS vs SJF vs Priority/, "unfinished runs are left out");
  assert.match(html, /<tr class="policy-sjf is-best">/);
  assert.match(html, /<td class="num mono bench-value">6.66s<\/td><td class="num mono bench-diff">\u221211%<\/td>/);
  assert.match(html, /style="width:89.4%"/, "6.66 of 7.45 on a shared zero baseline");
  assert.match(html, /Both 0, no policy preempted a job/);
  assert.match(html, /Difference is relative to FCFS/);
  assert.match(html, /How these are measured/);
});

test("a running suite locks the form, shows progress, and offers stop instead of start", () => {
  const live = { ...suite, status: "RUNNING", failureReason: null,
    runs: [run("FCFS", 0, { status: "RUNNING", completedJobs: 0 }), run("SJF", 1, { status: "PENDING" })],
    progress: { policy: "FCFS", position: 0, totalRuns: 2, finishedJobs: 4, totalJobs: 10 },
    comparison: { ...suite.comparison, finishedRuns: 0, metrics: [] } };
  const html = view({ data: { activeSuiteId: live.id, suites: [live] } });
  assert.match(html, /Benchmark running/);
  assert.match(html, /Running FCFS \(1 of 2\) · 4\/10 jobs finished/);
  assert.match(html, /<progress max="100" value="20"/);
  assert.match(html, /Stop benchmark/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.match(html, /<fieldset class="bench-policies" disabled="">/);
  assert.match(html, /nothing to compare/);
  assert.doesNotMatch(html, /Results:/);
});

test("empty, loading, and no-policy states are distinct", () => {
  assert.match(view({ data: { activeSuiteId: null, suites: [] } }), /No benchmarks yet/);
  assert.match(view({ data: null }), /Loading benchmarks/);
  const none = view({ form: { ...DEFAULT_BENCHMARK_FORM, policies: [] } });
  assert.match(none, /type="submit" class="btn btn-primary" disabled=""/);
  assert.match(none, /Choose at least one policy/);
});
