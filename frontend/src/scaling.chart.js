/**
 * Pure helpers for the Reactive-vs-ML autoscaling comparison: wording,
 * number formatting, summary rows, and chart geometry. No React, no fetch.
 * Every value shown comes from the backend; these helpers only format and
 * position it.
 */

export const STRATEGY_LABELS = { REACTIVE: "Reactive", ML: "ML-assisted" };
export const STRATEGY_NAMES = { REACTIVE: "Reactive autoscaling", ML: "ML-assisted autoscaling" };
export const STRATEGY_ORDER = ["REACTIVE", "ML"];

/** One-line description of how each strategy decides, true to the implementation. */
export function strategyDescription(strategy, settings = {}) {
  if (strategy === "ML") {
    return `Forecasts waiting jobs and utilization ${settings.mlLookAheadSeconds ?? 60}s ahead with linear ` +
      "regression, then scales before the load arrives.";
  }
  return "Rule-based. Scales on what it sees right now: waiting jobs and reserved capacity.";
}

/** CSS class giving a strategy its colour, the same in every card, chart, and table. */
export function strategyClass(strategy) {
  return strategy === "ML" ? "strategy-ml" : "strategy-reactive";
}

export const NA = "N/A";

/** Seconds as "42.5s" or, from two minutes, "4m 05s". */
export function formatSeconds(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return NA;
  if (Math.abs(value) < 120) return `${(Math.round(value * 10) / 10).toFixed(1)}s`;
  const total = Math.round(Math.abs(value));
  return `${value < 0 ? "-" : ""}${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** One stored metric for display; an unmeasured value shows as N/A, never as zero. */
export function formatValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return NA;
  if (unit === "s" || unit === "signed-s") return formatSeconds(value);
  if (unit === "worker-s") return `${Math.round(value)} worker-s`;
  return String(Math.round(value));
}

/** When the first extra worker arrived, relative to the backlog, in words. */
export function reactionText(outcome, seconds) {
  if (outcome === "BEFORE_ANY_BACKLOG") return "Before any backlog formed";
  if (outcome === "NEVER_SCALED_UP") return "Never added a worker";
  if (outcome === "NOT_NEEDED") return "Not needed: no backlog";
  if (seconds === null || seconds === undefined) return NA;
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
    p95WaitSeconds: "The wait of the unluckiest 5% of jobs.",
    avgTurnaroundSeconds: "From a job arriving to it finishing, on average.",
    makespanSeconds: "From the first job arriving to the last one finishing.",
    reactionSeconds: "When the first extra worker arrived, compared with the moment jobs started piling up.",
    backedUpSeconds: `How long ${threshold} or more jobs were waiting at the same time.`,
    extraWorkerSeconds: "Extra workers multiplied by the seconds they were switched on.",
    idleExtraWorkerSeconds: "The part of that extra capacity that sat idle.",
    scaleActions: "Workers added plus workers retired.",
    flaps: "Workers added back within a minute of being retired.",
  }[key] ?? "";
}

/** "ML-Assisted · 33% less", "About the same", or "—" before both runs finish. */
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
      detail: "The verdict appears once the Reactive and the ML-assisted run have both completed." };
  }
  const ml = STRATEGY_LABELS.ML;
  if (wait === "TIE" && cost === "TIE") {
    return { tone: "tie", title: "Both strategies performed about the same.",
      detail: "Waiting times and extra capacity were within a few percent of each other on this workload." };
  }
  if (wait === "ML" && cost !== "REACTIVE") {
    return { tone: "ml", title: `${ml} did better on this workload.`,
      detail: "Jobs waited less, without using more extra capacity." };
  }
  if (wait === "REACTIVE" && cost !== "ML") {
    return { tone: "reactive", title: "Reactive did better on this workload.",
      detail: "Jobs waited less, without using more extra capacity. Predicting ahead did not help here." };
  }
  if (wait === "ML" && cost === "REACTIVE") {
    return { tone: "tradeoff", title: `${ml} was faster. Reactive used less capacity.`,
      detail: "ML-assisted shortened waits by adding or keeping extra workers longer." };
  }
  if (wait === "REACTIVE" && cost === "ML") {
    return { tone: "tradeoff", title: `Reactive was faster. ${ml} used less capacity.`,
      detail: "Reactive kept waits shorter; ML-assisted saved extra worker time." };
  }
  // Same waiting time, different cost.
  const cheaper = cost === "ML" ? ml : "Reactive";
  return { tone: cost === "ML" ? "ml" : "reactive", title: `${cheaper} did the same job with less capacity.`,
    detail: "Waiting times were about the same, but it used less extra worker time." };
}

const metricByKey = (comparison, key) => comparison?.metrics?.find((metric) => metric.key === key) ?? null;

/**
 * The Key Takeaway: the verdict plus up to two sentences quoting the measured
 * values behind it, so the claim can be checked at a glance.
 */
export function keyTakeaway(comparison) {
  const base = headline(comparison);
  if (base.tone === "pending") return { ...base, points: [] };
  const points = [];
  const wait = metricByKey(comparison, "avgWaitSeconds");
  if (wait && wait.reactive !== null && wait.ml !== null) {
    if (wait.winner === "TIE" || !wait.winner) {
      points.push(`Average wait was about the same (${formatSeconds(wait.reactive)} vs ` +
        `${formatSeconds(wait.ml)}).`);
    } else {
      const won = wait.winner === "ML" ? wait.ml : wait.reactive;
      const lost = wait.winner === "ML" ? wait.reactive : wait.ml;
      const percent = lost ? Math.round(((lost - won) / lost) * 100) : 0;
      points.push(`${STRATEGY_LABELS[wait.winner]} kept average wait ${percent}% shorter ` +
        `(${formatSeconds(won)} vs ${formatSeconds(lost)}).`);
    }
  }
  const cost = metricByKey(comparison, "extraWorkerSeconds");
  if (cost && cost.reactive !== null && cost.ml !== null) {
    if (cost.winner === "TIE" || !cost.winner) {
      points.push(`Both used about the same extra capacity (${Math.round(cost.reactive)} and ` +
        `${Math.round(cost.ml)} worker-seconds).`);
    } else {
      const won = cost.winner === "ML" ? cost.ml : cost.reactive;
      const lost = cost.winner === "ML" ? cost.reactive : cost.ml;
      points.push(`${STRATEGY_LABELS[cost.winner]} needed ${Math.round(lost - won)} fewer extra worker-seconds.`);
    }
  }
  return { ...base, points };
}

const UNFINISHED = ["PENDING", "RUNNING"];
const runFor = (runs, strategy) => runs?.find((run) => run.strategy === strategy) ?? null;
const scaleActions = (run) => (run.scaleUps ?? 0) + (run.scaleDowns ?? 0);

/** Rows of the Results table, in the order they are shown. */
export const SUMMARY_ROWS = [
  { key: "avgWaitSeconds", label: "Avg. wait time", unit: "s" },
  { key: "p95WaitSeconds", label: "Slowest 5% wait", unit: "s" },
  { key: "avgTurnaroundSeconds", label: "Avg. turnaround", unit: "s" },
  { key: "makespanSeconds", label: "Time to finish all jobs", unit: "s" },
  { key: "extraWorkerSeconds", label: "Extra capacity", unitNote: "worker-s", unit: "worker-s" },
  { key: "peakWorkers", label: "Peak workers", unit: "count" },
  { key: "scaleActions", label: "Scaling changes", unit: "count" },
];

/**
 * The backend's tie rule (scaling-comparison.metrics.js), for the one row the
 * backend does not judge: a gap under 5%, or under the absolute floor, is a tie.
 */
const TIE_FLOOR = { s: 0.5, "worker-s": 5, count: 0.5 };
function judgeLower(reactive, ml, unit) {
  const gap = Math.abs(reactive - ml);
  if (gap < (TIE_FLOOR[unit] ?? 0) || gap <= 0.05 * Math.max(Math.abs(reactive), Math.abs(ml))) return "TIE";
  return ml < reactive ? "ML" : "REACTIVE";
}

const MINUS = "\u2212";
const signed = (value, suffix = "") => `${value > 0 ? "+" : value < 0 ? MINUS : ""}${Math.abs(value)}${suffix}`;

/**
 * Results rows: both values, the ML-assisted change relative to Reactive,
 * and which strategy did better. Lower is better for every row. Winners come
 * from the backend's verdicts, which treat gaps under 5% as a tie; peak
 * workers, which the backend stores but does not judge, uses the same rule.
 * Seconds compare as a percentage; counts and worker-seconds as an absolute
 * difference, since a percentage of zero means nothing.
 */
export function summaryRows(comparison, runs) {
  const reactiveRun = runFor(runs, "REACTIVE");
  const mlRun = runFor(runs, "ML");
  const done = (run) => run?.status === "COMPLETED";
  return SUMMARY_ROWS.map((row) => {
    const metric = metricByKey(comparison, row.key);
    const fromRun = (run) => {
      if (!done(run)) return null;
      if (row.key === "scaleActions") return scaleActions(run);
      return run[row.key] ?? null;
    };
    const reactive = metric ? metric.reactive : fromRun(reactiveRun);
    const ml = metric ? metric.ml : fromRun(mlRun);
    let difference = null;
    let direction = null;
    const both = reactive !== null && reactive !== undefined && ml !== null && ml !== undefined;
    if (both) {
      const gap = ml - reactive;
      direction = Math.abs(gap) < 1e-9 ? null : gap > 0 ? "up" : "down";
      if (row.unit === "s" && reactive !== 0) {
        difference = signed(Math.round((gap / Math.abs(reactive)) * 100), "%");
      } else if (row.unit === "s") {
        difference = signed(Math.round(gap * 10) / 10, "s");
      } else {
        difference = signed(Math.round(gap));
      }
    }
    return {
      ...row,
      reactive: reactive ?? null,
      ml: ml ?? null,
      reactiveText: formatValue(reactive, row.unit === "worker-s" ? "count" : row.unit),
      mlText: formatValue(ml, row.unit === "worker-s" ? "count" : row.unit),
      difference: difference ?? NA,
      direction,
      winner: metric ? metric.winner ?? null
        : row.key === "peakWorkers" && both && done(reactiveRun) && done(mlRun) ? judgeLower(reactive, ml, row.unit) : null,
    };
  });
}

/** Chart metrics the selector offers. Each has its own axis; units are never mixed. */
export const CHART_METRICS = {
  utilization: {
    label: "Resource utilization",
    toggle: "Utilization",
    title: "Resource utilization over time",
    description: "Peak share of cluster CPU or memory reserved by running jobs.",
    value: (sample) => (sample.peakUtilization === null || sample.peakUtilization === undefined
      ? null : sample.peakUtilization * 100),
    format: (value) => `${Math.round(value)}%`,
    fixedMax: 100,
  },
  queue: {
    label: "Jobs waiting",
    toggle: "Jobs waiting",
    title: "Jobs waiting over time",
    description: "Jobs queued and ready to run, waiting for capacity.",
    value: (sample) => sample.queuedJobs ?? null,
    format: (value) => String(Math.round(value * 10) / 10),
    integer: true,
  },
  workers: {
    label: "Workers in service",
    toggle: "Workers",
    title: "Workers in service over time",
    description: "Base and extra workers available to run jobs.",
    value: (sample) => sample.workersInService ?? null,
    format: (value) => String(Math.round(value)),
    integer: true,
    step: true,
  },
};

/** One run's stored timeline as chart points, oldest first; samples without a value are skipped. */
export function runPoints(run, metricKey) {
  const metric = CHART_METRICS[metricKey];
  return (run?.samples ?? [])
    .map((sample) => ({ t: sample.offsetSeconds, v: metric.value(sample) }))
    .filter((point) => typeof point.t === "number" && typeof point.v === "number" && !Number.isNaN(point.v))
    .sort((left, right) => left.t - right.t);
}

/**
 * The ML forecast as chart points: each prediction is placed at the moment it
 * was predicting (its time plus the look-ahead), and only while the run was
 * still measuring, so it can be checked against the measured queue.
 */
export function forecastPoints(run, lookAheadSeconds) {
  const samples = run?.samples ?? [];
  const end = samples.at(-1)?.offsetSeconds ?? 0;
  return samples
    .filter((sample) => typeof sample.forecastQueuedJobs === "number")
    .map((sample) => ({ t: sample.offsetSeconds + lookAheadSeconds, v: sample.forecastQueuedJobs }))
    .filter((point) => point.t <= end)
    .sort((left, right) => left.t - right.t);
}

/** Time ticks: a round step giving at most six intervals, ending at or past the data. */
export function timeTicks(maxSeconds) {
  const max = Math.max(1, maxSeconds);
  const step = [1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 180, 300, 600, 900, 1800]
    .find((candidate) => Math.ceil(max / candidate) <= 6) ?? 3600;
  const count = Math.max(1, Math.ceil(max / step));
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

/** Value ticks from zero: a round step giving at most five intervals. */
export function valueTicks(maxValue, { integer = false, fixedMax = null } = {}) {
  if (fixedMax !== null) return Array.from({ length: 6 }, (_, index) => (fixedMax / 5) * index);
  const max = Math.max(integer ? 1 : 0.5, maxValue);
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.filter((candidate) => !integer || Number.isInteger(candidate))
    .find((candidate) => Math.ceil(max / candidate) <= 5) ?? 1000;
  const count = Math.max(1, Math.ceil(max / step));
  return Array.from({ length: count + 1 }, (_, index) => Math.round(index * step * 100) / 100);
}

const round1 = (value) => Math.round(value * 10) / 10;

/** Default plot margins: room for tick labels and the time-axis title so nothing overlaps. */
export const CHART_MARGIN = { top: 12, right: 16, bottom: 44, left: 44 };

/**
 * Pixel geometry for a time-series chart at its real rendered size, so text
 * stays the same size at every width. All series share one time axis and one
 * value axis.
 */
export function buildChart(series, {
  width, height, fixedMax = null, integer = false, step = false, threshold = null, margin = CHART_MARGIN,
}) {
  const plot = {
    left: margin.left,
    top: margin.top,
    width: Math.max(40, width - margin.left - margin.right),
    height: Math.max(40, height - margin.top - margin.bottom),
  };
  plot.right = plot.left + plot.width;
  plot.bottom = plot.top + plot.height;
  const all = series.flatMap((entry) => entry.points);
  const xTickValues = timeTicks(Math.max(0, ...all.map((point) => point.t)));
  const xMax = xTickValues.at(-1);
  const yTickValues = valueTicks(Math.max(0, threshold ?? 0, ...all.map((point) => point.v)), { integer, fixedMax });
  const yMax = yTickValues.at(-1);
  const x = (t) => round1(plot.left + (Math.max(0, t) / xMax) * plot.width);
  const y = (v) => round1(plot.bottom - (Math.max(0, Math.min(v, yMax)) / yMax) * plot.height);

  const lines = series.map((entry) => {
    const points = entry.points.map((point) => ({ ...point, x: x(point.t), y: y(point.v) }));
    if (points.length === 0) return { ...entry, points, path: "", area: "" };
    let path = `M${points[0].x},${points[0].y}`;
    for (let index = 1; index < points.length; index += 1) {
      path += step
        ? ` H${points[index].x} V${points[index].y}`
        : ` L${points[index].x},${points[index].y}`;
    }
    const area = `${path} L${points.at(-1).x},${plot.bottom} L${points[0].x},${plot.bottom} Z`;
    return { ...entry, points, path, area };
  });

  return {
    width,
    height,
    plot,
    xMax,
    yMax,
    xTicks: xTickValues.map((value) => ({ value, x: x(value) })),
    yTicks: yTickValues.map((value) => ({ value, y: y(value) })),
    thresholdY: threshold === null ? null : y(threshold),
    lines,
    timeAt: (px) => Math.max(0, Math.min(xMax, ((px - plot.left) / plot.width) * xMax)),
  };
}

/** Every distinct sample time across the series, ascending: where the cursor can stop. */
export function hoverTimes(series) {
  const times = [...new Set(series.flatMap((entry) => entry.points.map((point) => round1(point.t))))];
  return times.sort((left, right) => left - right);
}

/** Index of the hover time closest to `t`. */
export function nearestTimeIndex(times, t) {
  if (times.length === 0) return -1;
  let best = 0;
  for (let index = 1; index < times.length; index += 1) {
    if (Math.abs(times[index] - t) < Math.abs(times[best] - t)) best = index;
  }
  return best;
}

/**
 * The sample of a series nearest to `t`, or null when none is within the
 * tolerance (for example after that run had finished). Values are never
 * interpolated, so a tooltip only shows what was measured.
 */
export function pointAt(points, t) {
  if (points.length === 0) return null;
  const gaps = points.slice(1).map((point, index) => point.t - points[index].t).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 2;
  const tolerance = Math.max(1, median * 0.75);
  let best = null;
  for (const point of points) {
    const gap = Math.abs(point.t - t);
    if (gap <= tolerance && (!best || gap < Math.abs(best.t - t))) best = point;
  }
  return best;
}

/**
 * Left edge for a tooltip `tooltipWidth` wide beside the cursor, kept inside
 * a chart `width` wide: it flips to the left of the cursor near the right edge.
 */
export function tooltipLeft(cursorX, tooltipWidth, width) {
  const preferred = cursorX + 14 + tooltipWidth <= width - 4 ? cursorX + 14 : cursorX - 14 - tooltipWidth;
  return Math.max(4, Math.min(preferred, width - tooltipWidth - 4));
}

/** Share of the comparison finished so far, from live progress. */
export function comparisonProgress(comparison) {
  const runs = comparison?.runs ?? [];
  if (runs.length === 0) return 0;
  const done = runs.filter((run) => !UNFINISHED.includes(run.status)).length;
  const live = comparison.progress;
  const current = live && live.totalJobs > 0 ? live.finishedJobs / live.totalJobs : 0;
  const running = runs.some((run) => run.status === "RUNNING") ? current : 0;
  return Math.min(1, (done + running) / runs.length);
}

/** File name for an exported comparison, for example orchestros-comparison-increasing-seed42-2026-11-01.json. */
export function exportFileName(comparison) {
  const day = (comparison.startedAt ?? new Date().toISOString()).slice(0, 10);
  return `orchestros-comparison-${String(comparison.pattern).toLowerCase()}-seed${comparison.seed}-${day}.json`;
}
