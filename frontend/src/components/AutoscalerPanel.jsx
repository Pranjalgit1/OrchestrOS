import { useCallback, useEffect, useRef, useState } from "react";
import {
  STATE_CHANGED_EVENT,
  evaluateAutoscaler,
  fetchAutoscaler,
  updateAutoscaler,
} from "../api";
import { Icon } from "./Icon.jsx";

const POLL_MS = 3_000;

function percent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

const ACTION_TEXT = { SCALE_UP: "Scaled up", SCALE_DOWN: "Scaled down", NONE: "No change" };

/**
 * Reactive autoscaling: its settings, the most recent decision and the signals
 * behind it, and the scaling history recorded in MySQL. The backend makes every
 * decision; this panel only switches it on or off and asks for an evaluation.
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
      onEvaluate={() => act(evaluateAutoscaler)}
      onSave={(patch) => act(() => updateAutoscaler(patch))}
    />
  );
}

/**
 * Pure view. The switch and the four signals are what an operator watches; the
 * rules, thresholds, and history stay one click away.
 */
export function AutoscalerView({ status, error, busy = false, onToggle, onEvaluate, onSave }) {
  if (!status) {
    return (
      <section className="panel autoscaler-panel" aria-label="Autoscaler">
        <header className="panel-head"><div><h2>Autoscaler</h2></div></header>
        <p className="muted">{error ?? "Loading autoscaler…"}</p>
      </section>
    );
  }
  const { config, lastDecision, events, pausedReason } = status;
  const signals = lastDecision?.signals;
  const on = config.enabled;
  const decisionText = lastDecision
    ? `${ACTION_TEXT[lastDecision.action] ?? lastDecision.action}${
      lastDecision.action !== "NONE" && !lastDecision.applied ? " (not applied)" : ""}`
    : null;
  return (
    <section className="panel autoscaler-panel" aria-label="Autoscaler">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Reactive autoscaling</p>
          <h2>Autoscaler</h2>
        </div>
        <div className="autoscaler-head-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onEvaluate}
            title="Run one scaling decision now">
            <Icon name="refresh" />Evaluate now
          </button>
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

/** Fields an operator can tune. Utilizations are shown as percentages. */
const SETTINGS = [
  { key: "scaleUpUtilization", label: "Scale up at (% reserved)", min: 5, max: 100, percent: true },
  { key: "scaleDownUtilization", label: "Scale down below (% reserved)", min: 5, max: 100, percent: true },
  { key: "scaleUpQueueThreshold", label: "Waiting jobs needed to scale up", min: 1, max: 1000 },
  { key: "maxWorkers", label: "Most extra workers", min: 0, max: 20 },
  { key: "idleSeconds", label: "Idle time before retiring (s)", min: 0, max: 3600 },
  { key: "cooldownSeconds", label: "Wait between changes (s)", min: 0, max: 3600 },
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
        Waits {config.cooldownSeconds}s between changes.
        {loop.enabled ? ` Checked every ${loop.intervalSeconds}s.` : " The timer is off; use Evaluate now."}
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
