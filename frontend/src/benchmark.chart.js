/** Pure helpers for the benchmark comparison: no React, no fetch. */

export const POLICY_LABELS = {
  FCFS: "FCFS",
  SJF: "SJF",
  PRIORITY: "Priority",
  ROUND_ROBIN: "Round Robin",
};

const POLICY_CLASSES = {
  FCFS: "policy-fcfs",
  SJF: "policy-sjf",
  PRIORITY: "policy-priority",
  ROUND_ROBIN: "policy-rr",
};

/** CSS class giving a policy its chart colour, the same in every chart and table. */
export function policyClass(policy) {
  return POLICY_CLASSES[policy] ?? "policy-other";
}

/** Formats one stored metric for display; null stays visibly unmeasured. */
export function formatMetric(value, unit) {
  if (value === null || value === undefined) return "—";
  if (unit === "s") return `${(Math.round(value * 100) / 100).toFixed(2)}s`;
  if (unit === "jobs/min") return `${(Math.round(value * 10) / 10).toFixed(1)}/min`;
  return String(Math.round(value));
}

/**
 * Horizontal bar geometry for one metric across policies. Bars share a zero
 * baseline and scale to the largest measured value, so lengths compare
 * honestly; an unmeasured value gets no bar rather than a zero-length one.
 */
export function metricBars(values, { width = 320, barHeight = 22, gap = 10 } = {}) {
  const measured = values.filter((entry) => entry.value !== null && entry.value !== undefined);
  const max = Math.max(0, ...measured.map((entry) => entry.value));
  const bars = values.map((entry, index) => {
    const hasValue = entry.value !== null && entry.value !== undefined;
    const length = !hasValue ? 0 : max === 0 ? 0 : (entry.value / max) * width;
    return {
      policy: entry.policy,
      value: hasValue ? entry.value : null,
      y: index * (barHeight + gap),
      width: Math.round(length * 10) / 10,
      measured: hasValue,
    };
  });
  return { bars, max, height: Math.max(0, values.length * (barHeight + gap) - gap), width, barHeight };
}

const MINUS = "\u2212";

/** "−10%" for a value 10% below the baseline; null when there is nothing meaningful to compare. */
export function percentChange(value, baseline) {
  if (value === null || value === undefined || baseline === null || baseline === undefined || baseline === 0) return null;
  const percent = Math.round(((value - baseline) / Math.abs(baseline)) * 100);
  if (percent === 0) return "0%";
  return `${percent > 0 ? "+" : MINUS}${Math.abs(percent)}%`;
}

/** Bar widths (0–100) on one shared zero baseline; an unmeasured value gets no bar. */
export function barWidths(values) {
  const max = Math.max(0, ...values.map((entry) => entry.value ?? 0));
  return values.map((entry) => (entry.value === null || entry.value === undefined || max === 0
    ? 0 : Math.round((entry.value / max) * 1000) / 10));
}

/** True when every policy measured exactly the same value, so bars would only add noise. */
export function allEqual(values) {
  const measured = values.filter((entry) => entry.value !== null && entry.value !== undefined);
  return measured.length > 1 && measured.length === values.length
    && measured.every((entry) => entry.value === measured[0].value);
}

const listText = (items) => (items.length <= 1 ? items.join("")
  : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * One or two sentences on what the results say: which policy won most metrics
 * and in which areas, and where another policy did better. Built only from the
 * backend's per-metric winners, so ties are never called wins.
 */
export function resultSummary(comparison) {
  const metrics = comparison?.metrics ?? [];
  const wins = new Map();
  for (const metric of metrics) {
    if (metric.best.length === 1) {
      const policy = metric.best[0];
      wins.set(policy, [...(wins.get(policy) ?? []), metric]);
    }
  }
  if (wins.size === 0) return "Every metric was a tie: the policies performed the same on this workload.";
  const ranked = [...wins.entries()].sort((left, right) => right[1].length - left[1].length);
  const [leader, leaderWins] = ranked[0];
  const areas = [];
  if (leaderWins.some((metric) => /Wait/.test(metric.key))) areas.push("shorter waits");
  if (leaderWins.some((metric) => /Turnaround/.test(metric.key))) areas.push("turnaround");
  if (leaderWins.some((metric) => /Response/.test(metric.key))) areas.push("response time");
  if (leaderWins.some((metric) => metric.key === "makespanSeconds" || metric.key === "throughputPerMinute")) areas.push("total time");
  const tied = ranked.length > 1 && ranked[1][1].length === leaderWins.length;
  let text = tied
    ? `${POLICY_LABELS[leader]} and ${POLICY_LABELS[ranked[1][0]]} each win ${leaderWins.length} of ${metrics.length} metrics.`
    : `${POLICY_LABELS[leader]} wins ${leaderWins.length} of ${metrics.length} metrics${areas.length ? ` with ${listText(areas)}` : ""}.`;
  const makespan = metrics.find((metric) => metric.key === "makespanSeconds");
  const others = ranked.slice(tied ? 2 : 1);
  if (makespan?.best.length === 1 && makespan.best[0] !== leader && !tied) {
    const winner = makespan.best[0];
    const won = makespan.values.find((entry) => entry.policy === winner)?.value;
    const lost = makespan.values.find((entry) => entry.policy === leader)?.value;
    const gap = won !== null && won !== undefined && lost !== null && lost !== undefined ? lost - won : null;
    text += ` ${POLICY_LABELS[winner]} finished the whole batch${gap !== null ? ` ${formatMetric(gap, "s")}` : ""} sooner.`;
  } else if (others.length) {
    const [policy, policyWins] = others[0];
    text += ` ${POLICY_LABELS[policy]} was better on ${listText(policyWins.map((metric) => metric.label.toLowerCase()))}.`;
  }
  return text;
}

/** The planned policies of a suite that did not complete, in run order. */
export function unfinishedPolicies(suite) {
  return (suite?.runs ?? []).filter((run) => run.status !== "COMPLETED").map((run) => run.policy);
}

/** Share of a suite's planned work finished so far, from live progress. */
export function suiteProgress(suite) {
  const runs = suite?.runs ?? [];
  if (runs.length === 0) return 0;
  const done = runs.filter((run) => !["PENDING", "RUNNING"].includes(run.status)).length;
  const live = suite.progress;
  const current = live && live.totalJobs > 0 ? live.finishedJobs / live.totalJobs : 0;
  const running = runs.some((run) => run.status === "RUNNING") ? current : 0;
  return Math.min(1, (done + running) / runs.length);
}
