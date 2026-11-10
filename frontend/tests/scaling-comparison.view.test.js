import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  CHART_METRICS,
  buildChart,
  comparisonProgress,
  exportFileName,
  forecastPoints,
  formatSeconds,
  formatValue,
  headline,
  hoverTimes,
  keyTakeaway,
  nearestTimeIndex,
  pointAt,
  reactionText,
  runPoints,
  summaryRows,
  timeTicks,
  tooltipLeft,
  valueTicks,
  winnerText,
} from "../src/scaling.chart.js";

let server;
let panel;
let ComparisonModeSwitch;
let ScalingChart;
let app;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  panel = await server.ssrLoadModule("/src/components/ScalingComparisonPanel.jsx");
  ({ ComparisonModeSwitch } = await server.ssrLoadModule("/src/components/ComparisonTab.jsx"));
  ({ ScalingChart } = await server.ssrLoadModule("/src/components/ScalingChart.jsx"));
  app = await server.ssrLoadModule("/src/App.jsx");
});
after(async () => { await server?.close(); });

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const start = "2026-11-01T10:00:00.000Z";

// ---------------------------------------------------------------- wording and numbers

test("values read in plain units and an unmeasured value is N/A, never zero", () => {
  assert.equal(formatSeconds(null), "N/A");
  assert.equal(formatSeconds(12.34), "12.3s");
  assert.equal(formatSeconds(245), "4m 05s");
  assert.equal(formatValue(118.6, "worker-s"), "119 worker-s");
  assert.equal(formatValue(0, "count"), "0");
  assert.equal(formatValue(undefined, "s"), "N/A");
  assert.equal(reactionText("BEFORE_ANY_BACKLOG", null), "Before any backlog formed");
  assert.equal(reactionText("MEASURED", -4), "4.0s before the backlog");
});

test("winner text measures the winner against the strategy that lost", () => {
  assert.equal(winnerText({ key: "extraWorkerSeconds", winner: "REACTIVE", reactive: 200, ml: 300, better: "lower" }),
    "Reactive · 33% less");
  assert.equal(winnerText({ key: "avgWaitSeconds", winner: "TIE" }), "About the same");
  assert.equal(winnerText({ key: "avgWaitSeconds", winner: null }), "—");
});

const metric = (key, reactive, ml, winner, change = null, extra = {}) =>
  ({ key, group: "wait", label: key, unit: "s", better: "lower", reactive, ml, winner, change, ...extra });

test("the key takeaway adapts to the measured result and quotes the numbers", () => {
  const reactiveFaster = keyTakeaway({ waitVerdict: "REACTIVE", costVerdict: "ML", metrics: [
    metric("avgWaitSeconds", 6.3, 8.6, "REACTIVE"),
    { ...metric("extraWorkerSeconds", 18, 0, "ML"), unit: "worker-s" },
  ] });
  assert.equal(reactiveFaster.title, "Reactive was faster. ML-assisted used less capacity.");
  assert.equal(reactiveFaster.tone, "tradeoff");
  assert.deepEqual(reactiveFaster.points, [
    "Reactive kept average wait 27% shorter (6.3s vs 8.6s).",
    "ML-assisted needed 18 fewer extra worker-seconds.",
  ]);
  const mlBetter = keyTakeaway({ waitVerdict: "ML", costVerdict: "TIE", metrics: [
    metric("avgWaitSeconds", 2.5, 1.9, "ML"), metric("extraWorkerSeconds", 30, 31, "TIE"),
  ] });
  assert.equal(mlBetter.title, "ML-assisted did better on this workload.");
  assert.match(mlBetter.points[1], /about the same extra capacity \(30 and 31 worker-seconds\)/);
  assert.deepEqual(keyTakeaway({ waitVerdict: null }).points, []);
  assert.equal(headline({ waitVerdict: "TIE", costVerdict: "TIE" }).tone, "tie");
});

const run = (strategy, overrides = {}) => ({
  id: `r-${strategy}`, strategy, status: "COMPLETED", jobCount: 25, completedJobs: 25, startedAt: start,
  workerCount: 3, cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072, failureReason: null,
  avgWaitSeconds: 6.3, p95WaitSeconds: 14.4, avgTurnaroundSeconds: 12.6, makespanSeconds: 22.7,
  extraWorkerSeconds: 18, peakWorkers: 4, scaleUps: 1, scaleDowns: 0, samples: [], ...overrides,
});

test("result rows compare seconds as a percentage and counts as an absolute difference", () => {
  const comparison = { metrics: [
    metric("avgWaitSeconds", 6.3, 8.6, "REACTIVE", 0.365),
    { ...metric("extraWorkerSeconds", 18, 0, "ML"), unit: "worker-s" },
    { ...metric("scaleActions", 1, 0, "ML"), unit: "count" },
  ] };
  const rows = Object.fromEntries(summaryRows(comparison, [run("REACTIVE"), run("ML", { peakWorkers: 3 })])
    .map((row) => [row.key, row]));
  assert.equal(rows.avgWaitSeconds.difference, "+37%");
  assert.equal(rows.avgWaitSeconds.direction, "up");
  assert.equal(rows.avgWaitSeconds.winner, "REACTIVE");
  assert.equal(rows.extraWorkerSeconds.difference, "\u221218", "a percentage of zero would mean nothing");
  assert.equal(rows.extraWorkerSeconds.reactiveText, "18");
  assert.equal(rows.extraWorkerSeconds.label, "Extra capacity");
  assert.equal(rows.extraWorkerSeconds.unitNote, "worker-s");
  assert.equal(rows.peakWorkers.difference, "\u22121");
  assert.equal(rows.peakWorkers.winner, "ML", "fewer peak workers is better, judged by the backend's 5% rule");
  assert.equal(rows.p95WaitSeconds.reactiveText, "14.4s", "falls back to the stored run record");
  const samePeak = summaryRows(comparison, [run("REACTIVE"), run("ML")]).find((row) => row.key === "peakWorkers");
  assert.equal(samePeak.winner, "TIE");
  const unfinished = Object.fromEntries(summaryRows({ metrics: [] }, [run("REACTIVE"), run("ML", { status: "RUNNING" })])
    .map((row) => [row.key, row]));
  assert.equal(unfinished.p95WaitSeconds.mlText, "N/A", "a run still in progress has no value yet");
  assert.equal(unfinished.p95WaitSeconds.difference, "N/A");
  assert.equal(unfinished.peakWorkers.winner, null, "no verdict before both runs finish");
});

// ---------------------------------------------------------------- chart geometry

const samples = (points) => points.map(([offsetSeconds, queuedJobs, workersInService, peakUtilization, forecastQueuedJobs = null]) =>
  ({ offsetSeconds, queuedJobs, workersInService, peakUtilization, forecastQueuedJobs }));

test("ticks are round and start at zero; utilization always spans 0–100%", () => {
  assert.deepEqual(timeTicks(47), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(timeTicks(140), [0, 30, 60, 90, 120, 150]);
  assert.deepEqual(valueTicks(0.7, { fixedMax: 100 }), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(valueTicks(7, { integer: true }), [0, 2, 4, 6, 8]);
  assert.deepEqual(valueTicks(0, { integer: true }), [0, 1], "an empty queue still has an axis");
});

test("chart geometry keeps the plot inside its margins on a shared time axis", () => {
  const series = [
    { key: "REACTIVE", points: runPoints({ samples: samples([[0, 0, 3, 0.2], [20, 5, 4, 0.9], [40, 1, 4, 0.4]]) }, "utilization") },
    { key: "ML", points: runPoints({ samples: samples([[0, 0, 3, 0.1], [30, 2, 4, 0.6]]) }, "utilization") },
  ];
  const chart = buildChart(series, { width: 600, height: 300, fixedMax: 100 });
  assert.deepEqual(chart.plot, { left: 44, top: 12, width: 540, height: 244, right: 584, bottom: 256 });
  assert.equal(chart.xTicks.at(-1).value, 40, "the longer run sets the shared axis");
  assert.equal(chart.xTicks.at(-1).x, chart.plot.right);
  assert.equal(chart.yTicks.at(-1).value, 100);
  assert.equal(chart.lines[0].points[1].y, Math.round((256 - 0.9 * 244) * 10) / 10);
  assert.ok(chart.lines.every((line) => line.points.every((point) =>
    point.x >= chart.plot.left && point.x <= chart.plot.right && point.y >= chart.plot.top && point.y <= chart.plot.bottom)));
  const stepped = buildChart([series[0]], { width: 600, height: 300, step: true });
  assert.match(stepped.lines[0].path, / H\d/);
  assert.equal(chart.timeAt(chart.plot.left - 50), 0, "the cursor time is clamped to the axis");
});

test("hovering shows only measured samples: no interpolation, and N/A after a run ends", () => {
  const reactive = [{ t: 0, v: 1 }, { t: 2, v: 2 }, { t: 4, v: 3 }];
  const ml = [{ t: 0.9, v: 5 }, { t: 2.9, v: 6 }, { t: 4.9, v: 7 }, { t: 6.9, v: 8 }, { t: 8.9, v: 9 }];
  const times = hoverTimes([{ points: reactive }, { points: ml }]);
  assert.deepEqual(times.slice(0, 3), [0, 0.9, 2]);
  assert.equal(nearestTimeIndex(times, 2.2), 2);
  assert.deepEqual(pointAt(reactive, 2.4), { t: 2, v: 2 });
  assert.equal(pointAt(reactive, 8.9), null, "the reactive run had finished by then");
  assert.deepEqual(pointAt(ml, 2.4), { t: 2.9, v: 6 });
});

test("the tooltip flips at the right edge and never leaves the chart", () => {
  assert.equal(tooltipLeft(100, 200, 600), 114);
  assert.equal(tooltipLeft(500, 200, 600), 286);
  assert.equal(tooltipLeft(150, 200, 320), 4, "on a narrow chart it is clamped inside");
});

test("forecast points sit at the moment they predicted and stop at the end of the run", () => {
  const points = forecastPoints({ samples: samples([[0, 0, 3, 0.1, 2], [5, 1, 3, 0.2, 3], [10, 2, 3, 0.3, 4], [15, 4, 4, 0.5]]) }, 5);
  assert.deepEqual(points, [{ t: 5, v: 2 }, { t: 10, v: 3 }, { t: 15, v: 4 }]);
});

test("the chart renders real SVG with labelled axes and no tooltip until hovered", () => {
  const props = {
    series: [{ key: "REACTIVE", label: "Reactive", className: "strategy-reactive", points: [{ t: 0, v: 20 }, { t: 10, v: 60 }] }],
    metric: CHART_METRICS.utilization, ariaLabel: "Utilization", threshold: 75,
  };
  const html = render(ScalingChart, props);
  assert.match(html, /<svg width="720" height="280"/);
  assert.match(html, />Time since start</);
  assert.match(html, />10s</);
  assert.match(html, />100%</);
  assert.match(html, /class="sc-threshold"/);
  assert.equal((html.match(/class="sc-series-point"/g) ?? []).length, 0, "lines only by default");
  assert.doesNotMatch(html, /sc-series-area/);
  assert.equal((render(ScalingChart, { ...props, showPoints: true }).match(/class="sc-series-point"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /sc-tooltip/);
});

test("progress and export names come from the stored comparison", () => {
  assert.equal(comparisonProgress({ runs: [{ status: "COMPLETED" }, { status: "RUNNING" }],
    progress: { finishedJobs: 5, totalJobs: 10 } }), 0.75);
  assert.equal(exportFileName({ pattern: "INCREASING", seed: 42, startedAt: start }),
    "orchestros-comparison-increasing-seed42-2026-11-01.json");
});

// ---------------------------------------------------------------- the page

const settings = { scaleUpQueueThreshold: 2, scaleUpUtilization: 0.75, scaleDownUtilization: 0.4, maxWorkers: 3,
  cooldownSeconds: 15, idleSeconds: 30, mlWindowPoints: 20, mlLookAheadSeconds: 60 };
const finished = {
  id: "c1", status: "COMPLETED", jobCount: 25, pattern: "INCREASING", seed: 42, workloadTypes: ["SLEEP"],
  schedulingPolicy: "FCFS", placementStrategy: "LEAST_LOADED", timeQuantumSeconds: 5, jobsPerTick: 25,
  startedAt: start, autoscalerSettings: settings, failureReason: null,
  runs: [
    run("REACTIVE", { samples: samples([[0, 0, 3, 0.2], [10, 5, 3, 0.9], [20, 1, 4, 0.5]]) }),
    run("ML", { avgWaitSeconds: 8.6, avgTurnaroundSeconds: 14.9, peakWorkers: 3, scaleUps: 0, extraWorkerSeconds: 0,
      samples: samples([[0, 0, 3, 0.1, 1], [10, 3, 3, 0.7, 2], [20, 0, 3, 0.3, null]]) }),
  ],
  comparison: {
    comparable: true, waitVerdict: "REACTIVE", costVerdict: "ML", notes: [], forecast: { meanAbsError: 0.75, pairs: 4 },
    metrics: [
      metric("avgWaitSeconds", 6.3, 8.6, "REACTIVE", 0.365),
      metric("p95WaitSeconds", 14.4, 18.6, "REACTIVE", 0.29),
      metric("avgTurnaroundSeconds", 12.6, 14.9, "REACTIVE", 0.18),
      metric("makespanSeconds", 22.7, 26.8, "REACTIVE", 0.18),
      { ...metric("reactionSeconds", 6, null, null), group: "react", unit: "signed-s",
        reactiveOutcome: "MEASURED", mlOutcome: "NEVER_SCALED_UP" },
      { ...metric("extraWorkerSeconds", 18, 0, "ML"), group: "cost", unit: "worker-s" },
      { ...metric("scaleActions", 1, 0, "ML"), group: "stability", unit: "count" },
    ],
  },
};
const view = (props = {}) => render(panel.ScalingComparisonView, {
  data: { activeComparisonId: null, comparisons: [{ ...finished, runs: finished.runs.map(({ samples: _s, ...entry }) => entry) }] },
  detail: finished, selectedId: null, onSelect: () => {}, form: panel.DEFAULT_SCALING_FORM, onFormChange: () => {},
  onStart: () => {}, onAbort: () => {}, onRerun: () => {}, onExport: () => {}, onOpenForm: () => {}, onCloseForm: () => {},
  ...props,
});

test("a finished comparison reads top to bottom like the reference design", () => {
  const html = view();
  assert.match(html, /<h1>Autoscaling comparison<\/h1>/);
  assert.match(html, /Reactive and ML-assisted autoscaling, run on the same workload and configuration\./);
  for (const label of ["Re-run</button>", "Export</button>", "New experiment</button>"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /page-status/, "no status pill while idle");

  for (const phrase of ["25 jobs", "Increasing arrival", "Sleep, short pauses", "FCFS scheduling",
    "Least-loaded placement", "Seed 42"]) {
    assert.match(html, new RegExp(`>${phrase}</li>`), phrase);
  }
  assert.match(html, /title="Increasing \(ramp-up\)">Increasing arrival/, "the full setting is the tooltip");
  assert.match(html, /class="link sc-setup-edit"[^>]*>Edit<\/button>/);

  assert.match(html, /<h2 id="sc-chart-title">Resource utilization over time<\/h2>/);
  assert.match(html, /aria-pressed="true"[^>]*>Utilization<\/button>/);
  assert.match(html, />Jobs waiting<\/button>/);
  assert.match(html, />Workers<\/button>/);
  assert.match(html, /Scale-up threshold \(75%\)/);

  assert.match(html, /<p class="sc-eyebrow">Takeaway<\/p>/);
  assert.match(html, /<h2 id="sc-takeaway-title">Reactive was faster\. ML-assisted used less capacity\.<\/h2>/);
  assert.match(html, /Reactive kept average wait 27% shorter \(6\.3s vs 8\.6s\)\. ML-assisted needed 18 fewer extra worker-seconds\./);
  assert.match(html, /Rule-based\. Scales on what it sees right now: waiting jobs and reserved capacity\./);
  assert.match(html, /Forecasts waiting jobs and utilization 60s ahead with linear regression, then scales/);
  assert.equal((html.match(/>Completed<\/span>/g) ?? []).length, 2);

  assert.match(html, /<h2 id="sc-results-title">Results<\/h2>/);
  assert.match(html, /Lower is better for every metric\. Differences under 5% aren&#x27;t called\./);
  assert.match(html, /<th scope="row">Avg\. wait time<\/th><td class="num mono is-best">6\.3s<\/td><td class="num mono is-worse">8\.6s<\/td><td class="num mono">\+37%<\/td>/);
  assert.match(html, /Extra capacity<small> \(worker-s\)<\/small>/);
  assert.match(html, />Peak workers<\/th><td class="num mono is-worse">4<\/td><td class="num mono is-best">3<\/td>/);
  assert.doesNotMatch(html, /sc-card/, "the strategy cards are gone");

  assert.match(html, /Earlier comparisons <span class="count mono">1<\/span>/);
  assert.match(html, /Detailed analysis/);
  assert.match(html, /Fair test: both runs did identical work/);
  assert.doesNotMatch(html, /is-caution/);
});

test("a comparison that was not a fair test says so above the results", () => {
  const unfair = { ...finished, comparison: { ...finished.comparison, comparable: false, notes: ["Checksums differ."] } };
  const html = view({ detail: unfair });
  const caution = html.indexOf('class="sc-fairness is-caution">Checksums differ.');
  assert.ok(caution > 0 && caution < html.indexOf('id="sc-results-title"'));
});

test("a running comparison shows live progress, a stop button, and no partial numbers", () => {
  const running = { ...finished, status: "RUNNING", progress: { strategy: "ML", position: 1, totalRuns: 2,
    finishedJobs: 10, totalJobs: 25 }, runs: [finished.runs[0], { ...finished.runs[1], status: "RUNNING" }],
  comparison: { ...finished.comparison, waitVerdict: null, costVerdict: null, metrics: [] } };
  const html = view({ data: { activeComparisonId: "c1", comparisons: [running] }, detail: running });
  assert.match(html, /Running ML-assisted autoscaling \(2 of 2\) · 10\/25 jobs finished/);
  assert.match(html, />Stop comparison</);
  assert.match(html, /class="page-status is-live"/);
  assert.match(html, /Running · 10\/25 jobs/);
  assert.match(html, /Waiting for both runs to finish/);
  assert.doesNotMatch(html, /Re-run<\/button>/);
  assert.match(html, /class="link sc-setup-edit" disabled=""/, "settings cannot be edited mid-run");
  assert.match(html, /<td class="num mono">N\/A<\/td>/, "the unfinished run has no numbers yet");
});

test("an empty history opens the new-experiment form; loading says so", () => {
  const empty = view({ data: { activeComparisonId: null, comparisons: [] }, detail: null });
  assert.match(empty, /<h2>New experiment<\/h2>/);
  assert.match(empty, />Compare Reactive vs ML</);
  assert.doesNotMatch(empty, /Cancel/, "nothing to go back to");
  assert.doesNotMatch(empty, /id="sc-quantum"/, "the quantum only appears for Round Robin");
  assert.match(view({ data: null, detail: null }), /Loading comparisons…/);
});

test("re-running repeats the stored settings, and a new experiment starts from them", () => {
  assert.deepEqual(panel.rerunRequest(finished), {
    count: 25, pattern: "INCREASING", workloadTypes: ["SLEEP"], policy: "FCFS", strategy: "LEAST_LOADED",
    seed: 42, timeQuantumSeconds: 5, jobsPerTick: 25,
  });
  assert.deepEqual(panel.formFromComparison({ ...finished,
    workloadTypes: ["SORTING", "CPU_INTENSIVE", "DATA_PROCESSING", "MATRIX_MULTIPLICATION"] }).profile, "MIXED_COMPUTE");
  assert.deepEqual(panel.toScalingRequest(panel.DEFAULT_SCALING_FORM), {
    count: 25, pattern: "INCREASING", workloadTypes: ["SLEEP"], policy: "FCFS", strategy: "LEAST_LOADED",
    seed: 42, timeQuantumSeconds: 5,
  });
});

test("the comparison tab defaults to autoscaling and still offers scheduling policies", () => {
  const html = render(ComparisonModeSwitch, { mode: "autoscaling", onModeChange: () => {} });
  assert.match(html, /checked="" value="autoscaling"/);
  assert.match(html, /Scheduling policies/);
});

test("the top bar reports API, MySQL, and Docker, and only says online when all are up", () => {
  const up = app.systemStatus({ health: { dependencies: { database: "up" } }, runtime: { imageAvailable: true } });
  assert.equal(up.label, "System Online");
  const noDocker = app.systemStatus({ health: { dependencies: { database: "up" } }, runtimeError: "Docker: 503" });
  assert.equal(noDocker.overall, "degraded");
  assert.equal(noDocker.docker, "down");
  assert.equal(app.systemStatus({}).overall, "checking");
  assert.equal(app.servicesSummary(up), "API, MySQL, Docker connected");
  assert.equal(app.servicesSummary(noDocker), "Docker not connected");
  assert.equal(app.servicesSummary(app.systemStatus({ healthError: "timeout" })), "API, MySQL not connected");
  assert.equal(app.servicesSummary(app.systemStatus({})), "Checking services…");
  assert.equal(app.backendSummary(up), "API online, database connected");
  assert.equal(app.backendSummary(app.systemStatus({ healthError: "timeout" })), "API offline");
  assert.equal(app.backendSummary(app.systemStatus({ health: { dependencies: { database: "down" } } })),
    "API online, database unreachable");
});
