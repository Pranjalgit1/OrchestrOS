import { useCallback, useEffect, useRef, useState } from "react";
import {
  MIXED_COMPUTE_TYPES,
  STATE_CHANGED_EVENT,
  abortBenchmark,
  fetchBenchmarks,
  startBenchmark,
} from "../api";
import { POLICY_LABELS, formatMetric, metricBars, policyClass, suiteProgress } from "../benchmark.chart.js";
import { Icon } from "./Icon.jsx";

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 5_000;

const POLICIES = ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"];
const COUNTS = [10, 25, 50];
const PATTERNS = [
  ["IMMEDIATE", "Immediate · all ready at once"],
  ["HEAVY", "Heavy · 2–6s apart"],
  ["MEDIUM", "Medium · 8–16s apart"],
  ["BURST", "Burst · 5 jobs every 30s"],
  ["INCREASING", "Increasing · ramp up"],
  ["DECREASING", "Decreasing · ramp down"],
  ["PERIODIC", "Periodic · repeating"],
  ["CONSTANT", "Constant · every 10s"],
  ["LIGHT", "Light · 20–40s apart"],
];
const PROFILES = [
  ["SLEEP", "Sleep · short pauses"],
  ["MIXED_COMPUTE", "Mixed compute"],
  ["CPU_INTENSIVE", "CPU calculations"],
  ["SORTING", "Sorting"],
  ["DATA_PROCESSING", "Data processing"],
  ["MATRIX_MULTIPLICATION", "Matrix products"],
];
const STRATEGIES = [
  ["LEAST_LOADED", "Least Loaded"],
  ["FIRST_FIT", "First Fit"],
  ["RESOURCE_AWARE", "Resource-Aware"],
];
const STATUS_TEXT = {
  PENDING: "Waiting",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  ABORTED: "Stopped",
};
const STATUS_BADGE = {
  PENDING: "badge-idle",
  RUNNING: "badge-busy",
  COMPLETED: "badge-active",
  FAILED: "badge-failed",
  ABORTED: "badge-failed",
};

export const DEFAULT_BENCHMARK_FORM = {
  policies: POLICIES,
  count: 10,
  pattern: "IMMEDIATE",
  profile: "SLEEP",
  strategy: "LEAST_LOADED",
  seed: 42,
  timeQuantumSeconds: 5,
  jobsPerTick: 25,
};

/** The request body the backend validates; the form never decides policy order. */
export function toBenchmarkRequest(form) {
  return {
    policies: POLICIES.filter((policy) => form.policies.includes(policy)),
    count: Number(form.count),
    pattern: form.pattern,
    workloadTypes: form.profile === "MIXED_COMPUTE" ? MIXED_COMPUTE_TYPES : [form.profile],
    strategy: form.strategy,
    seed: Number(form.seed),
    timeQuantumSeconds: Number(form.timeQuantumSeconds),
    jobsPerTick: Number(form.jobsPerTick),
  };
}

const time = (value) => (value ? new Date(value).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
}) : "—");

/** One metric as horizontal bars, best policy drawn solid. Values are also in the table. */
function MetricChart({ metric }) {
  const labelWidth = 96;
  const valueWidth = 84;
  const chart = metricBars(metric.values);
  const width = labelWidth + chart.width + valueWidth;
  const best = new Set(metric.best);
  const summary = metric.values
    .map((entry) => `${POLICY_LABELS[entry.policy]} ${formatMetric(entry.value, metric.unit)}`)
    .join(", ");
  return (
    <article className="tile bench-chart">
      <div className="chart-heading">
        <h3>{metric.label}</h3>
        <span>{metric.better === "lower" ? "Lower is better" : "Higher is better"}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${Math.max(chart.height, 1)}`} role="img"
        aria-label={`${metric.label}: ${summary}.${metric.best.length
          ? ` Best: ${metric.best.map((policy) => POLICY_LABELS[policy]).join(" and ")}.` : " No single winner."}`}>
        {chart.bars.map((bar) => (
          <g key={bar.policy} transform={`translate(0 ${bar.y})`}>
            <text className="bench-label" x={labelWidth - 8} y={chart.barHeight / 2} dominantBaseline="middle"
              textAnchor="end">{POLICY_LABELS[bar.policy]}</text>
            <rect className="bench-track" x={labelWidth} width={chart.width} height={chart.barHeight} rx="3" />
            {bar.measured ? (
              <rect className={`bench-bar ${policyClass(bar.policy)}${best.has(bar.policy) ? " is-best" : ""}`}
                x={labelWidth}
                width={Math.max(bar.width, bar.value > 0 ? 2 : 0)} height={chart.barHeight} rx="3" />
            ) : null}
            <text className="bench-value" x={labelWidth + chart.width + 8} y={chart.barHeight / 2}
              dominantBaseline="middle">
              {formatMetric(bar.value, metric.unit)}{best.has(bar.policy) ? " ★" : ""}
            </text>
          </g>
        ))}
      </svg>
    </article>
  );
}

/** Colour key; the swatch is decorative, the name carries the meaning. */
function PolicyName({ policy }) {
  return (
    <span className="policy-name">
      <span className={`policy-swatch ${policyClass(policy)}`} aria-hidden="true" />
      {POLICY_LABELS[policy]}
    </span>
  );
}

function SuiteResults({ suite }) {
  const { comparison } = suite;
  const finishedPolicies = suite.runs.filter((run) => run.status === "COMPLETED").map((run) => run.policy);
  const charted = comparison.metrics.map((metric) => ({
    ...metric,
    values: metric.values.filter((entry) => finishedPolicies.includes(entry.policy)),
  }));
  return (
    <div className="bench-results">
      <div className="bench-summary">
        <span className={`badge ${STATUS_BADGE[suite.status]}`}>{STATUS_TEXT[suite.status]}</span>
        <span>
          {suite.jobCount} jobs · {suite.pattern.toLowerCase()} · seed {suite.seed} ·{" "}
          {suite.placementStrategy.replace("_", " ").toLowerCase()} · quantum {suite.timeQuantumSeconds}s ·
          started {time(suite.startedAt)}
        </span>
      </div>
      {suite.failureReason ? <p className="warn">{suite.failureReason}</p> : null}

      <div className="table-scroll">
        <table className="grid bench-runs">
          <caption className="sr-only">Runs in this benchmark, in the order they ran</caption>
          <thead>
            <tr>
              <th scope="col">Policy</th>
              <th scope="col">Status</th>
              <th scope="col">Completed</th>
              <th scope="col">Failed</th>
              <th scope="col">Capacity</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {suite.runs.map((run) => (
              <tr key={run.id}>
                <th scope="row"><PolicyName policy={run.policy} /></th>
                <td><span className={`badge ${STATUS_BADGE[run.status]}`}>{STATUS_TEXT[run.status]}</span></td>
                <td>{run.status === "PENDING" ? "—" : `${run.completedJobs}/${run.jobCount}`}</td>
                <td>{run.status === "PENDING" ? "—" : run.failedJobs}</td>
                <td>{run.workerCount === null
                  ? "—" : `${run.workerCount} workers · ${run.cpuCapacityMillicores}m · ${run.memoryCapacityMiB} MiB`}</td>
                <td>{run.failureReason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {comparison.finishedRuns === 0 ? (
        <p className="muted">No run has finished yet, so there is nothing to compare.</p>
      ) : (
        <>
          <p className={comparison.comparable ? "hint" : "hint bench-caution"}>
            {comparison.comparable
              ? "Every run did byte-identical work (matching result checksums) on the same cluster capacity, so the numbers compare directly."
              : comparison.notes.join(" ")}
            {comparison.comparable && comparison.notes.length ? ` ${comparison.notes.join(" ")}` : ""}
          </p>
          <div className="table-scroll">
            <table className="grid bench-table">
              <caption className="sr-only">Measured metrics per policy; the best value per row is marked</caption>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  {finishedPolicies.map((policy) => (
                    <th scope="col" key={policy}><PolicyName policy={policy} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {charted.map((metric) => (
                  <tr key={metric.key}>
                    <th scope="row">{metric.label}</th>
                    {metric.values.map((entry) => (
                      <td key={entry.policy} className={metric.best.includes(entry.policy) ? "is-best" : undefined}>
                        {formatMetric(entry.value, metric.unit)}
                        {metric.best.includes(entry.policy) ? <span className="bench-best"> best</span> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {finishedPolicies.length > 1 ? (
            <ul className="bench-legend" aria-label="Chart colours">
              {finishedPolicies.map((policy) => <li key={policy}><PolicyName policy={policy} /></li>)}
              <li className="bench-legend-best">Outlined bar with ★ = best</li>
            </ul>
          ) : null}
          {finishedPolicies.length > 1 ? (
            <div className="bench-charts">
              {charted.map((metric) => <MetricChart key={metric.key} metric={metric} />)}
            </div>
          ) : null}
          <p className="hint">
            Waiting, turnaround, and response cover completed jobs only. Waiting excludes time spent running,
            so a Round Robin job paused by preemption counts its queue time again. Makespan runs from the first
            arrival to the last completion. ★ and an outline mark the best value; values within a millisecond
            count as a tie.
          </p>
        </>
      )}
    </div>
  );
}

/** Pure view, so every state can be rendered and tested without a backend. */
export function BenchmarkView({
  data, selectedId, onSelect, form, onFormChange, onStart, onAbort, busy = false, error = null,
}) {
  const suites = data?.suites ?? [];
  const activeId = data?.activeSuiteId ?? null;
  const running = activeId !== null;
  const selected = suites.find((suite) => suite.id === (selectedId ?? activeId)) ?? suites[0] ?? null;
  const active = suites.find((suite) => suite.id === activeId) ?? null;
  const locked = running || busy;
  const set = (patch) => onFormChange({ ...form, ...patch });
  const togglePolicy = (policy) => set({
    policies: form.policies.includes(policy)
      ? form.policies.filter((entry) => entry !== policy)
      : [...form.policies, policy],
  });
  return (
    <section className="panel bench-panel" aria-label="Policy benchmark" aria-busy={running}>
      <header className="panel-head">
        <div>
          <p className="eyebrow">Benchmark</p>
          <h2>Policy comparison</h2>
        </div>
        <span className={`badge ${running ? "badge-busy" : "badge-idle"}`}>{running ? "RUNNING" : "IDLE"}</span>
      </header>

      <p className="hint">
        Runs the same seeded workload once per policy through the real scheduler, placement, reservation, and
        Docker pipeline, one policy after another. It needs an idle cluster. While it runs, the controls that
        would change its work are locked and autoscaling is held so capacity stays fixed.
      </p>

      <form className="bench-form" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
        <fieldset className="bench-policies" disabled={locked}>
          <legend>Policies</legend>
          {POLICIES.map((policy) => (
            <label key={policy}>
              <input type="checkbox" checked={form.policies.includes(policy)}
                onChange={() => togglePolicy(policy)} />
              {POLICY_LABELS[policy]}
            </label>
          ))}
        </fieldset>
        <label htmlFor="bench-count">Jobs
          <select id="bench-count" value={form.count} disabled={locked}
            onChange={(event) => set({ count: Number(event.target.value) })}>
            {COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label htmlFor="bench-pattern">Arrival pattern
          <select id="bench-pattern" value={form.pattern} disabled={locked}
            onChange={(event) => set({ pattern: event.target.value })}>
            {PATTERNS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="bench-profile">Workload type
          <select id="bench-profile" value={form.profile} disabled={locked}
            onChange={(event) => set({ profile: event.target.value })}>
            {PROFILES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="bench-strategy">Placement
          <select id="bench-strategy" value={form.strategy} disabled={locked}
            onChange={(event) => set({ strategy: event.target.value })}>
            {STRATEGIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="bench-seed">Seed
          <input id="bench-seed" type="number" min={0} max={2147483647} step={1} required value={form.seed}
            disabled={locked} onChange={(event) => set({ seed: event.target.value })} />
        </label>
        <label htmlFor="bench-quantum">Round Robin quantum (s)
          <input id="bench-quantum" type="number" min={1} max={3600} step={1} required
            value={form.timeQuantumSeconds} disabled={locked || !form.policies.includes("ROUND_ROBIN")}
            onChange={(event) => set({ timeQuantumSeconds: event.target.value })} />
        </label>
        <label htmlFor="bench-tick">Jobs started per tick
          <input id="bench-tick" type="number" min={1} max={25} step={1} required value={form.jobsPerTick}
            disabled={locked} onChange={(event) => set({ jobsPerTick: event.target.value })} />
        </label>
        <div className="stage-buttons bench-actions">
          {running ? (
            <button type="button" className="btn btn-stop" disabled={busy || active?.abortRequested}
              onClick={() => onAbort(activeId)}>
              <Icon name="stop" />{active?.abortRequested ? "Stopping…" : "Stop benchmark"}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy || form.policies.length === 0}>
              <Icon name="play" />{busy ? "Starting…" : `Run ${form.policies.length} ${form.policies.length === 1 ? "policy" : "policies"}`}
            </button>
          )}
        </div>
      </form>

      {error ? <p className="warn" role="alert">{error}</p> : null}

      {active?.progress ? (
        <div className="bench-progress" role="status">
          <span>
            Running {POLICY_LABELS[active.progress.policy]} ({active.progress.position + 1} of{" "}
            {active.progress.totalRuns}) · {active.progress.finishedJobs}/{active.progress.totalJobs} jobs finished
          </span>
          <progress max={100} value={Math.round(suiteProgress(active) * 100)}
            aria-label="Benchmark progress">{Math.round(suiteProgress(active) * 100)}%</progress>
        </div>
      ) : running ? (
        <p className="muted" role="status">Preparing the first run…</p>
      ) : null}

      {selected ? <SuiteResults suite={selected} /> : (
        <p className="muted">{data ? "No benchmarks yet. Choose policies and run one." : "Loading benchmarks…"}</p>
      )}

      {suites.length > 1 ? (
        <details className="stage-controls">
          <summary>Earlier benchmarks ({suites.length})</summary>
          <div className="table-scroll">
            <table className="grid">
              <caption className="sr-only">Recent benchmarks, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Setup</th>
                  <th scope="col">Policies</th>
                  <th scope="col"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {suites.map((suite) => (
                  <tr key={suite.id}>
                    <td><time dateTime={suite.startedAt}>{time(suite.startedAt)}</time></td>
                    <td><span className={`badge ${STATUS_BADGE[suite.status]}`}>{STATUS_TEXT[suite.status]}</span></td>
                    <td>{suite.jobCount} jobs · {suite.pattern.toLowerCase()} · seed {suite.seed}</td>
                    <td>{suite.runs.map((run) => POLICY_LABELS[run.policy]).join(", ")}</td>
                    <td>
                      <button type="button" className="btn btn-ghost" aria-pressed={suite.id === selected?.id}
                        onClick={() => onSelect(suite.id)}>
                        {suite.id === selected?.id ? "Showing" : "Show"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** Polls the backend and owns the form; all measurement happens server-side. */
export function BenchmarkPanel() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(DEFAULT_BENCHMARK_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal) => {
    try {
      const next = await fetchBenchmarks(signal);
      if (mounted.current) setData(next);
    } catch (reason) {
      if (signal?.aborted || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to read benchmarks");
    }
  }, []);
  const running = Boolean(data?.activeSuiteId);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), running ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    const onStateChanged = () => void refresh(controller.signal);
    window.addEventListener(STATE_CHANGED_EVENT, onStateChanged);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener(STATE_CHANGED_EVENT, onStateChanged);
    };
  }, [refresh, running]);
  const act = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
      await refresh();
    }
  };
  return (
    <BenchmarkView
      data={data}
      selectedId={selectedId}
      onSelect={setSelectedId}
      form={form}
      onFormChange={setForm}
      busy={busy}
      error={error}
      onStart={() => act(async () => {
        const suite = await startBenchmark(toBenchmarkRequest(form));
        setSelectedId(suite.id);
      })}
      onAbort={(id) => act(() => abortBenchmark(id))}
    />
  );
}
