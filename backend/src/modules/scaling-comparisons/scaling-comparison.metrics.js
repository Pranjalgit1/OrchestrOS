import { round3 } from "../benchmarks/benchmark.metrics.js";

/**
 * Pure arithmetic for a Reactive-vs-ML autoscaling comparison: no Prisma, no
 * clock, no Docker.
 *
 * A run is described by its timeline samples (load and workers every couple
 * of seconds) and the scaling actions the autoscaler recorded while it ran.
 * Time-weighted values treat each sample as holding until the next one.
 */

/** A worker added back this soon after a retirement counts as a flap. */
export const FLAP_WINDOW_SECONDS = 60;

const ms = (date) => date.getTime();

/** Integrates `valueOf(sample)` over time, each sample holding until the next. */
function integrate(samples, valueOf, endedAt) {
  let total = 0;
  samples.forEach((sample, index) => {
    const until = samples[index + 1]?.at ?? endedAt;
    const span = (ms(until) - ms(sample.at)) / 1_000;
    if (span > 0) total += valueOf(sample) * span;
  });
  return total;
}

/** The measured sample closest to `target`, if one is within `toleranceMs`. */
function nearest(samples, target, toleranceMs) {
  let best = null;
  for (const sample of samples) {
    const gap = Math.abs(ms(sample.at) - target);
    if (gap <= toleranceMs && (!best || gap < best.gap)) best = { sample, gap };
  }
  return best?.sample ?? null;
}

/**
 * Scaling behaviour of one run.
 *
 * - pressureAt: the first sample where the reactive rule would fire, that is
 *   at least the scale-up threshold of jobs waiting on a cluster at or above
 *   the scale-up utilization.
 * - reactionSeconds: first scale-up minus pressureAt. Negative means a worker
 *   was added before the pressure was measured.
 * - backedUpSeconds: time at least the threshold of jobs were waiting.
 * - extraWorkerSeconds: autoscaled workers in service, integrated over time;
 *   idleExtraWorkerSeconds is the part when they held nothing.
 * - forecast error: each ML forecast is matched with the queue actually
 *   measured `lookAheadSeconds` later, and the absolute gaps are averaged.
 */
export function measureScaling({ samples, actions, settings, endedAt, sampleIntervalMs = 2_000 }) {
  const timeline = [...samples].sort((left, right) => ms(left.at) - ms(right.at));
  const events = [...actions].sort((left, right) => ms(left.at) - ms(right.at));
  const threshold = settings.scaleUpQueueThreshold;
  const pressure = timeline.find((sample) =>
    sample.queuedJobs >= threshold && sample.peakUtilization >= settings.scaleUpUtilization) ?? null;
  const ups = events.filter((event) => event.action === "SCALE_UP");
  const downs = events.filter((event) => event.action === "SCALE_DOWN");
  const firstUp = ups[0] ?? null;

  const flaps = ups.filter((up) => downs.some((down) =>
    ms(down.at) <= ms(up.at) && ms(up.at) - ms(down.at) <= FLAP_WINDOW_SECONDS * 1_000)).length;

  const lookAheadMs = (settings.mlLookAheadSeconds ?? 0) * 1_000;
  const errors = [];
  for (const sample of timeline) {
    if (sample.forecastQueuedJobs === null || sample.forecastQueuedJobs === undefined) continue;
    const target = ms(sample.at) + lookAheadMs;
    if (target > ms(endedAt)) continue;
    const actual = nearest(timeline, target, sampleIntervalMs * 1.5);
    if (actual) errors.push(Math.abs(sample.forecastQueuedJobs - actual.queuedJobs));
  }

  const hasTimeline = timeline.length > 0;
  return {
    pressureAt: pressure?.at ?? null,
    firstScaleUpAt: firstUp?.at ?? null,
    reactionSeconds: pressure && firstUp ? round3((ms(firstUp.at) - ms(pressure.at)) / 1_000) : null,
    backedUpSeconds: hasTimeline
      ? round3(integrate(timeline, (sample) => (sample.queuedJobs >= threshold ? 1 : 0), endedAt)) : null,
    extraWorkerSeconds: hasTimeline ? round3(integrate(timeline, (sample) => sample.extraWorkers, endedAt)) : null,
    idleExtraWorkerSeconds: hasTimeline
      ? round3(integrate(timeline, (sample) => sample.idleExtraWorkers, endedAt)) : null,
    peakWorkers: hasTimeline ? Math.max(...timeline.map((sample) => sample.workersInService)) : null,
    scaleUps: ups.length,
    scaleDowns: downs.length,
    flaps,
    forecastMeanAbsError: errors.length
      ? round3(errors.reduce((sum, value) => sum + value, 0) / errors.length) : null,
    forecastPairs: errors.length,
  };
}

/**
 * How a run's first scale-up relates to the pressure, since a single number
 * cannot say "it scaled so early that no backlog ever formed".
 */
export function reactionOutcome(run) {
  if (run.firstScaleUpAt && run.pressureAt) return "MEASURED";
  if (run.firstScaleUpAt) return "BEFORE_ANY_BACKLOG";
  if (run.pressureAt) return "NEVER_SCALED_UP";
  return "NOT_NEEDED";
}

/** Metrics compared side by side, grouped by the question each one answers. */
export const SCALING_METRICS = [
  { key: "avgWaitSeconds", group: "wait", label: "Average waiting time", unit: "s", better: "lower" },
  { key: "p95WaitSeconds", group: "wait", label: "Slowest 5% waiting time", unit: "s", better: "lower" },
  { key: "avgTurnaroundSeconds", group: "wait", label: "Average turnaround", unit: "s", better: "lower" },
  { key: "makespanSeconds", group: "wait", label: "Time to finish all jobs", unit: "s", better: "lower" },
  { key: "reactionSeconds", group: "react", label: "First extra worker", unit: "signed-s", better: "lower" },
  { key: "backedUpSeconds", group: "react", label: "Time with a backlog", unit: "s", better: "lower" },
  { key: "extraWorkerSeconds", group: "cost", label: "Extra worker time", unit: "worker-s", better: "lower" },
  { key: "idleExtraWorkerSeconds", group: "cost", label: "Idle extra worker time", unit: "worker-s", better: "lower" },
  { key: "scaleActions", group: "stability", label: "Scaling changes", unit: "count", better: "lower" },
  { key: "flaps", group: "stability", label: "Quick re-adds (flaps)", unit: "count", better: "lower" },
];

/**
 * Smallest gap that counts as a real difference. Docker timing varies by a
 * few percent between identical runs, so gaps under 5% (or a small absolute
 * floor) count as "about the same" rather than a win.
 */
const ABSOLUTE_FLOOR = { s: 0.5, "signed-s": 0.5, "worker-s": 5, count: 0.5 };
export const RELATIVE_TIE = 0.05;

export function isTie(left, right, unit) {
  const gap = Math.abs(left - right);
  return gap < (ABSOLUTE_FLOOR[unit] ?? 0) || gap <= RELATIVE_TIE * Math.max(Math.abs(left), Math.abs(right));
}

function valueOf(run, key) {
  if (key === "scaleActions") return (run.scaleUps ?? 0) + (run.scaleDowns ?? 0);
  const value = run[key];
  return value === undefined ? null : value;
}

/** Winner of one metric: "REACTIVE", "ML", "TIE", or null when it cannot be judged. */
function judge(metric, reactive, ml) {
  if (metric.key === "reactionSeconds") {
    const left = reactionOutcome(reactive);
    const right = reactionOutcome(ml);
    // Adding capacity before any backlog formed beats reacting to one.
    if (left === "BEFORE_ANY_BACKLOG" && right === "MEASURED") return "REACTIVE";
    if (right === "BEFORE_ANY_BACKLOG" && left === "MEASURED") return "ML";
    if (left === "NEVER_SCALED_UP" && right !== "NEVER_SCALED_UP" && right !== "NOT_NEEDED") return "ML";
    if (right === "NEVER_SCALED_UP" && left !== "NEVER_SCALED_UP" && left !== "NOT_NEEDED") return "REACTIVE";
    if (left !== "MEASURED" || right !== "MEASURED") return null;
  }
  const a = valueOf(reactive, metric.key);
  const b = valueOf(ml, metric.key);
  if (a === null || b === null) return null;
  if (isTie(a, b, metric.unit)) return "TIE";
  const mlBetter = metric.better === "lower" ? b < a : b > a;
  return mlBetter ? "ML" : "REACTIVE";
}

/** Relative change of ML against Reactive, or null when it would not mean anything. */
function change(reactiveValue, mlValue) {
  if (reactiveValue === null || mlValue === null || reactiveValue === 0) return null;
  return round3((mlValue - reactiveValue) / Math.abs(reactiveValue));
}

/**
 * Side-by-side result of one comparison.
 *
 * Each metric gets both values, the ML-vs-Reactive change, and a winner. The
 * two headline verdicts are waiting time (did jobs benefit?) and extra worker
 * time (what did it cost?). Results are only called comparable when both runs
 * completed on the same base cluster and did byte-identical work.
 */
export function compareScaling(runs) {
  const reactive = runs.find((run) => run.strategy === "REACTIVE") ?? null;
  const ml = runs.find((run) => run.strategy === "ML") ?? null;
  const done = (run) => run?.status === "COMPLETED";
  const bothDone = done(reactive) && done(ml);

  const metrics = SCALING_METRICS.map((metric) => {
    const reactiveValue = reactive ? valueOf(reactive, metric.key) : null;
    const mlValue = ml ? valueOf(ml, metric.key) : null;
    return {
      ...metric,
      reactive: done(reactive) ? reactiveValue : null,
      ml: done(ml) ? mlValue : null,
      reactiveOutcome: metric.key === "reactionSeconds" && done(reactive) ? reactionOutcome(reactive) : null,
      mlOutcome: metric.key === "reactionSeconds" && done(ml) ? reactionOutcome(ml) : null,
      change: bothDone ? change(reactiveValue, mlValue) : null,
      winner: bothDone ? judge(metric, reactive, ml) : null,
    };
  });

  const notes = [];
  let fairCapacity = false;
  let identicalWork = false;
  if (bothDone) {
    fairCapacity = reactive.workerCount === ml.workerCount &&
      reactive.cpuCapacityMillicores === ml.cpuCapacityMillicores &&
      reactive.memoryCapacityMiB === ml.memoryCapacityMiB;
    identicalWork = Boolean(reactive.checksumDigest) && reactive.checksumDigest === ml.checksumDigest;
    if (!fairCapacity) notes.push("The two runs started from different base clusters, so timings are not directly comparable.");
    if (!identicalWork) notes.push("Result checksums differed or some jobs did not complete, so the runs did not do identical work.");
  } else {
    const unfinished = runs.filter((run) => !done(run)).length;
    if (unfinished > 0) notes.push(`${unfinished} run(s) have not completed, so there is no winner yet.`);
  }

  const verdict = (key) => metrics.find((metric) => metric.key === key).winner;
  return {
    comparable: bothDone && fairCapacity && identicalWork,
    fairCapacity,
    identicalWork,
    waitVerdict: verdict("avgWaitSeconds"),
    costVerdict: verdict("extraWorkerSeconds"),
    forecast: done(ml)
      ? { meanAbsError: ml.forecastMeanAbsError ?? null, pairs: ml.forecastPairs ?? 0 }
      : null,
    metrics,
    notes,
  };
}
