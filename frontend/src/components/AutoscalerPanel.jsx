import { useCallback, useEffect, useRef, useState } from "react";
import {
  STATE_CHANGED_EVENT,
  evaluateAutoscaler,
  fetchAutoscaler,
  updateAutoscaler,
} from "../api";

const POLL_MS = 3_000;

function percent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

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
  if (!status) {
    return (
      <section className="panel autoscaler-panel" aria-label="Autoscaler">
        <header className="panel-head"><div><h2>Autoscaler</h2></div></header>
        <p className="muted">{error ?? "Loading autoscaler…"}</p>
      </section>
    );
  }
  const { config, lastDecision, events } = status;
  const signals = lastDecision?.signals;
  return (
    <section className="panel autoscaler-panel" aria-label="Autoscaler">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Reactive autoscaling</p>
          <h2>Autoscaler</h2>
        </div>
        <span className={`badge ${config.enabled ? "badge-active" : "badge-idle"}`}>
          {config.enabled ? "ON" : "OFF"}
        </span>
      </header>

      <div className="stage-buttons autoscaler-actions">
        <button
          type="button"
          className={config.enabled ? "btn btn-stop" : "btn btn-primary"}
          disabled={busy}
          aria-pressed={config.enabled}
          onClick={() => act(() => updateAutoscaler({ enabled: !config.enabled }))}
        >
          {config.enabled ? "Turn autoscaling off" : "Turn autoscaling on"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => act(evaluateAutoscaler)}
        >
          Evaluate now
        </button>
      </div>

      <p className="hint">
        Adds a {config.workerCpuMillicores}m / {config.workerMemoryMiB} MiB worker when at least{" "}
        {config.scaleUpQueueThreshold} jobs wait and the cluster is {percent(config.scaleUpUtilization)}{" "}
        reserved, up to {config.maxWorkers} extra workers. Retires an idle extra worker after{" "}
        {config.idleSeconds}s once the cluster would stay below {percent(config.scaleDownUtilization)}.
        Waits {config.cooldownSeconds}s between changes.
        {status.loop.enabled ? ` Checked every ${status.loop.intervalSeconds}s.` : " The timer is off; use Evaluate now."}
      </p>

      {lastDecision ? (
        <dl className="facts">
          <div>
            <dt>Last decision</dt>
            <dd>
              {lastDecision.action === "NONE" ? "No change" : lastDecision.action.replace("_", " ").toLowerCase()}
              {lastDecision.evaluatedAt ? ` · ${new Date(lastDecision.evaluatedAt).toLocaleTimeString()}` : ""}
            </dd>
          </div>
          <div>
            <dt>Why</dt>
            <dd>{lastDecision.reason}</dd>
          </div>
          {signals ? (
            <>
              <div>
                <dt>Waiting jobs</dt>
                <dd>{signals.queuedJobs}</dd>
              </div>
              <div>
                <dt>Cluster reserved</dt>
                <dd>CPU {percent(signals.utilization.cpu)} · memory {percent(signals.utilization.memory)}</dd>
              </div>
              <div>
                <dt>Workers in service</dt>
                <dd>{signals.workerCount} ({signals.autoscaledWorkers} autoscaled of {config.maxWorkers})</dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="muted">No evaluation yet.</p>
      )}

      {error ? <p className="warn">{error}</p> : null}

      <details className="stage-controls" open={events.length > 0}>
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
    </section>
  );
}
