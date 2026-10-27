import { useCallback, useEffect, useRef, useState } from "react";
import {
  STATE_CHANGED_EVENT,
  fetchAutoscaler,
  updateAutoscaler,
} from "../api";

const POLL_MS = 3_000;

function percent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

const ACTION_TEXT = { SCALE_UP: "Scaled up", SCALE_DOWN: "Scaled down", NONE: "No change" };

/** One strategy runs at a time so the two can be compared on the same workload. */
export const STRATEGIES = [
  { value: "REACTIVE", label: "Reactive", eyebrow: "Reactive autoscaling",
    hint: "Scales on the load measured now." },
  { value: "ML", label: "ML predictive", eyebrow: "ML-assisted autoscaling",
    hint: "Scales on the load a linear regression predicts ahead." },
];
const STRATEGY_DEFAULTS = { strategy: "REACTIVE", mlWindowPoints: 20, mlLookAheadSeconds: 60 };
const ML_PREFIX = "[ML] ";

/** Which strategy made a recorded event; ML reasons carry an [ML] prefix. */
export function eventStrategy(reason) {
  return reason.startsWith(ML_PREFIX) ? "ML" : "Reactive";
}

/**
 * Autoscaling: its strategy and settings, the most recent decision and the
 * signals behind it, and the scaling history recorded in MySQL. The backend
 * makes every decision; this panel only changes settings.
 */
export function AutoscalerPanel({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal) => {
    try {
      const next = await fetchAutoscaler(signal);
      if (!mounted.current) return;
      setStatus(next);
      setError(null);
    } catch (reason) {
      if (signal?.aborted || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to read autoscaler");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), POLL_MS);
    const onStateChanged = () => void refresh(controller.signal);
    window.addEventListener(STATE_CHANGED_EVENT, onStateChanged);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener(STATE_CHANGED_EVENT, onStateChanged);
    };
  }, [refresh]);
  const act = async (action) => {
    setBusy(true);
    try {
      await action();
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
      await refresh();
    }
  };
  return (
    <AutoscalerView
      status={status}
      error={error}
      busy={busy}
      onToggle={() => act(() => updateAutoscaler({ enabled: !status.config.enabled }))}
      onSave={(patch) => act(() => updateAutoscaler(patch))}
    />
  );
}

/**
 * Pure view. The switch and the four signals are what an operator watches; the
 * rules, thresholds, and history stay one click away.
 */
export function AutoscalerView({ status, error, busy = false, onToggle, onSave }) {
  if (!status) {
    return (
      <section className="panel autoscaler-panel" aria-label="Autoscaler">
        <header className="panel-head"><div><h2>Autoscaler</h2></div></header>
        <p className="muted">{error ?? "Loading autoscaler…"}</p>
      </section>
    );
  }
  const { lastDecision, events, pausedReason } = status;
  // A backend from before the ML strategy sends none of its settings.
  const config = { ...STRATEGY_DEFAULTS, ...status.config };
  const signals = lastDecision?.signals;
  const on = config.enabled;
  const strategy = STRATEGIES.find((option) => option.value === config.strategy) ?? STRATEGIES[0];
  const decisionText = lastDecision
    ? `${ACTION_TEXT[lastDecision.action] ?? lastDecision.action}${
      lastDecision.action !== "NONE" && !lastDecision.applied ? " (not applied)" : ""}`
    : null;
  return (
    <section className="panel autoscaler-panel" aria-label="Autoscaler">
      <header className="panel-head">
        <div>
          <p className="eyebrow">{strategy.eyebrow}</p>
          <h2>Autoscaler</h2>
        </div>
        <div className="autoscaler-head-actions">
          <fieldset className="strategy-toggle" disabled={busy}>
            <legend className="sr-only">Scaling strategy</legend>
            {STRATEGIES.map((option) => (
              <label key={option.value} title={option.hint}
                className={option.value === strategy.value ? "is-selected" : undefined}>
                <input
                  type="radio"
                  name="autoscale-strategy"
                  value={option.value}
                  checked={option.value === strategy.value}
                  onChange={() => onSave?.({ strategy: option.value })}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`btn autoscale-switch ${on ? "btn-go" : "btn-stop"}`}
            disabled={busy}
            title={on ? "Click to turn autoscaling off" : "Click to turn autoscaling on"}
            onClick={onToggle}
          >
            <span className="switch-knob" aria-hidden="true" />
            Autoscaling: {on ? "On" : "Off"}
          </button>
        </div>
      </header>

      {pausedReason ? (
        <p className="autoscaler-paused" role="status">
          Held while {pausedReason}. It resumes on its own afterwards.
        </p>
      ) : null}

      <dl className="autoscaler-stats">
        <div>
          <dt>Waiting jobs</dt>
          <dd>{signals ? signals.queuedJobs : "—"}</dd>
        </div>
        <div>
          <dt><span className="metric-dot cpu-dot" />CPU reserved</dt>
          <dd>{signals ? percent(signals.utilization.cpu) : "—"}</dd>
        </div>
        <div>
          <dt><span className="metric-dot memory-dot" />Memory reserved</dt>
          <dd>{signals ? percent(signals.utilization.memory) : "—"}</dd>
        </div>
        <div>
          <dt>Workers in service</dt>
          <dd>
            {signals ? signals.workerCount : "—"}
            {signals ? <small>{signals.autoscaledWorkers} of {config.maxWorkers} extra</small> : null}
          </dd>
        </div>
      </dl>

      {strategy.value === "ML" ? (
        <ForecastSummary forecast={status.forecast} history={status.loadHistory ?? []} />
      ) : null}

      <p className="autoscaler-decision" role="status">
        {lastDecision ? (
          <>
            <strong>{decisionText}</strong>
            <span>{lastDecision.reason}</span>
            {lastDecision.evaluatedAt ? (
              <time dateTime={lastDecision.evaluatedAt}>
                {new Date(lastDecision.evaluatedAt).toLocaleTimeString()}
              </time>
            ) : null}
          </>
        ) : (
          <span>No evaluation yet.</span>
        )}
      </p>

      {error ? <p className="warn" role="alert">{error}</p> : null}

      <div className="autoscaler-more">
        <AutoscalerSettings config={config} loop={status.loop} busy={busy} onSave={onSave} />
        <details className="stage-controls">
          <summary>Scaling history ({events.length})</summary>
          {events.length === 0 ? (
            <p className="muted">No scaling actions recorded yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <caption className="sr-only">Recent scaling actions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Strategy</th>
                    <th scope="col">Action</th>
                    <th scope="col">Worker</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString()}</time></td>
                      <td>{eventStrategy(event.reason)}</td>
                      <td>{event.action === "SCALE_UP" ? "Scale up" : "Scale down"}</td>
                      <td className="mono">{event.workerName}</td>
                      <td>{event.queuedJobs}</td>
                      <td>{percent(Math.max(event.cpuUtilization, event.memoryUtilization))}</td>
                      <td>{event.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </div>
    </section>
  );
}

/**
 * What the ML strategy currently predicts, and the measured queue it predicts
 * from as a small trend line.
 */
export function ForecastSummary({ forecast, history }) {
  if (!forecast) {
    return (
      <p className="autoscaler-forecast" role="status">
        <strong>Forecast</strong>
        <span>Collecting load history ({history.length}/3 points) before predicting.</span>
      </p>
    );
  }
  const slope = forecast.queueSlopePerMinute;
  const trend = slope > 0 ? `rising ${slope.toFixed(1)}` : slope < 0 ? `falling ${Math.abs(slope).toFixed(1)}` : "flat at 0";
  return (
    <div className="autoscaler-forecast" role="status">
      <strong>Forecast in {forecast.lookAheadSeconds}s</strong>
      <span>
        {forecast.queuedJobs.toFixed(1)} waiting · {percent(forecast.peak)} reserved · queue{" "}
        {trend} jobs/min
      </span>
      <QueueSparkline history={history} />
      <small>Linear regression over the last {forecast.points} checks</small>
    </div>
  );
}

/** Measured waiting jobs over the forecast window. Decorative; the text says the same. */
function QueueSparkline({ history }) {
  if (history.length < 2) return null;
  const width = 120;
  const height = 28;
  const peak = Math.max(1, ...history.map((point) => point.queuedJobs));
  const points = history.map((point, index) => {
    const x = (index / (history.length - 1)) * width;
    const y = height - (point.queuedJobs / peak) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className="forecast-sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
      aria-hidden="true" focusable="false">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Fields an operator can tune. Utilizations are shown as percentages. */
const SETTINGS = [
  { key: "scaleUpUtilization", label: "Scale up at (% reserved)", min: 5, max: 100, percent: true },
  { key: "scaleDownUtilization", label: "Scale down below (% reserved)", min: 5, max: 100, percent: true },
  { key: "scaleUpQueueThreshold", label: "Waiting jobs needed to scale up", min: 1, max: 1000 },
  { key: "maxWorkers", label: "Most extra workers", min: 0, max: 20 },
  { key: "idleSeconds", label: "Idle time before retiring (s)", min: 0, max: 3600 },
  { key: "cooldownSeconds", label: "Wait between changes (s)", min: 0, max: 3600 },
  { key: "mlWindowPoints", label: "ML history points", min: 3, max: 100 },
  { key: "mlLookAheadSeconds", label: "ML look-ahead (s)", min: 5, max: 300 },
];
const DEMO_PRESET = {
  scaleUpUtilization: 0.6,
  scaleDownUtilization: 0.3,
  scaleUpQueueThreshold: 2,
  idleSeconds: 10,
  cooldownSeconds: 5,
};
const DEFAULT_PRESET = {
  scaleUpUtilization: 0.75,
  scaleDownUtilization: 0.4,
  scaleUpQueueThreshold: 2,
  idleSeconds: 30,
  cooldownSeconds: 15,
};
function toForm(config) {
  return Object.fromEntries(SETTINGS.map(({ key, percent }) => [
    key, percent ? Math.round(config[key] * 100) : config[key],
  ]));
}
function toPatch(form) {
  return Object.fromEntries(SETTINGS.map(({ key, percent }) => [
    key, percent ? Number(form[key]) / 100 : Number(form[key]),
  ]));
}
/**
 * Rules and threshold editor. The form keeps its own draft so the 3-second
 * refresh does not overwrite what is being typed; the backend validates on save.
 */
function AutoscalerSettings({ config, loop, busy, onSave }) {
  const [draft, setDraft] = useState(() => toForm(config));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(toForm(config));
  }, [config, dirty]);
  const save = async (patch) => {
    await onSave(patch);
    setDirty(false);
  };
  return (
    <details className="stage-controls">
      <summary>Rules and thresholds</summary>
      <p className="hint">
        Adds a {config.workerCpuMillicores}m / {config.workerMemoryMiB} MiB worker when at least{" "}
        {config.scaleUpQueueThreshold} jobs wait and the cluster is {percent(config.scaleUpUtilization)}{" "}
        reserved, up to {config.maxWorkers} extra workers. Retires an idle extra worker after{" "}
        {config.idleSeconds}s once the cluster would stay below {percent(config.scaleDownUtilization)}.
        Waits {config.cooldownSeconds}s between changes. ML predictive applies the same rule to the load
        predicted {config.mlLookAheadSeconds}s ahead from the last {config.mlWindowPoints} checks, and keeps
        an idle worker while load is predicted to return.
        {loop.enabled
          ? ` Checked automatically every ${loop.intervalSeconds}s.`
          : " Automatic checks are off on the backend (AUTOSCALE_INTERVAL_SECONDS=0)."}
      </p>
      <form
        className="autoscaler-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save(toPatch(draft));
        }}
      >
        {SETTINGS.map(({ key, label, min, max }) => (
          <label key={key} htmlFor={`autoscale-${key}`}>
            {label}
            <input
              id={`autoscale-${key}`}
              type="number"
              min={min}
              max={max}
              step={1}
              required
              value={draft[key]}
              disabled={busy}
              onChange={(event) => {
                setDirty(true);
                setDraft({ ...draft, [key]: event.target.value });
              }}
            />
          </label>
        ))}
        <div className="stage-buttons autoscaler-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            Save thresholds
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => void save(DEMO_PRESET)}>
            Quick demo preset
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => void save(DEFAULT_PRESET)}>
            Restore defaults
          </button>
        </div>
        <p className="hint">
          The demo preset scales up at 60%, retires after 10s idle, and waits 5s between changes.
          Settings last until the backend restarts.
        </p>
      </form>
    </details>
  );
}
