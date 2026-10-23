import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAutoScalingStatus,
  triggerAutoScaling,
  updateAutoScalingConfig,
} from "../api";

const MODES = [
  { value: "OFF", label: "Off", desc: "No automatic scaling" },
  { value: "REACTIVE", label: "Reactive", desc: "Responds to current load" },
  { value: "ML", label: "ML Predictive", desc: "Predicts future load" },
  { value: "BOTH", label: "Both", desc: "Reactive + ML combined" },
];

const DIRECTION_META = {
  UP: { label: "Scale Up", className: "badge-scale-up", icon: "↑" },
  DOWN: { label: "Scale Down", className: "badge-scale-down", icon: "↓" },
  STABLE: { label: "Stable", className: "badge-stable", icon: "●" },
};

function DirectionBadge({ direction }) {
  const meta = DIRECTION_META[direction] ?? DIRECTION_META.STABLE;
  return (
    <span className={`scale-badge ${meta.className}`}>
      <span className="scale-badge-icon">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

function ModeToggle({ current, onChange, disabled }) {
  return (
    <div className="mode-toggle" role="group" aria-label="Auto scaling mode">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          className={`mode-btn${current === m.value ? " mode-btn-active" : ""}`}
          onClick={() => onChange(m.value)}
          disabled={disabled}
          title={m.desc}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function MetricBar({ label, value, max = 1, unit = "%" }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const isHigh = pct >= 75;
  const isMed = pct >= 40 && !isHigh;
  return (
    <div className="as-metric-row">
      <span className="as-metric-label">{label}</span>
      <div className="as-bar-track">
        <div
          className={`as-bar-fill${isHigh ? " as-bar-high" : isMed ? " as-bar-med" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="as-metric-val">
        {unit === "%" ? `${Math.round(value * 100)}%` : value}
      </span>
    </div>
  );
}

function MiniSparkline({ data, label }) {
  if (!data || data.length < 2) return null;
  const W = 200;
  const H = 40;
  const vals = data.map((d) => d.cpuUtil);
  const min = Math.min(...vals);
  const max = Math.max(...vals, 0.01);
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / (max - min)) * (H - 4) - 2;
    return `${x},${y}`;
  });
  return (
    <figure className="as-sparkline">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={label}>
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="var(--as-spark)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function DecisionRow({ decision }) {
  const meta = DIRECTION_META[decision.direction] ?? DIRECTION_META.STABLE;
  return (
    <li className={`decision-row decision-${decision.direction.toLowerCase()}`}>
      <span className="decision-time">
        {new Date(decision.at).toLocaleTimeString()}
      </span>
      <span className={`decision-dir ${meta.className}`}>
        {meta.icon} {meta.label}
      </span>
      <span className="decision-reason">{decision.reason}</span>
      {decision.dryRun && <span className="dry-run-tag">dry run</span>}
    </li>
  );
}

export function AutoScalingPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [localConfig, setLocalConfig] = useState(null);
  const pollRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchAutoScalingStatus();
      setStatus(data);
      if (!localConfig) setLocalConfig(data.config);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load auto scaling status");
    }
  }, [localConfig]);

  useEffect(() => {
    loadStatus();
    pollRef.current = setInterval(loadStatus, 4000);
    return () => clearInterval(pollRef.current);
  }, [loadStatus]);

  const applyConfig = async (updates) => {
    setBusy(true);
    try {
      const merged = { ...localConfig, ...updates };
      setLocalConfig(merged);
      await updateAutoScalingConfig(merged);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Config update failed");
    } finally {
      setBusy(false);
    }
  };

  const handleTrigger = async (dryRun) => {
    setBusy(true);
    try {
      await triggerAutoScaling(dryRun);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trigger failed");
    } finally {
      setBusy(false);
    }
  };

  const cfg = localConfig;

  return (
    <section className="as-panel" aria-label="Auto scaling">
      <header className="as-header">
        <div>
          <p className="eyebrow">Cluster intelligence</p>
          <h2>Auto Scaling</h2>
          <p className="as-subtitle">
            Automatically adjust worker count based on live load and ML predictions.
          </p>
        </div>
        {status && (
          <div className="as-header-right">
            <DirectionBadge
              direction={status.lastDecision?.direction ?? "STABLE"}
            />
            <span className="as-worker-count">
              {status.currentMetrics.workerCount} worker
              {status.currentMetrics.workerCount !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </header>

      {error && <p className="error-banner">{error}</p>}

      {/* Mode selector */}
      <div className="as-section">
        <h3 className="as-section-title">Scaling Mode</h3>
        {cfg && (
          <ModeToggle
            current={cfg.mode}
            disabled={busy}
            onChange={(mode) => applyConfig({ mode })}
          />
        )}
        <p className="hint">
          <strong>Reactive</strong> — fires when current CPU or queue depth crosses
          a threshold. &nbsp;
          <strong>ML Predictive</strong> — uses linear regression over recent
          snapshots to pre-scale before saturation.
        </p>
      </div>

      {status && (
        <div className="as-metrics-row">
          <MetricBar
            label="CPU utilization"
            value={status.currentMetrics.cpuUtilization}
          />
          <MetricBar
            label="Queue depth"
            value={status.currentMetrics.queueDepth}
            max={Math.max(10, status.currentMetrics.queueDepth)}
            unit="jobs"
          />
        </div>
      )}

      {/* Threshold configuration */}
      {cfg && (
        <div className="as-section as-thresholds">
          <h3 className="as-section-title">Reactive Thresholds</h3>
          <div className="as-fields">
            <label className="as-field">
              <span>CPU scale-up (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(cfg.cpuScaleUpThreshold * 100)}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    cpuScaleUpThreshold: Number(e.target.value) / 100,
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
            <label className="as-field">
              <span>CPU scale-down (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(cfg.cpuScaleDownThreshold * 100)}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    cpuScaleDownThreshold: Number(e.target.value) / 100,
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
            <label className="as-field">
              <span>Queue scale-up (jobs)</span>
              <input
                type="number"
                min={1}
                value={cfg.queueDepthScaleUpThreshold}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    queueDepthScaleUpThreshold: Number(e.target.value),
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
            <label className="as-field">
              <span>Queue scale-down (jobs)</span>
              <input
                type="number"
                min={0}
                value={cfg.queueDepthScaleDownThreshold}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    queueDepthScaleDownThreshold: Number(e.target.value),
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
            <label className="as-field">
              <span>Min workers</span>
              <input
                type="number"
                min={1}
                value={cfg.minWorkers}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    minWorkers: Number(e.target.value),
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
            <label className="as-field">
              <span>Max workers</span>
              <input
                type="number"
                min={1}
                value={cfg.maxWorkers}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    maxWorkers: Number(e.target.value),
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
          </div>

          <h3 className="as-section-title" style={{ marginTop: "1rem" }}>
            ML Settings
          </h3>
          <div className="as-fields">
            <label className="as-field">
              <span>History window (points)</span>
              <input
                type="number"
                min={3}
                max={100}
                value={cfg.mlWindowPoints}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    mlWindowPoints: Number(e.target.value),
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
            <label className="as-field">
              <span>Look-ahead (seconds)</span>
              <input
                type="number"
                min={10}
                max={300}
                value={cfg.mlLookAheadSeconds}
                disabled={busy}
                onChange={(e) =>
                  setLocalConfig((c) => ({
                    ...c,
                    mlLookAheadSeconds: Number(e.target.value),
                  }))
                }
                onBlur={() => applyConfig({})}
              />
            </label>
          </div>
        </div>
      )}

      {/* ML history sparkline */}
      {status?.mlHistory?.length > 1 && (
        <div className="as-section">
          <h3 className="as-section-title">ML History (CPU trend)</h3>
          <MiniSparkline
            data={status.mlHistory}
            label="CPU utilization over recent samples"
          />
        </div>
      )}

      {/* Manual trigger actions */}
      <div className="as-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => handleTrigger(false)}
          disabled={busy || cfg?.mode === "OFF"}
        >
          {busy ? "Evaluating…" : "▶ Trigger Now"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => handleTrigger(true)}
          disabled={busy || cfg?.mode === "OFF"}
        >
          🔍 Dry Run
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={loadStatus}
          disabled={busy}
        >
          ↺ Refresh
        </button>
      </div>

      {/* Decision log */}
      {status?.recentDecisions?.length > 0 && (
        <div className="as-section">
          <h3 className="as-section-title">
            Decision Log
            <span className="as-log-count">
              {status.recentDecisions.length} recent
            </span>
          </h3>
          <ul className="decision-log">
            {status.recentDecisions.map((d, i) => (
              <DecisionRow key={i} decision={d} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
