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
