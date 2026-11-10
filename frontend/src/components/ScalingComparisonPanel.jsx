import { useCallback, useEffect, useRef, useState } from "react";
import {
  MIXED_COMPUTE_TYPES,
  STATE_CHANGED_EVENT,
  abortScalingComparison,
  fetchScalingComparison,
  fetchScalingComparisons,
  startScalingComparison,
} from "../api";
import {
  CHART_METRICS,
  GROUP_TITLES,
  STRATEGY_LABELS,
  STRATEGY_NAMES,
  STRATEGY_ORDER,
  comparisonProgress,
  exportFileName,
  forecastPoints,
  formatSeconds,
  formatValue,
  headline,
  metricMeaning,
  reactionText,
  runPoints,
  strategyClass,
  winnerText,
} from "../scaling.chart.js";
import { Icon } from "./Icon.jsx";
import { PageHeader } from "./PageHeader.jsx";
import { ScalingChart } from "./ScalingChart.jsx";
import { ResultsTable, TakeawayCard } from "./ScalingInsights.jsx";
import { SetupForm, SetupSummary, profileOf, setupItems } from "./ScalingSetup.jsx";

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 5_000;
const STATUS_TEXT = { PENDING: "Waiting", RUNNING: "Running", COMPLETED: "Completed", FAILED: "Failed", ABORTED: "Stopped" };

export const DEFAULT_SCALING_FORM = {
  count: 25,
  pattern: "INCREASING",
  profile: "SLEEP",
  policy: "FCFS",
  strategy: "LEAST_LOADED",
  seed: 42,
  timeQuantumSeconds: 5,
};

/** The request body the backend validates. The order Reactive, then ML-Assisted, is fixed. */
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

/** The exact request that produced a stored comparison, so re-running repeats it. */
export function rerunRequest(comparison) {
  return {
    count: comparison.jobCount,
    pattern: comparison.pattern,
    workloadTypes: comparison.workloadTypes,
    policy: comparison.schedulingPolicy,
    strategy: comparison.placementStrategy,
    seed: comparison.seed,
    timeQuantumSeconds: comparison.timeQuantumSeconds,
    jobsPerTick: comparison.jobsPerTick,
  };
}

/** A stored comparison's settings as form values, the starting point for a new experiment. */
export function formFromComparison(comparison) {
  return {
    count: comparison.jobCount,
    pattern: comparison.pattern,
    profile: profileOf(comparison.workloadTypes),
    policy: comparison.schedulingPolicy,
    strategy: comparison.placementStrategy,
    seed: comparison.seed,
    timeQuantumSeconds: comparison.timeQuantumSeconds,
  };
}

const time = (value) => (value ? new Date(value).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
}) : "—");

function seriesFor(runs, metricKey) {
  return STRATEGY_ORDER.map((strategy) => runs.find((run) => run.strategy === strategy))
    .filter(Boolean)
    .map((run) => ({
      key: run.strategy,
      label: STRATEGY_LABELS[run.strategy],
      className: strategyClass(run.strategy),
      points: runPoints(run, metricKey),
    }))
    .filter((entry) => entry.points.length > 0);
}

function describeSeries(series, metric) {
  if (series.length === 0) return `${metric.label} over time: no samples yet.`;
  return `${metric.label} over time. ` + series.map((entry) => {
    const peak = Math.max(...entry.points.map((point) => point.v));
    return `${entry.label}: ${entry.points.length} samples over ${formatSeconds(entry.points.at(-1).t)}, ` +
      `peak ${metric.format(peak)}.`;
  }).join(" ");
}

const CHART_OPTIONS = ["utilization", "queue", "workers"];

/** The main chart: one metric at a time for both runs on the same time axis. */
function TimelineSection({ runs, settings }) {
  const [metricKey, setMetricKey] = useState("utilization");
  const metric = CHART_METRICS[metricKey];
  const series = seriesFor(runs, metricKey);
  const threshold = metricKey === "queue" ? settings.scaleUpQueueThreshold ?? null
    : metricKey === "utilization" && typeof settings.scaleUpUtilization === "number"
      ? settings.scaleUpUtilization * 100 : null;
  const thresholdText = metricKey === "queue"
    ? `Scale-up threshold (${threshold} ${threshold === 1 ? "job" : "jobs"})`
    : `Scale-up threshold (${Math.round(threshold ?? 0)}%)`;
  return (
    <section className="card sc-chart-card" aria-labelledby="sc-chart-title">
      <header className="card-head">
        <div>
          <h2 id="sc-chart-title">{metric.title}</h2>
          <p>{metric.description}</p>
        </div>
        <div className="sc-toggle" role="group" aria-label="Chart metric">
          {CHART_OPTIONS.map((key) => (
            <button key={key} type="button" aria-pressed={key === metricKey} onClick={() => setMetricKey(key)}>
              {CHART_METRICS[key].toggle}
            </button>
          ))}
        </div>
      </header>
      {series.length === 0 ? (
        <p className="sc-chart-empty">The timeline appears as soon as the first run starts sampling.</p>
      ) : (
        <ScalingChart series={series} metric={metric} threshold={threshold}
          ariaLabel={describeSeries(series, metric)} />
      )}
      <ul className="sc-legend" aria-label="Chart key">
        {STRATEGY_ORDER.map((strategy) => (
          <li key={strategy} className={strategyClass(strategy)}>
            <span className="sc-key-line" aria-hidden="true" />{STRATEGY_LABELS[strategy]}
          </li>
        ))}
        {threshold !== null ? (
          <li className="sc-legend-threshold"><span className="sc-key-line" aria-hidden="true" />{thresholdText}</li>
        ) : null}
      </ul>
    </section>
  );
}

function displayValue(metric, strategy) {
  const value = strategy === "ML" ? metric.ml : metric.reactive;
  if (metric.key === "reactionSeconds") {
    return reactionText(strategy === "ML" ? metric.mlOutcome : metric.reactiveOutcome, value);
  }
  return formatValue(value, metric.unit);
}

function winnerClass(metric) {
  if (metric.winner === "ML" || metric.winner === "REACTIVE") return `sc-chip ${strategyClass(metric.winner)}`;
  return "sc-chip sc-chip-neutral";
}

/** Everything else measured: fairness, all metrics, the forecast check, and the raw run records. */
function DetailedAnalysis({ comparison }) {
  const result = comparison.comparison;
  const settings = comparison.autoscalerSettings ?? {};
  const ml = comparison.runs.find((run) => run.strategy === "ML");
  const lookAhead = settings.mlLookAheadSeconds ?? 60;
  const predicted = ml?.status === "COMPLETED" ? forecastPoints(ml, lookAhead) : [];
  const forecastSeries = predicted.length > 1 ? [
    { key: "measured", label: "Measured", className: "series-measured", points: runPoints(ml, "queue") },
    { key: "predicted", label: "ML predicted", className: "strategy-ml", points: predicted, dashed: true, fill: false },
  ] : [];
  return (
    <details className="card sc-details">
      <summary>Detailed analysis <small>Every measurement, forecast accuracy, and run records</small></summary>
      <div className="sc-details-body">
      <FairnessNote result={result} />

      {result.waitVerdict ? (
        <div className="table-scroll sc-table-wrap">
          <table className="data-table sc-table">
            <caption className="sr-only">All measured metrics for both strategies, grouped by what they show</caption>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                <th scope="col" className="strategy-reactive">Reactive</th>
                <th scope="col" className="strategy-ml">ML-assisted</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            {Object.keys(GROUP_TITLES).map((group) => (
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
          </table>
        </div>
      ) : <p className="muted">The full table appears once both runs have completed.</p>}

      {forecastSeries.length ? (
        <section className="sc-forecast" aria-labelledby="sc-forecast-title">
          <h3 id="sc-forecast-title">ML forecast accuracy</h3>
          <p className="hint">
            Each dashed point is a prediction, drawn at the moment it was predicting ({lookAhead}s ahead); the solid
            line is the queue measured then.
            {result.forecast?.meanAbsError !== null && result.forecast?.meanAbsError !== undefined
              ? ` Average error: ${result.forecast.meanAbsError.toFixed(2)} jobs over ${result.forecast.pairs} checks.` : ""}
          </p>
          <ScalingChart series={forecastSeries} metric={CHART_METRICS.queue} height={240}
            showPoints
            ariaLabel={`Predicted versus measured waiting jobs for the ML-assisted run.${result.forecast?.meanAbsError != null
              ? ` Average error ${result.forecast.meanAbsError.toFixed(2)} jobs.` : ""}`} />
          <ul className="sc-legend" aria-label="Forecast key">
            <li className="series-measured"><span className="sc-key-line" aria-hidden="true" />Measured waiting jobs</li>
            <li className="strategy-ml is-dashed"><span className="sc-key-line" aria-hidden="true" />ML-assisted prediction</li>
          </ul>
        </section>
      ) : null}

      <div className="table-scroll sc-table-wrap">
        <table className="data-table">
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
                <th scope="row" className={strategyClass(run.strategy)}>{STRATEGY_NAMES[run.strategy]}</th>
                <td>{STATUS_TEXT[run.status] ?? run.status}</td>
                <td>{run.status === "PENDING" ? "—" : `${run.completedJobs}/${run.jobCount}`}</td>
                <td>{run.workerCount === null || run.workerCount === undefined
                  ? "N/A" : `${run.workerCount} workers · ${run.cpuCapacityMillicores}m · ${run.memoryCapacityMiB} MiB`}</td>
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
        {settings.cooldownSeconds}s cooldown, {settings.idleSeconds}s idle before retiring. ML-Assisted fits the last{" "}
        {settings.mlWindowPoints} checks and predicts {settings.mlLookAheadSeconds}s ahead.
      </p>
      </div>
    </details>
  );
}

/** Whether both runs really did the same work; a caution also shows above the results. */
function FairnessNote({ result, cautionOnly = false }) {
  if (!result?.waitVerdict || (cautionOnly && result.comparable)) return null;
  return (
    <p className={`sc-fairness${result.comparable ? "" : " is-caution"}`}>
      {result.comparable
        ? "Fair test: both runs did identical work (matching checksums) on the same base cluster and thresholds."
        : result.notes.join(" ")}
    </p>
  );
}

function ComparisonHistory({ comparisons, shownId, onSelect }) {
  return (
    <details className="card sc-earlier">
      <summary>Earlier comparisons <span className="count mono">{comparisons.length}</span></summary>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="sr-only">Recent comparisons, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Status</th>
              <th scope="col">Setup</th>
              <th scope="col">Result</th>
              <th scope="col"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((entry) => (
              <tr key={entry.id}>
                <td><time dateTime={entry.startedAt}>{time(entry.startedAt)}</time></td>
                <td>{STATUS_TEXT[entry.status] ?? entry.status}</td>
                <td>{setupItems(entry).slice(0, 3).map((item) => item.value).join(" · ")} · seed {entry.seed}</td>
                <td>{headline(entry.comparison).title}</td>
                <td>
                  <button type="button" className="btn btn-ghost btn-small" aria-pressed={entry.id === shownId}
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
  );
}

/** Pure view, so every state can be rendered and tested without a backend. */
export function ScalingComparisonView({
  data, detail, selectedId, onSelect, form, onFormChange, onStart, onAbort, onRerun, onExport,
  formOpen = false, onOpenForm, onCloseForm, busy = false, error = null, modeSwitch = null,
}) {
  const comparisons = data?.comparisons ?? [];
  const activeId = data?.activeComparisonId ?? null;
  const running = activeId !== null;
  const shownId = selectedId ?? activeId ?? comparisons[0]?.id ?? null;
  const listed = comparisons.find((entry) => entry.id === shownId) ?? null;
  // The detail carries timelines; until it arrives the list entry still shows the results.
  const shown = detail?.id === shownId ? detail : listed;
  const active = comparisons.find((entry) => entry.id === activeId) ?? null;
  const showForm = !running && (formOpen || (data !== null && comparisons.length === 0));
  const settings = shown?.autoscalerSettings ?? {};
  const progress = shown?.id === activeId ? active?.progress ?? shown?.progress ?? null : null;

  return (
    <div className="sc-page" aria-busy={running}>
      {modeSwitch}
      <PageHeader
        title="Autoscaling comparison"
        status={running ? { tone: "live", label: "Running" } : null}
        subtitle="Reactive and ML-assisted autoscaling, run on the same workload and configuration."
        actions={(
        <>
          {running ? (
            <button type="button" className="btn btn-stop" disabled={busy || active?.abortRequested}
              onClick={() => onAbort(activeId)}>
              <Icon name="stop" />{active?.abortRequested ? "Stopping…" : "Stop comparison"}
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={busy || !shown}
              title="Runs again with the same workload settings and the current autoscaler thresholds"
              onClick={() => onRerun(shown)}>
              <Icon name="refresh" />Re-run
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={!shown} onClick={() => onExport(shown)}
            title="Download this comparison, timelines included, as JSON">
            <Icon name="download" />Export
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || running || showForm}
            onClick={onOpenForm}>
            <Icon name="plus" />New experiment
          </button>
        </>
        )}
      />

      {showForm ? (
        <SetupForm form={form} onFormChange={onFormChange} onStart={onStart} onCancel={onCloseForm}
          busy={busy} canCancel={comparisons.length > 0} />
      ) : shown ? <SetupSummary comparison={shown} onEdit={onOpenForm} canEdit={!busy && !running} /> : null}

      {error ? <p className="error-banner" role="alert">{error}</p> : null}

      {running ? (
        <div className="sc-progress" role="status">
          <span>
            {active?.progress
              ? `Running ${STRATEGY_NAMES[active.progress.strategy]} (${active.progress.position + 1} of ` +
                `${active.progress.totalRuns}) · ${active.progress.finishedJobs}/${active.progress.totalJobs} jobs finished`
              : "Resetting the cluster for the next run…"}
          </span>
          <progress max={100} value={Math.round(comparisonProgress(active) * 100)}
            aria-label="Comparison progress">{Math.round(comparisonProgress(active) * 100)}%</progress>
        </div>
      ) : null}

      {!data ? <p className="muted sc-loading" role="status">Loading comparisons…</p> : null}

      {shown ? (
        <>
          {shown.failureReason ? <p className="warn">{shown.failureReason}</p> : null}
          <div className="sc-main">
            <TimelineSection runs={shown.runs} settings={settings} />
            <TakeawayCard comparison={shown.comparison} runs={shown.runs} settings={settings} progress={progress} />
          </div>
          <FairnessNote result={shown.comparison} cautionOnly />
          <ResultsTable comparison={shown.comparison} runs={shown.runs} />
          {comparisons.length > 0 ? (
            <ComparisonHistory comparisons={comparisons} shownId={shownId} onSelect={onSelect} />
          ) : null}
          <DetailedAnalysis comparison={shown} />
        </>
      ) : data && comparisons.length === 0 ? (
        <p className="muted">No comparisons yet. Choose a workload above and start one.</p>
      ) : null}
    </div>
  );
}

/** Saves the shown comparison, timelines included, exactly as the backend returned it. */
function downloadJson(comparison) {
  const blob = new Blob([JSON.stringify(comparison, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFileName(comparison);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Polls the list, fetches timelines for the comparison on screen, and owns the form. */
export function ScalingComparisonPanel({ modeSwitch = null }) {
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(DEFAULT_SCALING_FORM);
  const [formOpen, setFormOpen] = useState(false);
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
  const start = (request) => act(async () => {
    const comparison = await startScalingComparison(request);
    setSelectedId(comparison.id);
    setFormOpen(false);
  });
  return (
    <ScalingComparisonView
      data={data}
      detail={detail}
      selectedId={selectedId}
      onSelect={setSelectedId}
      form={form}
      onFormChange={setForm}
      formOpen={formOpen}
      onOpenForm={() => {
        const current = data?.comparisons?.find((entry) => entry.id === shownId);
        if (current) setForm(formFromComparison(current));
        setError(null);
        setFormOpen(true);
      }}
      onCloseForm={() => setFormOpen(false)}
      busy={busy}
      error={error}
      onStart={() => start(toScalingRequest(form))}
      onRerun={(comparison) => start(rerunRequest(comparison))}
      onExport={(comparison) => act(async () => {
        // Export the full record with timelines, even if only the list entry is on screen.
        downloadJson(comparison.runs?.every((run) => Array.isArray(run.samples))
          ? comparison : await fetchScalingComparison(comparison.id));
      })}
      onAbort={(id) => act(() => abortScalingComparison(id))}
      modeSwitch={modeSwitch}
    />
  );
}
