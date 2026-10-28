import { useCallback, useEffect, useRef, useState } from "react";
import {
  MIXED_COMPUTE_TYPES,
  STATE_CHANGED_EVENT,
  abortScalingComparison,
  fetchScalingComparison,
  fetchScalingComparisons,
  startScalingComparison,
} from "../api";
import { POLICY_LABELS } from "../benchmark.chart.js";
import {
  GROUP_TITLES,
  QUESTIONS,
  STRATEGY_LABELS,
  STRATEGY_ORDER,
  buildForecastChart,
  buildTimelines,
  comparisonProgress,
  formatSeconds,
  formatValue,
  headline,
  metricMeaning,
  reactionText,
  strategyClass,
  winnerText,
} from "../scaling.chart.js";
import { Icon } from "./Icon.jsx";

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 5_000;

const COUNTS = [10, 25, 50];
const PATTERNS = [
  ["INCREASING", "Increasing · ramp up (recommended)"],
  ["BURST", "Burst · 5 jobs every 30s"],
  ["PERIODIC", "Periodic · repeating"],
  ["CONSTANT", "Constant · every 10s (control)"],
  ["DECREASING", "Decreasing · ramp down"],
  ["HEAVY", "Heavy · 2–6s apart"],
  ["MEDIUM", "Medium · 8–16s apart"],
  ["IMMEDIATE", "Immediate · all ready at once"],
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
const POLICIES = ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"];
const PLACEMENTS = [["LEAST_LOADED", "Least Loaded"], ["FIRST_FIT", "First Fit"], ["RESOURCE_AWARE", "Resource-Aware"]];
const STATUS_TEXT = { PENDING: "Waiting", RUNNING: "Running", COMPLETED: "Completed", FAILED: "Failed", ABORTED: "Stopped" };
const STATUS_BADGE = {
  PENDING: "badge-idle", RUNNING: "badge-busy", COMPLETED: "badge-active", FAILED: "badge-failed", ABORTED: "badge-failed",
};

export const DEFAULT_SCALING_FORM = {
  count: 25,
  pattern: "INCREASING",
  profile: "SLEEP",
  policy: "FCFS",
  strategy: "LEAST_LOADED",
  seed: 42,
  timeQuantumSeconds: 5,
};

/** The request body the backend validates. The order Reactive, then ML, is fixed. */
export function toScalingRequest(form) {
  return {
    count: Number(form.count),
    pattern: form.pattern,
    workloadTypes: form.profile === "MIXED_COMPUTE" ? MIXED_COMPUTE_TYPES : [form.profile],
    policy: form.policy,
    strategy: form.strategy,
    seed: Number(form.seed),
    timeQuantumSeconds: Number(form.timeQuantumSeconds),
  };
}

const time = (value) => (value ? new Date(value).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
}) : "—");

/** Colour key; the swatch is decorative, the name carries the meaning. */
function StrategyName({ strategy }) {
  return (
    <span className="policy-name">
      <span className={`policy-swatch ${strategyClass(strategy)}`} aria-hidden="true" />
      {STRATEGY_LABELS[strategy]}
    </span>
  );
}

function displayValue(metric, strategy) {
  const value = strategy === "ML" ? metric.ml : metric.reactive;
  if (metric.key === "reactionSeconds") {
    return reactionText(strategy === "ML" ? metric.mlOutcome : metric.reactiveOutcome, value);
  }
  return formatValue(value, metric.unit);
}

/** Two bars on one scale, winner drawn solid; the number beside each carries the meaning. */
function PairBars({ metric }) {
  const bars = metric.unit !== "signed-s";
  const values = [metric.reactive, metric.ml].filter((value) => value !== null);
  const max = Math.max(0, ...values.map(Math.abs));
  return (
    <div className="sc-pair">
      {STRATEGY_ORDER.map((strategy) => {
        const value = strategy === "ML" ? metric.ml : metric.reactive;
        const width = bars && value !== null && max > 0 ? (Math.abs(value) / max) * 100 : 0;
        const winner = metric.winner === strategy;
        return (
          <div key={strategy} className={`sc-pair-row ${strategyClass(strategy)}${winner ? " is-winner" : ""}`}>
            <span className="sc-pair-name">{STRATEGY_LABELS[strategy]}</span>
            {bars ? (
              <span className="sc-pair-track" aria-hidden="true">
                <span className="sc-pair-bar" style={{ width: `${Math.max(width, value > 0 ? 2 : 0)}%` }} />
              </span>
            ) : null}
            <span className="sc-pair-value">
              {displayValue(metric, strategy)}
              {winner ? <span className="sr-only"> (better)</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function winnerClass(metric) {
  if (metric.winner === "ML") return "sc-chip strategy-ml";
  if (metric.winner === "REACTIVE") return "sc-chip strategy-reactive";
  return "sc-chip sc-chip-neutral";
}

/** One question answered by one metric: who won, by how much, and both values. */
function QuestionCard({ question, metric, settings }) {
  return (
    <article className="sc-question">
      <h4>{question}</h4>
      <p className={winnerClass(metric)}>{winnerText(metric)}</p>
      <PairBars metric={metric} />
      <p className="sc-meaning">{metricMeaning(metric.key, settings)}</p>
    </article>
  );
}

/** Waiting jobs above, workers below, on the same time axis for both runs. */
function TimelineLane({ lane, chart, threshold }) {
  const left = 52;
  const gap = 22;
  const axis = 24;
  const height = 6 + chart.queueHeight + gap + chart.workersHeight + axis;
  const ups = lane.markers.filter((marker) => marker.action === "SCALE_UP").length;
  const downs = lane.markers.length - ups;
  const summary = `${STRATEGY_LABELS[lane.strategy]}: up to ${lane.peakQueue} jobs waiting, up to ` +
    `${lane.peakWorkers} workers, ${ups} worker(s) added and ${downs} retired, finished in ${formatSeconds(lane.durationSeconds)}.`;
  return (
    <figure className={`sc-lane ${strategyClass(lane.strategy)}`}>
      <figcaption>
        <StrategyName strategy={lane.strategy} />
        <span>
          peak {lane.peakQueue} waiting · up to {lane.peakWorkers} workers · {ups} added, {downs} retired ·
          done in {formatSeconds(lane.durationSeconds)}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${left + chart.width + 12} ${height}`} role="img" aria-label={summary}>
        <g transform={`translate(${left} 6)`}>
          <text className="sc-axis-title" x={-left} y={-0} dominantBaseline="hanging">Jobs</text>
          <text className="sc-axis-title" x={-left} y={12} dominantBaseline="hanging">waiting</text>
          {chart.queueTicks.map((tick) => (
            <g key={`q${tick.value}`}>
              <line className="sc-grid" x1={0} x2={chart.width} y1={tick.y} y2={tick.y} />
              <text className="sc-tick" x={-6} y={tick.y} textAnchor="end" dominantBaseline="middle">{tick.value}</text>
            </g>
          ))}
          <path className="sc-queue" d={lane.queueArea} />
          <line className="sc-threshold" x1={0} x2={chart.width} y1={chart.thresholdY} y2={chart.thresholdY} />
          <text className="sc-threshold-label" x={chart.width} y={chart.thresholdY - 4} textAnchor="end">
            scale-up line ({threshold} jobs)
          </text>
          <g transform={`translate(0 ${chart.queueHeight + gap})`}>
            <text className="sc-axis-title" x={-left} y={0} dominantBaseline="hanging">Workers</text>
            {chart.workerTicks.map((tick) => (
              <g key={`w${tick.value}`}>
                <line className="sc-grid" x1={0} x2={chart.width} y1={tick.y} y2={tick.y} />
                <text className="sc-tick" x={-6} y={tick.y} textAnchor="end" dominantBaseline="middle">{tick.value}</text>
              </g>
            ))}
            <path className="sc-workers" d={lane.workers} />
            {lane.markers.map((marker, index) => (
              <path key={index} className={marker.action === "SCALE_UP" ? "sc-marker-up" : "sc-marker-down"}
                d={marker.action === "SCALE_UP"
                  ? `M${marker.x - 5},${marker.y - 4} L${marker.x + 5},${marker.y - 4} L${marker.x},${marker.y - 12} Z`
                  : `M${marker.x - 5},${marker.y - 12} L${marker.x + 5},${marker.y - 12} L${marker.x},${marker.y - 4} Z`} />
            ))}
            {chart.xTicks.map((tick) => (
              <text key={`x${tick.value}`} className="sc-tick" x={tick.x} y={chart.workersHeight + 16} textAnchor="middle">
                {formatSeconds(tick.value)}
              </text>
            ))}
          </g>
        </g>
      </svg>
    </figure>
  );
}

function Timelines({ runs, settings }) {
  const threshold = settings?.scaleUpQueueThreshold ?? 2;
  const chart = buildTimelines(runs, { threshold });
  const lanes = chart.lanes.filter((lane) => !lane.empty);
  if (lanes.length === 0) return null;
  return (
    <section className="sc-section" aria-labelledby="sc-timeline-title">
      <h3 id="sc-timeline-title">What happened over time</h3>
      <p className="hint">
        <strong>How to read it:</strong> the shaded area is jobs waiting. When it rises past the dashed scale-up
        line, a good autoscaler adds workers (the line below steps up, ▲) so the area drains quickly. Both runs
        share the same time axis and scales, so a strategy that reacts earlier shows its ▲ further left and a
        smaller shaded area.
      </p>
      {lanes.map((lane) => (
        <TimelineLane key={lane.strategy} lane={lane} chart={chart} threshold={threshold} />
      ))}
      <ul className="bench-legend" aria-label="Timeline key">
        <li><span className="sc-key sc-key-queue" aria-hidden="true" />Jobs waiting</li>
        <li><span className="sc-key sc-key-workers" aria-hidden="true" />Workers in service</li>
        <li>▲ worker added · ▼ worker retired</li>
        <li><span className="sc-key sc-key-threshold" aria-hidden="true" />Scale-up line</li>
      </ul>
    </section>
  );
}

function ForecastCheck({ run, settings, forecast }) {
  const lookAhead = settings?.mlLookAheadSeconds ?? 60;
  const chart = buildForecastChart(run, lookAhead);
  if (!chart) return null;
  const left = 40;
  return (
    <section className="sc-section" aria-labelledby="sc-forecast-title">
      <h3 id="sc-forecast-title">Was the ML forecast right?</h3>
      <p className="hint">
        Every few seconds the ML strategy predicts how many jobs will be waiting {lookAhead}s later. Each dashed
        point is a prediction, drawn at the moment it was predicting; the solid line is what was actually
        measured then. The closer the lines, the better the forecast.
        {forecast?.meanAbsError !== null && forecast?.meanAbsError !== undefined
          ? ` On average the forecast was off by ${forecast.meanAbsError.toFixed(1)} job(s), over ${forecast.pairs} checks.`
          : ""}
      </p>
      <figure className="sc-lane strategy-ml">
        <svg viewBox={`0 0 ${left + chart.width + 12} ${chart.height + 30}`} role="img"
          aria-label={`Predicted versus measured waiting jobs for the ML run.${forecast?.meanAbsError != null
            ? ` Average error ${forecast.meanAbsError.toFixed(1)} jobs.` : ""}`}>
          <g transform={`translate(${left} 6)`}>
            {chart.yTicks.map((tick) => (
              <g key={tick.value}>
                <line className="sc-grid" x1={0} x2={chart.width} y1={tick.y} y2={tick.y} />
                <text className="sc-tick" x={-6} y={tick.y} textAnchor="end" dominantBaseline="middle">{tick.value}</text>
              </g>
            ))}
            <path className="sc-actual" d={chart.actual} />
            <path className="sc-predicted" d={chart.predicted} />
            {chart.xTicks.map((tick) => (
              <text key={tick.value} className="sc-tick" x={tick.x} y={chart.height + 16} textAnchor="middle">
                {formatSeconds(tick.value)}
              </text>
            ))}
          </g>
        </svg>
      </figure>
      <ul className="bench-legend" aria-label="Forecast key">
        <li><span className="sc-key sc-key-actual" aria-hidden="true" />Measured waiting jobs</li>
        <li><span className="sc-key sc-key-predicted" aria-hidden="true" />What ML predicted for that moment</li>
      </ul>
    </section>
  );
}

function ComparisonResults({ comparison }) {
  const result = comparison.comparison;
  const settings = comparison.autoscalerSettings ?? {};
  const verdict = headline(result);
  const byKey = Object.fromEntries(result.metrics.map((metric) => [metric.key, metric]));
  const ml = comparison.runs.find((run) => run.strategy === "ML");
  const groups = Object.keys(GROUP_TITLES);
  return (
    <div className="sc-results">
      <div className="bench-summary">
        <span className={`badge ${STATUS_BADGE[comparison.status]}`}>{STATUS_TEXT[comparison.status]}</span>
        <span>
          {comparison.jobCount} jobs · {comparison.pattern.toLowerCase()} · seed {comparison.seed} ·{" "}
          {POLICY_LABELS[comparison.schedulingPolicy]} · {comparison.placementStrategy.replace("_", " ").toLowerCase()} ·
          started {time(comparison.startedAt)}
        </span>
      </div>
      {comparison.failureReason ? <p className="warn">{comparison.failureReason}</p> : null}

      <div className={`sc-verdict sc-verdict-${verdict.tone}`} role="status">
        <p className="eyebrow">Verdict</p>
        <h3>{verdict.title}</h3>
        <p>{verdict.detail}</p>
      </div>

      {result.waitVerdict ? (
        <section className="sc-section" aria-labelledby="sc-glance-title">
          <h3 id="sc-glance-title">At a glance</h3>
          <div className="sc-questions">
            {QUESTIONS.map(({ key, question }) => (
              <QuestionCard key={key} question={question} metric={byKey[key]} settings={settings} />
            ))}
          </div>
        </section>
      ) : null}

      <Timelines runs={comparison.runs} settings={settings} />
      {ml?.status === "COMPLETED" ? <ForecastCheck run={ml} settings={settings} forecast={result.forecast} /> : null}

      {result.waitVerdict ? (
        <section className="sc-section" aria-labelledby="sc-detail-title">
          <h3 id="sc-detail-title">Every measurement</h3>
          <div className="table-scroll">
            <table className="grid sc-table">
              <caption className="sr-only">All measured metrics for both strategies, grouped by what they show</caption>
              <thead>
                <tr>
                  <th scope="col">Measurement</th>
                  <th scope="col"><StrategyName strategy="REACTIVE" /></th>
                  <th scope="col"><StrategyName strategy="ML" /></th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group}>
                  <tr className="sc-group-row"><th scope="rowgroup" colSpan={4}>{GROUP_TITLES[group]}</th></tr>
                  {result.metrics.filter((metric) => metric.group === group).map((metric) => (
                    <tr key={metric.key}>
                      <th scope="row">
                        {metric.label}
                        <span className="sc-meaning">{metricMeaning(metric.key, settings)}</span>
                      </th>
                      {STRATEGY_ORDER.map((strategy) => (
                        <td key={strategy} className={metric.winner === strategy ? "is-best" : undefined}>
                          {displayValue(metric, strategy)}
                        </td>
                      ))}
                      <td><span className={winnerClass(metric)}>{winnerText(metric)}</span></td>
                    </tr>
                  ))}
                </tbody>
              ))}
              {result.forecast?.meanAbsError !== null && result.forecast?.meanAbsError !== undefined ? (
                <tbody>
                  <tr className="sc-group-row"><th scope="rowgroup" colSpan={4}>Forecast accuracy</th></tr>
                  <tr>
                    <th scope="row">
                      Average forecast error
                      <span className="sc-meaning">
                        How far the ML prediction of waiting jobs was from what really happened {settings.mlLookAheadSeconds ?? 60}s later.
                      </span>
                    </th>
                    <td>Does not forecast</td>
                    <td>{result.forecast.meanAbsError.toFixed(2)} jobs</td>
                    <td>{result.forecast.pairs} checks</td>
                  </tr>
                </tbody>
              ) : null}
            </table>
          </div>
        </section>
      ) : null}

      <p className={result.comparable ? "hint" : "hint bench-caution"}>
        {result.comparable
          ? "Fair test: both runs did byte-identical work (matching result checksums), started from the same base cluster, and used the same thresholds. Only the autoscaling strategy changed."
          : result.notes.join(" ")}
        {" "}Differences under 5% count as “about the same”, because Docker timing varies a little between identical runs.
        For a paper, repeat the comparison a few times and report the range.
      </p>

      <details className="stage-controls">
        <summary>Runs and settings</summary>
        <div className="table-scroll">
          <table className="grid">
            <caption className="sr-only">The two runs, in the order they ran</caption>
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col">Status</th>
                <th scope="col">Completed</th>
                <th scope="col">Base cluster</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {comparison.runs.map((run) => (
                <tr key={run.id}>
                  <th scope="row"><StrategyName strategy={run.strategy} /></th>
                  <td><span className={`badge ${STATUS_BADGE[run.status]}`}>{STATUS_TEXT[run.status]}</span></td>
                  <td>{run.status === "PENDING" ? "—" : `${run.completedJobs}/${run.jobCount}`}</td>
                  <td>{run.workerCount === null || run.workerCount === undefined
                    ? "—" : `${run.workerCount} workers · ${run.cpuCapacityMillicores}m · ${run.memoryCapacityMiB} MiB`}</td>
                  <td>{run.failureReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Shared autoscaler settings: scale up at {settings.scaleUpQueueThreshold} waiting jobs and{" "}
          {Math.round((settings.scaleUpUtilization ?? 0) * 100)}% reserved, scale down below{" "}
          {Math.round((settings.scaleDownUtilization ?? 0) * 100)}%, up to {settings.maxWorkers} extra workers,{" "}
          {settings.cooldownSeconds}s cooldown, {settings.idleSeconds}s idle before retiring. ML fits the last{" "}
          {settings.mlWindowPoints} checks and predicts {settings.mlLookAheadSeconds}s ahead.
        </p>
      </details>
    </div>
  );
}

/** Pure view, so every state can be rendered and tested without a backend. */
export function ScalingComparisonView({
  data, detail, selectedId, onSelect, form, onFormChange, onStart, onAbort, busy = false, error = null,
}) {
  const comparisons = data?.comparisons ?? [];
  const activeId = data?.activeComparisonId ?? null;
  const running = activeId !== null;
  const shownId = selectedId ?? activeId ?? comparisons[0]?.id ?? null;
  const listed = comparisons.find((entry) => entry.id === shownId) ?? null;
  // The detail carries timelines; until it arrives the list entry still shows the verdict.
  const shown = detail?.id === shownId ? detail : listed;
  const active = comparisons.find((entry) => entry.id === activeId) ?? null;
  const locked = running || busy;
  const set = (patch) => onFormChange({ ...form, ...patch });
  return (
    <section className="panel bench-panel sc-panel" aria-label="Autoscaling comparison" aria-busy={running}>
      <header className="panel-head">
        <div>
          <p className="eyebrow">Autoscaling</p>
          <h2>Reactive vs ML predictive</h2>
        </div>
        <span className={`badge ${running ? "badge-busy" : "badge-idle"}`}>{running ? "RUNNING" : "IDLE"}</span>
      </header>

      <p className="hint">
        Runs the same seeded workload twice through the real pipeline: first with <strong>Reactive</strong>{" "}
        autoscaling, then with <strong>ML predictive</strong>. Everything else stays the same. Before each run the
        extra workers are retired and the ML history is cleared, so both start equal. It needs an idle cluster
        and uses the thresholds on the Autoscaling tab.
      </p>

      <form className="bench-form" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
        <label htmlFor="sc-count">Jobs
          <select id="sc-count" value={form.count} disabled={locked}
            onChange={(event) => set({ count: Number(event.target.value) })}>
            {COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label htmlFor="sc-pattern">Arrival pattern
          <select id="sc-pattern" value={form.pattern} disabled={locked}
            onChange={(event) => set({ pattern: event.target.value })}>
            {PATTERNS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="sc-profile">Workload type
          <select id="sc-profile" value={form.profile} disabled={locked}
            onChange={(event) => set({ profile: event.target.value })}>
            {PROFILES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="sc-policy">Scheduling policy
          <select id="sc-policy" value={form.policy} disabled={locked}
            onChange={(event) => set({ policy: event.target.value })}>
            {POLICIES.map((policy) => <option key={policy} value={policy}>{POLICY_LABELS[policy]}</option>)}
          </select>
        </label>
        <label htmlFor="sc-placement">Placement
          <select id="sc-placement" value={form.strategy} disabled={locked}
            onChange={(event) => set({ strategy: event.target.value })}>
            {PLACEMENTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="sc-seed">Seed
          <input id="sc-seed" type="number" min={0} max={2147483647} step={1} required value={form.seed}
            disabled={locked} onChange={(event) => set({ seed: event.target.value })} />
        </label>
        {form.policy === "ROUND_ROBIN" ? (
          <label htmlFor="sc-quantum">Round Robin quantum (s)
            <input id="sc-quantum" type="number" min={1} max={3600} step={1} required value={form.timeQuantumSeconds}
              disabled={locked} onChange={(event) => set({ timeQuantumSeconds: event.target.value })} />
          </label>
        ) : null}
        <div className="stage-buttons bench-actions">
          {running ? (
            <button type="button" className="btn btn-stop" disabled={busy || active?.abortRequested}
              onClick={() => onAbort(activeId)}>
              <Icon name="stop" />{active?.abortRequested ? "Stopping…" : "Stop comparison"}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <Icon name="play" />{busy ? "Starting…" : "Compare Reactive vs ML"}
            </button>
          )}
        </div>
      </form>

      {error ? <p className="warn" role="alert">{error}</p> : null}

      {active?.progress ? (
        <div className="bench-progress" role="status">
          <span>
            Running {STRATEGY_LABELS[active.progress.strategy]} ({active.progress.position + 1} of{" "}
            {active.progress.totalRuns}) · {active.progress.finishedJobs}/{active.progress.totalJobs} jobs finished
          </span>
          <progress max={100} value={Math.round(comparisonProgress(active) * 100)}
            aria-label="Comparison progress">{Math.round(comparisonProgress(active) * 100)}%</progress>
        </div>
      ) : running ? (
        <p className="muted" role="status">Resetting the cluster for the next run…</p>
      ) : null}

      {shown ? <ComparisonResults comparison={shown} /> : (
        <p className="muted">
          {data ? "No comparisons yet. Pick a workload and press Compare Reactive vs ML." : "Loading comparisons…"}
        </p>
      )}

      {comparisons.length > 1 ? (
        <details className="stage-controls">
          <summary>Earlier comparisons ({comparisons.length})</summary>
          <div className="table-scroll">
            <table className="grid">
              <caption className="sr-only">Recent comparisons, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Setup</th>
                  <th scope="col">Verdict</th>
                  <th scope="col"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((entry) => (
                  <tr key={entry.id}>
                    <td><time dateTime={entry.startedAt}>{time(entry.startedAt)}</time></td>
                    <td><span className={`badge ${STATUS_BADGE[entry.status]}`}>{STATUS_TEXT[entry.status]}</span></td>
                    <td>{entry.jobCount} jobs · {entry.pattern.toLowerCase()} · seed {entry.seed}</td>
                    <td>{headline(entry.comparison).title}</td>
                    <td>
                      <button type="button" className="btn btn-ghost" aria-pressed={entry.id === shownId}
                        onClick={() => onSelect(entry.id)}>
                        {entry.id === shownId ? "Showing" : "Show"}
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

/** Polls the list, fetches timelines for the comparison on screen, and owns the form. */
export function ScalingComparisonPanel() {
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(DEFAULT_SCALING_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal) => {
    try {
      const next = await fetchScalingComparisons(signal);
      if (mounted.current) setData(next);
    } catch (reason) {
      if (signal?.aborted || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to read comparisons");
    }
  }, []);
  const activeId = data?.activeComparisonId ?? null;
  const running = activeId !== null;
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

  // Timelines are only in the detail. Refetch it while it is live and once more when a run's status changes.
  const shownId = selectedId ?? activeId ?? data?.comparisons?.[0]?.id ?? null;
  const shownStatus = data?.comparisons?.find((entry) => entry.id === shownId)?.runs
    ?.map((run) => run.status).join(",") ?? "";
  const live = shownId !== null && shownId === activeId;
  useEffect(() => {
    if (!shownId) return undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await fetchScalingComparison(shownId, controller.signal);
        if (mounted.current) setDetail(next);
      } catch (reason) {
        if (!controller.signal.aborted && mounted.current) {
          setError(reason instanceof Error ? reason.message : "Failed to read the comparison");
        }
      }
    };
    void load();
    const timer = live ? setInterval(() => void load(), ACTIVE_POLL_MS) : null;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [shownId, shownStatus, live]);

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
    <ScalingComparisonView
      data={data}
      detail={detail}
      selectedId={selectedId}
      onSelect={setSelectedId}
      form={form}
      onFormChange={setForm}
      busy={busy}
      error={error}
      onStart={() => act(async () => {
        const comparison = await startScalingComparison(toScalingRequest(form));
        setSelectedId(comparison.id);
      })}
      onAbort={(id) => act(() => abortScalingComparison(id))}
    />
  );
}
