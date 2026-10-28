import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  buildForecastChart,
  buildTimelines,
  comparisonProgress,
  formatSeconds,
  formatValue,
  headline,
  reactionText,
  ticks,
  winnerText,
} from "../src/scaling.chart.js";

let server;
let ScalingComparisonView;
let DEFAULT_SCALING_FORM;
let toScalingRequest;
let ComparisonModeSwitch;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  ({ ScalingComparisonView, DEFAULT_SCALING_FORM, toScalingRequest } =
    await server.ssrLoadModule("/src/components/ScalingComparisonPanel.jsx"));
  ({ ComparisonModeSwitch } = await server.ssrLoadModule("/src/components/ComparisonTab.jsx"));
});
after(async () => { await server?.close(); });

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const start = "2026-11-01T10:00:00.000Z";
const iso = (seconds) => new Date(Date.parse(start) + seconds * 1_000).toISOString();

// ---------------------------------------------------------------- wording and numbers

test("values read in plain units and never show an unmeasured value as zero", () => {
  assert.equal(formatSeconds(null), "—");
  assert.equal(formatSeconds(12.34), "12.3s");
  assert.equal(formatSeconds(245), "4m 05s");
  assert.equal(formatValue(118.6, "worker-s"), "119 worker-seconds");
  assert.equal(formatValue(3, "count"), "3");
  assert.equal(formatValue(null, "s"), "—");
});

test("reaction time is described in words, including the cases with no number", () => {
  assert.equal(reactionText("MEASURED", 6), "6.0s after the backlog began");
  assert.equal(reactionText("MEASURED", -4), "4.0s before the backlog");
  assert.equal(reactionText("BEFORE_ANY_BACKLOG", null), "Before any backlog formed");
  assert.equal(reactionText("NEVER_SCALED_UP", null), "Never added a worker");
  assert.equal(reactionText("NOT_NEEDED", null), "Not needed: no backlog");
});

test("winner text says who won and by how much", () => {
  assert.equal(winnerText({ key: "avgWaitSeconds", winner: "ML", reactive: 15.1, ml: 12.3, better: "lower" }),
    "ML predictive · 19% less");
  assert.equal(winnerText({ key: "extraWorkerSeconds", winner: "REACTIVE", reactive: 200, ml: 300, better: "lower" }),
    "Reactive · 33% less", "measured against the strategy that lost");
  assert.equal(winnerText({ key: "flaps", winner: "ML", reactive: 2, ml: 0, better: "lower" }), "ML predictive · 100% less");
  assert.equal(winnerText({ key: "flaps", winner: "REACTIVE", reactive: 0, ml: 0, better: "lower" }), "Reactive · better");
  assert.equal(winnerText({ key: "avgWaitSeconds", winner: "TIE", change: 0.01 }), "About the same");
  assert.equal(winnerText({ key: "reactionSeconds", winner: "ML", reactive: 6, ml: -2 }), "ML predictive · 8.0s sooner");
  assert.equal(winnerText({ key: "avgWaitSeconds", winner: null }), "—");
});

test("the headline turns the two key verdicts into one sentence", () => {
  assert.equal(headline({ waitVerdict: "ML", costVerdict: "TIE" }).tone, "ml");
  assert.match(headline({ waitVerdict: "ML", costVerdict: "REACTIVE" }).title, /trade-off: ML predictive was faster/);
  assert.equal(headline({ waitVerdict: "REACTIVE", costVerdict: "REACTIVE" }).tone, "reactive");
  assert.match(headline({ waitVerdict: "TIE", costVerdict: "ML" }).title, /ML predictive did the same job with less capacity/);
  assert.equal(headline({ waitVerdict: "TIE", costVerdict: "TIE" }).tone, "tie");
  assert.equal(headline({ waitVerdict: null, costVerdict: null }).tone, "pending");
});

// ---------------------------------------------------------------- chart geometry

const samples = (points) => points.map(([offsetSeconds, queuedJobs, workersInService, forecastQueuedJobs = null]) => ({
  offsetSeconds, queuedJobs, workersInService, extraWorkers: workersInService - 3, idleExtraWorkers: 0,
  peakUtilization: 0.5, forecastQueuedJobs,
}));

test("axis ticks run from zero to a round maximum", () => {
  assert.deepEqual(ticks(37), [0, 12.5, 25, 37.5, 50]);
  assert.deepEqual(ticks(0), [0, 0.25, 0.5, 0.75, 1]);
});

test("both timelines share one time axis and one scale per band", () => {
  const runs = [
    { strategy: "REACTIVE", startedAt: start, samples: samples([[0, 0, 3], [10, 6, 3], [20, 2, 4]]),
      scalingActions: [{ at: iso(15), action: "SCALE_UP" }] },
    { strategy: "ML", startedAt: start, samples: samples([[0, 0, 3], [10, 3, 4], [40, 0, 4]]), scalingActions: [] },
  ];
  const chart = buildTimelines(runs, { width: 500, queueHeight: 100, workersHeight: 50, threshold: 2 });
  assert.equal(chart.xTicks.at(-1).value, 50, "the longer run sets the shared axis");
  assert.equal(chart.xTicks.at(-1).x, 500);
  assert.equal(chart.lanes[0].peakQueue, 6);
  assert.equal(chart.lanes[1].peakWorkers, 4);
  assert.equal(chart.lanes[0].markers.length, 1);
  assert.equal(chart.lanes[0].markers[0].x, 150, "15 s of 50 s across 500 px");
  assert.match(chart.lanes[0].workers, /^M0,\d/);
  assert.match(chart.lanes[0].queueArea, /Z$/, "the waiting area is closed to the baseline");
  assert.ok(chart.thresholdY > 0 && chart.thresholdY < 100);
  assert.equal(buildTimelines([{ strategy: "ML", samples: [] }]).lanes[0].empty, true);
});

test("the forecast chart draws each prediction at the moment it predicted", () => {
  const run = { samples: samples([[0, 0, 3, 2], [5, 1, 3, 3], [10, 2, 3, 4], [15, 4, 4, null]]) };
  const chart = buildForecastChart(run, 5, { width: 400, height: 100 });
  assert.ok(chart);
  assert.equal(chart.predicted.split("L").length, 3, "predictions at 5, 10 and 15 s; 20 s is past the end");
  assert.equal(buildForecastChart({ samples: samples([[0, 1, 3]]) }, 5), null, "too little to draw");
});

test("progress counts finished runs plus the live share of the current one", () => {
  assert.equal(comparisonProgress({ runs: [{ status: "COMPLETED" }, { status: "RUNNING" }],
    progress: { finishedJobs: 5, totalJobs: 10 } }), 0.75);
  assert.equal(comparisonProgress({ runs: [] }), 0);
});

// ---------------------------------------------------------------- the view

const settings = {
  scaleUpQueueThreshold: 2, scaleUpUtilization: 0.75, scaleDownUtilization: 0.4, maxWorkers: 3,
  cooldownSeconds: 15, idleSeconds: 30, mlWindowPoints: 20, mlLookAheadSeconds: 5,
};
const metric = (key, group, label, unit, reactive, ml, winner, change, extra = {}) =>
  ({ key, group, label, unit, better: "lower", reactive, ml, winner, change, reactiveOutcome: null, mlOutcome: null, ...extra });
const finished = {
  id: "c1", status: "COMPLETED", jobCount: 25, pattern: "INCREASING", seed: 42, schedulingPolicy: "FCFS",
  placementStrategy: "LEAST_LOADED", startedAt: start, autoscalerSettings: settings, failureReason: null,
  runs: [
    { id: "r0", strategy: "REACTIVE", status: "COMPLETED", completedJobs: 25, jobCount: 25, workerCount: 3,
      cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072, startedAt: start, failureReason: null,
      samples: samples([[0, 0, 3], [10, 5, 3], [20, 1, 4]]), scalingActions: [{ at: iso(12), action: "SCALE_UP" }] },
    { id: "r1", strategy: "ML", status: "COMPLETED", completedJobs: 25, jobCount: 25, workerCount: 3,
      cpuCapacityMillicores: 3000, memoryCapacityMiB: 3072, startedAt: start, failureReason: null,
      samples: samples([[0, 0, 3, 1], [5, 2, 4, 3], [10, 3, 4, 2], [15, 1, 4, 1], [20, 0, 4, null]]),
      scalingActions: [{ at: iso(4), action: "SCALE_UP" }] },
  ],
  comparison: {
    comparable: true, waitVerdict: "ML", costVerdict: "REACTIVE", notes: [],
    forecast: { meanAbsError: 0.75, pairs: 4 },
    metrics: [
      metric("avgWaitSeconds", "wait", "Average waiting time", "s", 20, 15, "ML", -0.25),
      metric("p95WaitSeconds", "wait", "Slowest 5% waiting time", "s", 40, 30, "ML", -0.25),
      metric("avgTurnaroundSeconds", "wait", "Average turnaround", "s", 30, 25, "ML", -0.167),
      metric("makespanSeconds", "wait", "Time to finish all jobs", "s", 300, 299, "TIE", -0.003),
      metric("reactionSeconds", "react", "First extra worker", "signed-s", 6, -2, "ML", null,
        { reactiveOutcome: "MEASURED", mlOutcome: "MEASURED" }),
      metric("backedUpSeconds", "react", "Time with a backlog", "s", 60, 30, "ML", -0.5),
      metric("extraWorkerSeconds", "cost", "Extra worker time", "worker-s", 200, 300, "REACTIVE", 0.5),
      metric("idleExtraWorkerSeconds", "cost", "Idle extra worker time", "worker-s", 40, 90, "REACTIVE", 1.25),
      metric("scaleActions", "stability", "Scaling changes", "count", 4, 4, "TIE", 0),
      metric("flaps", "stability", "Quick re-adds (flaps)", "count", 0, 0, "TIE", null),
    ],
  },
};
const view = (props = {}) => render(ScalingComparisonView, {
  data: { activeComparisonId: null, comparisons: [{ ...finished, runs: finished.runs.map(({ samples: _s, ...run }) => run) }] },
  detail: finished, selectedId: null, onSelect: () => {}, form: DEFAULT_SCALING_FORM, onFormChange: () => {},
  onStart: () => {}, onAbort: () => {}, ...props,
});

test("the form defaults to 25 jobs on a ramp and sends Reactive-then-ML settings only", () => {
  assert.deepEqual(toScalingRequest(DEFAULT_SCALING_FORM), {
    count: 25, pattern: "INCREASING", workloadTypes: ["SLEEP"], policy: "FCFS", strategy: "LEAST_LOADED",
    seed: 42, timeQuantumSeconds: 5,
  });
  const html = view({ data: { activeComparisonId: null, comparisons: [] }, detail: null });
  assert.match(html, />Compare Reactive vs ML</);
  assert.match(html, /No comparisons yet/);
  assert.doesNotMatch(html, /id="sc-quantum"/, "the quantum only appears for Round Robin");
});

test("a finished comparison leads with a verdict, then answers four questions", () => {
  const html = view();
  assert.match(html, /<h3>A trade-off: ML predictive was faster but used more capacity<\/h3>/);
  assert.match(html, /sc-verdict sc-verdict-tradeoff/);
  for (const question of ["Which kept jobs waiting less?", "Which added workers sooner?",
    "Which used less extra capacity?", "Which made fewer scaling changes?"]) {
    assert.ok(html.includes(question), question);
  }
  assert.match(html, /ML predictive · 25% less/);
  assert.match(html, /Reactive · 33% less/, "the cost card names Reactive as the cheaper one");
  assert.match(html, /2\.0s before the backlog/);
  assert.match(html, /6\.0s after the backlog began/);
});

test("timelines, the forecast check, and every measurement are explained in place", () => {
  const html = view();
  assert.match(html, /What happened over time/);
  assert.match(html, /How to read it:/);
  assert.equal((html.match(/class="sc-lane strategy-/g) ?? []).length, 3, "two timelines and one forecast chart");
  assert.match(html, /scale-up line \(2 jobs\)/);
  assert.match(html, /Was the ML forecast right\?/);
  assert.match(html, /off by 0\.8 job\(s\), over 4 checks/);
  assert.match(html, /Every measurement/);
  assert.match(html, /How long a job waited, on average/);
  assert.match(html, /Fair test: both runs did byte-identical work/);
  assert.match(html, /Differences under 5% count as “about the same”/);
});

test("a running comparison shows progress and a stop button, and locks the form", () => {
  const running = { ...finished, status: "RUNNING", progress: { strategy: "ML", position: 1, totalRuns: 2,
    finishedJobs: 10, totalJobs: 25 }, runs: [finished.runs[0], { ...finished.runs[1], status: "RUNNING" }],
  comparison: { ...finished.comparison, waitVerdict: null, costVerdict: null } };
  const html = view({ data: { activeComparisonId: "c1", comparisons: [running] }, detail: running });
  assert.match(html, /Running ML predictive \(2 of 2\) · 10\/25 jobs finished/);
  assert.match(html, />Stop comparison</);
  assert.match(html, /<select id="sc-count" disabled=""/);
  assert.match(html, /Waiting for both runs to finish/);
  assert.doesNotMatch(html, /At a glance/, "no winners before both runs complete");
});

test("the comparison tab offers both experiments as one choice", () => {
  const html = render(ComparisonModeSwitch, { mode: "autoscaling", onModeChange: () => {} });
  assert.match(html, /<legend class="sr-only">What to compare<\/legend>/);
  assert.match(html, /checked="" value="autoscaling"/);
  assert.match(html, /Scheduling policies/);
  assert.match(html, /Autoscaling: Reactive vs ML/);
});
