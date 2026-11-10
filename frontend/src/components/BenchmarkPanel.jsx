import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  MIXED_COMPUTE_TYPES,
  STATE_CHANGED_EVENT,
  abortBenchmark,
  fetchBenchmarks,
  startBenchmark,
} from "../api";
import {
  POLICY_LABELS,
  allEqual,
  barWidths,
  formatMetric,
  percentChange,
  policyClass,
  resultSummary,
  suiteProgress,
  unfinishedPolicies,
} from "../benchmark.chart.js";
import { Icon } from "./Icon.jsx";
import { PageHeader } from "./PageHeader.jsx";

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 5_000;

const POLICIES = ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"];
const COUNTS = [10, 25, 50];
const PATTERNS = [
  ["IMMEDIATE", "Immediate (all at once)"],
  ["HEAVY", "Heavy (2–6s apart)"],
  ["MEDIUM", "Medium (8–16s apart)"],
  ["BURST", "Burst (5 jobs every 30s)"],
  ["INCREASING", "Increasing (ramp up)"],
  ["DECREASING", "Decreasing (ramp down)"],
  ["PERIODIC", "Periodic (repeating)"],
  ["CONSTANT", "Constant (every 10s)"],
  ["LIGHT", "Light (20–40s apart)"],
];
const PROFILES = [
  ["SLEEP", "Sleep, short pauses"],
  ["MIXED_COMPUTE", "Mixed compute"],
  ["CPU_INTENSIVE", "CPU calculations"],
  ["SORTING", "Sorting"],
  ["DATA_PROCESSING", "Data processing"],
  ["MATRIX_MULTIPLICATION", "Matrix products"],
];
const STRATEGIES = [
  ["LEAST_LOADED", "Least loaded"],
  ["FIRST_FIT", "First fit"],
  ["RESOURCE_AWARE", "Resource-aware"],
];
const STATUS_TEXT = { PENDING: "Waiting", RUNNING: "Running", COMPLETED: "Completed", FAILED: "Failed", ABORTED: "Stopped" };

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

/** The exact request behind a stored suite, so "run again" repeats every policy it planned. */
export function rerunBenchmarkRequest(suite) {
  return {
    policies: POLICIES.filter((policy) => suite.runs.some((run) => run.policy === policy)),
    count: suite.jobCount,
    pattern: suite.pattern,
    workloadTypes: suite.workloadTypes,
    strategy: suite.placementStrategy,
    seed: suite.seed,
    timeQuantumSeconds: suite.timeQuantumSeconds,
    jobsPerTick: suite.jobsPerTick,
  };
}

const time = (value) => (value ? new Date(value).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
}) : "—");

/** "25 jobs · immediate · seed 77 · least loaded · quantum 5s · started Oct 22, 08:46 PM" */
export function suiteSetupText(suite) {
  const placement = STRATEGIES.find(([value]) => value === suite.placementStrategy)?.[1] ?? suite.placementStrategy;
  return [`${suite.jobCount} jobs`, String(suite.pattern).toLowerCase(), `seed ${suite.seed}`, placement.toLowerCase(),
    `quantum ${suite.timeQuantumSeconds}s`, `started ${time(suite.startedAt)}`].join(" · ");
}

/** Colour dot plus name; the dot is decorative, the name carries the meaning. */
function PolicyName({ policy }) {
  return (
    <span className="policy-name">
      <span className={`policy-swatch ${policyClass(policy)}`} aria-hidden="true" />
      {POLICY_LABELS[policy] ?? policy}
    </span>
  );
}

function RunStatus({ status }) {
  return (
    <span className={`bench-status bench-status-${status.toLowerCase()}`}>
      <span aria-hidden="true">{status === "COMPLETED" ? "✓" : status === "PENDING" ? "○" : "●"}</span>
      {STATUS_TEXT[status] ?? status}
    </span>
  );
}

const plural = (count, one, many) => (count === 1 ? one : many);
const listText = (items) => (items.length <= 1 ? items.join("")
  : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The suite on screen: status, setup, why it stopped early, and each run's outcome. */
function SuiteCard({ suite, latest, busy, running, onRerun }) {
  const { comparison } = suite;
  const missing = unfinishedPolicies(suite);
  const stoppedEarly = (suite.status === "ABORTED" || suite.status === "FAILED") && missing.length > 0;
  const names = missing.map((policy) => POLICY_LABELS[policy] ?? policy);
  return (
    <section className="card bench-run" aria-label={latest ? "Latest run" : "Earlier run"}>
      <header className="card-head">
        <div className="bench-run-title">
          <h2>{latest ? "Latest run" : "Earlier run"}</h2>
          <RunStatus status={suite.status} />
        </div>
        <p className="mono bench-run-setup">{suiteSetupText(suite)}</p>
      </header>

      {stoppedEarly ? (
        <div className="bench-alert" role="status">
          <Icon name="info" />
          <div>
            <strong>{suite.failureReason ?? "This benchmark stopped before every policy ran."}</strong>
            <p>
              {listText(names)} didn't finish and {plural(missing.length, "is", "are")} left out of the results below.
              Run {plural(missing.length, "it", "them")} again to compare all {suite.runs.length}.
            </p>
          </div>
          {onRerun ? (
            <button type="button" className="link" disabled={busy || running} onClick={() => onRerun(suite)}>
              Run all {suite.runs.length} again
            </button>
          ) : null}
        </div>
      ) : suite.failureReason ? <p className="bench-alert-inline">{suite.failureReason}</p> : null}

      {suite.progress ? (
        <div className="bench-progress" role="status">
          <span>
            Running {POLICY_LABELS[suite.progress.policy]} ({suite.progress.position + 1} of {suite.progress.totalRuns})
            · {suite.progress.finishedJobs}/{suite.progress.totalJobs} jobs finished
          </span>
          <progress max={100} value={Math.round(suiteProgress(suite) * 100)}
            aria-label="Benchmark progress">{Math.round(suiteProgress(suite) * 100)}%</progress>
        </div>
      ) : null}

      <div className="table-scroll">
        <table className="data-table bench-runs">
          <caption className="sr-only">Runs in this benchmark, in the order they ran</caption>
          <thead>
            <tr>
              <th scope="col">Policy</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">Completed</th>
              <th scope="col" className="num">Failed</th>
              <th scope="col">Capacity</th>
            </tr>
          </thead>
          <tbody>
            {suite.runs.map((run) => (
              <tr key={run.id}>
                <th scope="row"><PolicyName policy={run.policy} /></th>
                <td>
                  <RunStatus status={run.status} />
                  {run.failureReason && run.failureReason !== suite.failureReason
                    ? <small className="bench-run-note">{run.failureReason}</small> : null}
                </td>
                <td className="num mono">{run.status === "PENDING" ? "—" : `${run.completedJobs}/${run.jobCount}`}</td>
                <td className="num mono">{run.status === "PENDING" ? "—" : run.failedJobs}</td>
                <td className="mono bench-capacity">{run.workerCount === null || run.workerCount === undefined
                  ? "Not started" : `${run.workerCount} workers · ${run.cpuCapacityMillicores}m · ${run.memoryCapacityMiB} MiB`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="card-foot">
        {comparison.finishedRuns === 0 ? (
          <span>No run has finished yet, so there is nothing to compare.</span>
        ) : (
          <span className={comparison.comparable ? undefined : "bench-caution"}>
            {comparison.comparable
              ? "Completed runs did identical work (matching result checksums) on the same capacity, so their numbers compare directly."
              : comparison.notes.join(" ")}
            {comparison.comparable && comparison.notes.length ? ` ${comparison.notes.join(" ")}` : ""}
          </span>
        )}
      </footer>
    </section>
  );
}

/** The measured comparison: one row per metric, a bar per policy, the change, and who was better. */
function ResultsCard({ suite }) {
  const { comparison } = suite;
  const finished = suite.runs.filter((run) => run.status === "COMPLETED").map((run) => run.policy);
  const baseline = finished[0];
  const metrics = comparison.metrics.map((metric) => ({
    ...metric,
    values: metric.values.filter((entry) => finished.includes(entry.policy)),
  }));
  return (
    <section className="card bench-results-card" aria-labelledby="bench-results-title">
      <header className="card-head">
        <div>
          <h2 id="bench-results-title">Results: {finished.map((policy) => POLICY_LABELS[policy]).join(" vs ")}</h2>
          <p className="bench-summary-text">{resultSummary({ ...comparison, metrics })}</p>
        </div>
        <ul className="bench-legend" aria-label="Policy colours">
          {finished.map((policy) => <li key={policy}><PolicyName policy={policy} /></li>)}
        </ul>
      </header>
      <div className="table-scroll">
        <table className="data-table bench-results">
          <caption className="sr-only">
            Measured metrics per policy. Difference is relative to {POLICY_LABELS[baseline]}; the better value is bold.
          </caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" colSpan={2}>Comparison</th>
              <th scope="col" className="num">Difference</th>
              <th scope="col">Better</th>
            </tr>
          </thead>
          {metrics.map((metric) => {
            const best = new Set(metric.best);
            const widths = barWidths(metric.values);
            const base = metric.values.find((entry) => entry.policy === baseline)?.value ?? null;
            const heading = (rows) => (
              <th scope="rowgroup" rowSpan={rows}>
                {metric.label}
                <small>{metric.better === "lower" ? "Lower is better" : "Higher is better"}</small>
              </th>
            );
            const better = (rows) => (
              <td rowSpan={rows} className="bench-better">
                {metric.best.length ? metric.best.map((policy) => <PolicyName key={policy} policy={policy} />) : "Tie"}
              </td>
            );
            if (allEqual(metric.values)) {
              return (
                <tbody key={metric.key}>
                  <tr>
                    {heading(1)}
                    <td colSpan={2} className="bench-equal">
                      {metric.values.length === 2 ? "Both" : "All"} {formatMetric(metric.values[0].value, metric.unit)}
                      {metric.key === "preemptions" && metric.values[0].value === 0 ? ", no policy preempted a job" : ""}
                    </td>
                    <td className="num mono">—</td>
                    {better(1)}
                  </tr>
                </tbody>
              );
            }
            return (
              <tbody key={metric.key}>
                {metric.values.map((entry, index) => (
                  <tr key={entry.policy} className={`${policyClass(entry.policy)}${best.has(entry.policy) ? " is-best" : ""}`}>
                    {index === 0 ? heading(metric.values.length) : null}
                    <td className="bench-bar-cell">
                      <span className="bench-track" aria-hidden="true">
                        {entry.value !== null && entry.value !== undefined
                          ? <span style={{ width: `${Math.max(widths[index], entry.value > 0 ? 1 : 0)}%` }} /> : null}
                      </span>
                      <span className="sr-only">{POLICY_LABELS[entry.policy]}</span>
                    </td>
                    <td className="num mono bench-value">{formatMetric(entry.value, metric.unit)}</td>
                    <td className="num mono bench-diff">
                      {entry.policy === baseline ? "" : percentChange(entry.value, base) ?? "—"}
                    </td>
                    {index === 0 ? better(metric.values.length) : null}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
      <footer className="card-foot bench-results-foot">
        <span>
          Difference is relative to {POLICY_LABELS[baseline]}. The better value in each row is bold; values within a
          millisecond count as a tie.
        </span>
        <details>
          <summary>How these are measured</summary>
          <p>
            Waiting, turnaround, and response cover completed jobs only. Waiting excludes time spent running, so a
            Round Robin job paused by preemption counts its queue time again. Makespan runs from the first arrival to
            the last completion; throughput is completed jobs per minute of makespan.
          </p>
        </details>
      </footer>
    </section>
  );
}

/** Pure view, so every state can be rendered and tested without a backend. */
export function BenchmarkView({
  data, selectedId, onSelect, form, onFormChange, onStart, onAbort, onRerun, busy = false, error = null,
  modeSwitch = null, unfinishedJobs = null,
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
  const count = form.policies.length;
  const status = running ? { tone: "live", label: "Benchmark running" }
    : unfinishedJobs ? { tone: "idle", label: `${unfinishedJobs} ${plural(unfinishedJobs, "job", "jobs")} unfinished` }
      : unfinishedJobs === 0 ? { tone: "idle", label: "Cluster idle" } : null;
  return (
    <div className="bench-page" aria-busy={running}>
      {modeSwitch}
      <PageHeader title="Scheduling policy comparison" status={status}
        subtitle="Run one seeded workload under each policy, one after another, and compare what was measured." />

      <form className="card bench-new" aria-label="New benchmark" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
        <header className="card-head">
          <div>
            <h2>New benchmark</h2>
            <p>
              Uses the real scheduler, placement, and Docker pipeline. Needs an idle cluster; autoscaling is paused
              while it runs so capacity stays fixed.
            </p>
          </div>
        </header>
        <div className="bench-new-body">
          <fieldset className="bench-policies" disabled={locked}>
            <legend>Policies</legend>
            {POLICIES.map((policy) => (
              <label key={policy} className={form.policies.includes(policy) ? "is-on" : undefined}>
                <input type="checkbox" checked={form.policies.includes(policy)} onChange={() => togglePolicy(policy)} />
                <span className={`policy-swatch ${policyClass(policy)}`} aria-hidden="true" />
                {POLICY_LABELS[policy]}
              </label>
            ))}
          </fieldset>
          <div className="bench-fields">
            <label htmlFor="bench-count">Jobs
              <select id="bench-count" value={form.count} disabled={locked}
                onChange={(event) => set({ count: Number(event.target.value) })}>
                {COUNTS.map((value) => <option key={value} value={value}>{value}</option>)}
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
            <label htmlFor="bench-quantum">Round Robin quantum
              <span className="input-suffix">
                <input id="bench-quantum" type="number" min={1} max={3600} step={1} required
                  value={form.timeQuantumSeconds} disabled={locked || !form.policies.includes("ROUND_ROBIN")}
                  onChange={(event) => set({ timeQuantumSeconds: event.target.value })} />
                <span aria-hidden="true">sec</span>
              </span>
            </label>
            <label htmlFor="bench-tick">Jobs started per tick
              <input id="bench-tick" type="number" min={1} max={25} step={1} required value={form.jobsPerTick}
                disabled={locked} onChange={(event) => set({ jobsPerTick: event.target.value })} />
            </label>
          </div>
          <div className="bench-actions">
            {running ? (
              <button type="button" className="btn btn-stop" disabled={busy || active?.abortRequested}
                onClick={() => onAbort(activeId)}>
                <Icon name="stop" />{active?.abortRequested ? "Stopping…" : "Stop benchmark"}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={busy || count === 0}>
                <Icon name="play" />{busy ? "Starting…" : `Run ${count} ${plural(count, "policy", "policies")}`}
              </button>
            )}
            <small>
              {running ? "Pipeline controls are locked until it finishes or you stop it."
                : count === 0 ? "Choose at least one policy."
                  : `Runs them one after another on the same ${form.count} jobs${unfinishedJobs
                    ? `. ${unfinishedJobs} unfinished ${plural(unfinishedJobs, "job", "jobs")} must finish or be stopped first` : ""}.`}
            </small>
          </div>
        </div>
      </form>

      {error ? <p className="error-banner" role="alert">{error}</p> : null}

      {selected ? (
        <>
          <SuiteCard suite={selected} latest={selected.id === suites[0]?.id} busy={busy} running={running} onRerun={onRerun} />
          {selected.comparison.finishedRuns >= 2 ? <ResultsCard suite={selected} /> : null}
        </>
      ) : (
        <p className="muted bench-empty">{data ? "No benchmarks yet. Choose policies and run one." : "Loading benchmarks…"}</p>
      )}

      {suites.length > 1 ? (
        <details className="card bench-earlier">
          <summary>Earlier benchmarks <span className="count mono">{suites.length}</span></summary>
          <div className="table-scroll">
            <table className="data-table">
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
                    <td className="mono"><time dateTime={suite.startedAt}>{time(suite.startedAt)}</time></td>
                    <td><RunStatus status={suite.status} /></td>
                    <td>{suite.jobCount} jobs · {String(suite.pattern).toLowerCase()} · seed {suite.seed}</td>
                    <td>
                      <span className="bench-policy-list">
                        {suite.runs.map((run) => <Fragment key={run.id}><PolicyName policy={run.policy} /></Fragment>)}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-small" aria-pressed={suite.id === selected?.id}
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
    </div>
  );
}

/** Polls the backend and owns the form; all measurement happens server-side. */
export function BenchmarkPanel({ modeSwitch = null, unfinishedJobs = null }) {
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
  const start = (request) => act(async () => {
    const suite = await startBenchmark(request);
    setSelectedId(suite.id);
  });
  return (
    <BenchmarkView
      data={data}
      selectedId={selectedId}
      onSelect={setSelectedId}
      form={form}
      onFormChange={setForm}
      busy={busy}
      error={error}
      modeSwitch={modeSwitch}
      unfinishedJobs={unfinishedJobs}
      onStart={() => start(toBenchmarkRequest(form))}
      onRerun={(suite) => start(rerunBenchmarkRequest(suite))}
      onAbort={(id) => act(() => abortBenchmark(id))}
    />
  );
}
