/**
 * Pure helpers for the Reactive-vs-ML autoscaling comparison: wording,
 * number formatting, and chart geometry. No React, no fetch.
 */

export const STRATEGY_LABELS = { REACTIVE: "Reactive", ML: "ML predictive" };
export const STRATEGY_ORDER = ["REACTIVE", "ML"];

/** CSS class giving a strategy its colour, the same in every chart and table. */
export function strategyClass(strategy) {
  return strategy === "ML" ? "strategy-ml" : "strategy-reactive";
}

/** Seconds as "42.5s" or, from two minutes, "4m 05s". */
export function formatSeconds(value) {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) < 120) return `${(Math.round(value * 10) / 10).toFixed(1)}s`;
  const total = Math.round(Math.abs(value));
  return `${value < 0 ? "-" : ""}${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** One stored metric for display; an unmeasured value stays visibly unmeasured. */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return "—";
  if (unit === "s" || unit === "signed-s") return formatSeconds(value);
  if (unit === "worker-s") return `${Math.round(value)} worker-seconds`;
  return String(Math.round(value));
}

/** When the first extra worker arrived, relative to the backlog, in words. */
export function reactionText(outcome, seconds) {
  if (outcome === "BEFORE_ANY_BACKLOG") return "Before any backlog formed";
  if (outcome === "NEVER_SCALED_UP") return "Never added a worker";
  if (outcome === "NOT_NEEDED") return "Not needed: no backlog";
  if (seconds === null || seconds === undefined) return "—";
  if (Math.abs(seconds) < 0.05) return "As the backlog began";
  return seconds < 0
    ? `${formatSeconds(-seconds)} before the backlog`
    : `${formatSeconds(seconds)} after the backlog began`;
}

/** Plain-language meaning of every compared metric. */
export function metricMeaning(key, settings = {}) {
  const threshold = settings.scaleUpQueueThreshold ?? 2;
  return {
    avgWaitSeconds: "How long a job waited, on average, before it got to run.",
    p95WaitSeconds: "The wait of the unluckiest 5% of jobs. Shows how bad the worst delays got.",
    avgTurnaroundSeconds: "From a job arriving to it finishing, on average.",
    makespanSeconds: "From the first job arriving to the last one finishing.",
    reactionSeconds: "When the first extra worker arrived, compared with the moment jobs started piling up.",
    backedUpSeconds: `How long ${threshold} or more jobs were waiting at the same time.`,
    extraWorkerSeconds: "Extra workers multiplied by the seconds they were switched on: the capacity each strategy paid for.",
    idleExtraWorkerSeconds: "The part of that extra capacity that sat idle with nothing to run.",
    scaleActions: "Workers added plus workers retired. Fewer changes means a calmer cluster.",
    flaps: "Workers added back within a minute of being retired. A sign of over-reacting.",
  }[key] ?? "";
}

/** "ML predictive · 18% better", "About the same", or "—" before both runs finish. */
export function winnerText(metric) {
  if (!metric.winner) return "—";
  if (metric.winner === "TIE") return "About the same";
  const name = STRATEGY_LABELS[metric.winner];
  if (metric.key === "reactionSeconds") {
    if (metric.reactive !== null && metric.ml !== null) {
      return `${name} · ${formatSeconds(Math.abs(metric.ml - metric.reactive))} sooner`;
    }
    return `${name} · sooner`;
  }
  // The winner measured against the other strategy: 200 vs 300 is "33% less", not "50%".
  const winner = metric.winner === "ML" ? metric.ml : metric.reactive;
  const other = metric.winner === "ML" ? metric.reactive : metric.ml;
  if (winner === null || winner === undefined || !other) return `${name} · better`;
  const percent = Math.round((Math.abs(winner - other) / Math.abs(other)) * 100);
  return `${name} · ${percent}% ${metric.better === "lower" ? "less" : "more"}`;
}

/** The four questions a reader asks, each answered by one headline metric. */
export const QUESTIONS = [
  { group: "wait", key: "avgWaitSeconds", question: "Which kept jobs waiting less?" },
  { group: "react", key: "reactionSeconds", question: "Which added workers sooner?" },
  { group: "cost", key: "extraWorkerSeconds", question: "Which used less extra capacity?" },
  { group: "stability", key: "scaleActions", question: "Which made fewer scaling changes?" },
];

export const GROUP_TITLES = {
  wait: "Job experience",
  react: "Reaction speed",
  cost: "Extra capacity used",
  stability: "Stability",
};

/**
 * The one-sentence verdict, from the two questions that matter most: did jobs
 * wait less, and what did it cost in extra worker time?
 */
export function headline(comparison) {
  const wait = comparison?.waitVerdict ?? null;
  const cost = comparison?.costVerdict ?? null;
  if (!wait || !cost) {
    return { tone: "pending", title: "Waiting for both runs to finish",
      detail: "The verdict appears once the Reactive and the ML predictive run have both completed." };
  }
  const ml = STRATEGY_LABELS.ML;
  if (wait === "TIE" && cost === "TIE") {
    return { tone: "tie", title: "Both strategies performed about the same",
      detail: "Waiting times and extra capacity were within a few percent of each other on this workload." };
  }
  if (wait === "ML" && cost !== "REACTIVE") {
    return { tone: "ml", title: `${ml} did better on this workload`,
      detail: "Jobs waited less, without using more extra capacity." };
  }
  if (wait === "REACTIVE" && cost !== "ML") {
    return { tone: "reactive", title: "Reactive did better on this workload",
      detail: "Jobs waited less, without using more extra capacity. Predicting ahead did not help here." };
  }
  if (wait === "ML" && cost === "REACTIVE") {
    return { tone: "tradeoff", title: `A trade-off: ${ml} was faster but used more capacity`,
      detail: "It shortened waits by adding or keeping extra workers longer. Whether that is worth it depends on what extra capacity costs." };
  }
  if (wait === "REACTIVE" && cost === "ML") {
    return { tone: "tradeoff", title: `A trade-off: Reactive was faster, ${ml} used less capacity`,
      detail: "Reactive kept waits shorter; the ML strategy saved extra worker time." };
  }
  // Same waiting time, different cost.
  const cheaper = cost === "ML" ? ml : "Reactive";
  return { tone: cost === "ML" ? "ml" : "reactive", title: `${cheaper} did the same job with less capacity`,
    detail: "Waiting times were about the same, but it used less extra worker time." };
}

const nice = (value) => {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (value <= multiple * step) return multiple * step;
  }
  return 10 * step;
};

/** Evenly spaced axis ticks from 0 to a round maximum. */
export function ticks(max, count = 4) {
  const top = nice(max);
  return Array.from({ length: count + 1 }, (_, index) => Math.round((top * index / count) * 100) / 100);
}

const offsetOf = (run, isoTime) => (run.startedAt
  ? (new Date(isoTime).getTime() - new Date(run.startedAt).getTime()) / 1_000 : null);

/**
 * Geometry for the side-by-side timelines. Both runs share one time axis and
 * one scale per band, so their shapes compare directly.
 *
 * Each run gets a "waiting jobs" area, a "workers in service" step line, and
 * up/down markers where the autoscaler changed the cluster.
 */
export function buildTimelines(runs, { width = 600, queueHeight = 110, workersHeight = 64, threshold = 2 } = {}) {
  const withSamples = runs.filter((run) => (run.samples ?? []).length > 0);
  const lastOffset = Math.max(1, ...withSamples.map((run) => run.samples.at(-1).offsetSeconds));
  const xTicks = ticks(lastOffset, 4);
  const xMax = xTicks.at(-1);
  const queueTop = ticks(Math.max(threshold + 1,
    ...withSamples.flatMap((run) => run.samples.map((sample) => sample.queuedJobs))), 4).at(-1);
  const workerTop = Math.max(1, ...withSamples.flatMap((run) => run.samples.map((sample) => sample.workersInService)));
  const x = (seconds) => Math.round((Math.max(0, seconds) / xMax) * width * 10) / 10;
  const yQueue = (value) => Math.round((queueHeight - (value / queueTop) * queueHeight) * 10) / 10;
  const yWorkers = (value) => Math.round((workersHeight - (value / workerTop) * workersHeight) * 10) / 10;

  const lanes = runs.map((run) => {
    const samples = run.samples ?? [];
    if (samples.length === 0) return { strategy: run.strategy, empty: true };
    const queuePoints = samples.map((sample) => `${x(sample.offsetSeconds)},${yQueue(sample.queuedJobs)}`);
    const queueArea = `M${x(samples[0].offsetSeconds)},${queueHeight} L${queuePoints.join(" L")} ` +
      `L${x(samples.at(-1).offsetSeconds)},${queueHeight} Z`;
    let workers = `M${x(samples[0].offsetSeconds)},${yWorkers(samples[0].workersInService)}`;
    for (let index = 1; index < samples.length; index += 1) {
      workers += ` H${x(samples[index].offsetSeconds)} V${yWorkers(samples[index].workersInService)}`;
    }
    const markers = (run.scalingActions ?? []).map((action) => {
      const offset = offsetOf(run, action.at);
      if (offset === null) return null;
      const before = [...samples].reverse().find((sample) => sample.offsetSeconds <= offset) ?? samples[0];
      return { action: action.action, x: x(offset), y: yWorkers(before.workersInService), seconds: offset };
    }).filter(Boolean);
    return {
      strategy: run.strategy,
      empty: false,
      queueArea,
      workers,
      markers,
      durationSeconds: samples.at(-1).offsetSeconds,
      peakQueue: Math.max(...samples.map((sample) => sample.queuedJobs)),
      peakWorkers: Math.max(...samples.map((sample) => sample.workersInService)),
    };
  });

  return {
    width,
    queueHeight,
    workersHeight,
    thresholdY: yQueue(threshold),
    xTicks: xTicks.map((value) => ({ value, x: x(value) })),
    queueTicks: ticks(queueTop, 2).map((value) => ({ value, y: yQueue(value) })),
    workerTicks: [0, workerTop].map((value) => ({ value, y: yWorkers(value) })),
    lanes,
  };
}

/**
 * Forecast check for the ML run: each prediction is drawn at the moment it
 * was predicting (its time plus the look-ahead), next to the queue actually
 * measured then, so the gap between the lines is the forecast error.
 */
export function buildForecastChart(run, lookAheadSeconds, { width = 600, height = 120 } = {}) {
  const samples = run?.samples ?? [];
  const end = samples.at(-1)?.offsetSeconds ?? 0;
  const predicted = samples
    .filter((sample) => sample.forecastQueuedJobs !== null && sample.forecastQueuedJobs !== undefined)
    .map((sample) => ({ seconds: sample.offsetSeconds + lookAheadSeconds, value: sample.forecastQueuedJobs }))
    .filter((point) => point.seconds <= end);
  if (samples.length < 2 || predicted.length < 2) return null;
  const xMax = ticks(end, 4).at(-1);
  const top = ticks(Math.max(1, ...samples.map((sample) => sample.queuedJobs), ...predicted.map((point) => point.value)), 2).at(-1);
  const x = (seconds) => Math.round((seconds / xMax) * width * 10) / 10;
  const y = (value) => Math.round((height - (value / top) * height) * 10) / 10;
  const line = (points) => `M${points.map((point) => `${x(point.seconds)},${y(point.value)}`).join(" L")}`;
  return {
    width,
    height,
    actual: line(samples.map((sample) => ({ seconds: sample.offsetSeconds, value: sample.queuedJobs }))),
    predicted: line(predicted),
    xTicks: ticks(end, 4).map((value) => ({ value, x: x(value) })),
    yTicks: ticks(top, 2).map((value) => ({ value, y: y(value) })),
  };
}

/** Share of the comparison finished so far, from live progress. */
export function comparisonProgress(comparison) {
  const runs = comparison?.runs ?? [];
  if (runs.length === 0) return 0;
  const done = runs.filter((run) => !["PENDING", "RUNNING"].includes(run.status)).length;
  const live = comparison.progress;
  const current = live && live.totalJobs > 0 ? live.finishedJobs / live.totalJobs : 0;
  const running = runs.some((run) => run.status === "RUNNING") ? current : 0;
  return Math.min(1, (done + running) / runs.length);
}
