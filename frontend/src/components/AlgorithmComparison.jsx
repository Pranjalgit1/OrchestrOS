import { useState } from "react";
import { runAlgorithmComparison } from "../api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLICY_META = {
  FCFS: { label: "FCFS", color: "hsl(220 80% 62%)", desc: "First Come First Served" },
  SJF: { label: "SJF", color: "hsl(160 70% 48%)", desc: "Shortest Job First" },
  PRIORITY: { label: "Priority", color: "hsl(36 90% 58%)", desc: "Priority with Aging" },
  ROUND_ROBIN: { label: "Round Robin", color: "hsl(280 65% 62%)", desc: "Round Robin" },
};

const ALL_POLICIES = ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"];

const ARRIVALS = [
  { value: "IMMEDIATE", label: "Immediate" },
  { value: "LIGHT", label: "Light (20–40s)" },
  { value: "MEDIUM", label: "Medium (8–16s)" },
  { value: "HEAVY", label: "Heavy (2–6s)" },
  { value: "CONSTANT", label: "Constant (10s)" },
  { value: "BURST", label: "Burst (5/30s)" },
  { value: "INCREASING", label: "Increasing ramp" },
  { value: "DECREASING", label: "Decreasing ramp" },
];

const METRIC_DEFS = [
  { key: "avgWaitSeconds", label: "Avg Wait Time", unit: "s", lowerBetter: true },
  { key: "avgTurnaroundSeconds", label: "Avg Turnaround", unit: "s", lowerBetter: true },
  { key: "avgExecutionSeconds", label: "Avg Execution", unit: "s", lowerBetter: false },
  { key: "throughputPerMinute", label: "Throughput", unit: "jobs/min", lowerBetter: false },
  { key: "cpuUtilization", label: "CPU Utilization", unit: "%", lowerBetter: false },
  { key: "priorityInversions", label: "Priority Inversions", unit: "", lowerBetter: true },
];

// ---------------------------------------------------------------------------
// Bar Chart (pure SVG)
// ---------------------------------------------------------------------------

function BarChart({ title, metricKey, results, unit, lowerBetter }) {
  if (!results || results.length === 0) return null;

  const W = 460;
  const H = 180;
  const PADDING = { top: 20, right: 16, bottom: 48, left: 52 };
  const chartW = W - PADDING.left - PADDING.right;
  const chartH = H - PADDING.top - PADDING.bottom;

  const values = results.map((r) => r[metricKey] ?? 0);
  const maxVal = Math.max(...values, 0.001);
  const barW = Math.floor((chartW / results.length) * 0.6);
  const gap = chartW / results.length;

  // Y-axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1.0].map((t) => ({
    y: PADDING.top + chartH * (1 - t),
    label: unit === "%" ? `${Math.round(t * maxVal * 100)}%` : `${(t * maxVal).toFixed(1)}`,
  }));

  // Best value
  const bestIdx = lowerBetter
    ? values.indexOf(Math.min(...values))
    : values.indexOf(Math.max(...values));

  const [tooltip, setTooltip] = useState(null);

  return (
    <div className="cmp-chart-card">
      <h4 className="cmp-chart-title">{title}</h4>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="cmp-svg"
        role="img"
        aria-label={`Bar chart: ${title}`}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Y-axis grid + labels */}
        {ticks.map((t) => (
          <g key={t.y}>
            <line
              x1={PADDING.left}
              x2={W - PADDING.right}
              y1={t.y}
              y2={t.y}
              stroke="var(--cmp-grid)"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <text
              x={PADDING.left - 6}
              y={t.y + 4}
              textAnchor="end"
              className="cmp-axis-label"
            >
              {t.label}
            </text>
          </g>
        ))}

        {/* Bars */}
        {results.map((r, i) => {
          const barH = Math.max(2, (values[i] / maxVal) * chartH);
          const x = PADDING.left + gap * i + (gap - barW) / 2;
          const y = PADDING.top + chartH - barH;
          const isBest = i === bestIdx;
          const meta = POLICY_META[r.policy] ?? { color: "#888", label: r.policy };
          return (
            <g key={r.policy}>
              {/* Glow ring for best */}
              {isBest && (
                <rect
                  x={x - 3}
                  y={y - 3}
                  width={barW + 6}
                  height={barH + 6}
                  rx={5}
                  fill="none"
                  stroke={meta.color}
                  strokeWidth="2"
                  opacity="0.5"
                />
              )}
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={4}
                fill={meta.color}
                opacity={isBest ? 1 : 0.65}
                className="cmp-bar"
                onMouseEnter={(e) =>
                  setTooltip({
                    x: x + barW / 2,
                    y: y - 10,
                    label: meta.label,
                    value: unit === "%" ? `${(values[i] * 100).toFixed(1)}%` : `${values[i]} ${unit}`,
                    isBest,
                  })
                }
              />
              {/* X-axis label */}
              <text
                x={x + barW / 2}
                y={H - PADDING.bottom + 16}
                textAnchor="middle"
                className="cmp-axis-label"
              >
                {meta.label}
              </text>
              {/* Best badge */}
              {isBest && (
                <text
                  x={x + barW / 2}
                  y={y - 6}
                  textAnchor="middle"
                  className="cmp-best-star"
                >
                  ★
                </text>
              )}
            </g>
          );
        })}

        {/* Tooltip */}
        {tooltip && (
          <g>
            <rect
              x={Math.min(tooltip.x - 44, W - 100)}
              y={tooltip.y - 24}
              width={88}
              height={28}
              rx={5}
              fill="var(--cmp-tooltip-bg)"
            />
            <text
              x={Math.min(tooltip.x, W - 56)}
              y={tooltip.y - 10}
              textAnchor="middle"
              className="cmp-tooltip-label"
            >
              {tooltip.label}: {tooltip.value}
              {tooltip.isBest ? " ★" : ""}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary Table
// ---------------------------------------------------------------------------

function SummaryTable({ results }) {
  if (!results || results.length === 0) return null;

  function bestFor(metricKey, lowerBetter) {
    const vals = results.map((r) => r[metricKey] ?? 0);
    const best = lowerBetter ? Math.min(...vals) : Math.max(...vals);
    return results.find((r) => (r[metricKey] ?? 0) === best)?.policy;
  }

  return (
    <div className="cmp-table-wrap table-scroll">
      <table className="grid cmp-summary-table">
        <thead>
          <tr>
            <th scope="col">Algorithm</th>
            {METRIC_DEFS.map((m) => (
              <th scope="col" key={m.key}>
                {m.label}
                {m.unit ? ` (${m.unit})` : ""}
              </th>
            ))}
            <th scope="col">Completed</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const meta = POLICY_META[r.policy] ?? { label: r.policy, color: "#888" };
            return (
              <tr key={r.policy}>
                <td>
                  <span className="cmp-policy-dot" style={{ background: meta.color }} />
                  <strong>{meta.label}</strong>
                  <br />
                  <small className="muted">{meta.desc}</small>
                </td>
                {METRIC_DEFS.map((m) => {
                  const isBest = bestFor(m.key, m.lowerBetter) === r.policy;
                  const val = r[m.key] ?? 0;
                  const display =
                    m.unit === "%" ? `${(val * 100).toFixed(1)}%` : val;
                  return (
                    <td key={m.key} className={isBest ? "cmp-best-cell" : ""}>
                      {display}
                      {isBest && <span className="cmp-best-tag">best</span>}
                    </td>
                  );
                })}
                <td>
                  {r.completedCount}/{r.jobCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Winner Summary
// ---------------------------------------------------------------------------

function WinnerSummary({ results }) {
  if (!results || results.length < 2) return null;

  const winners = METRIC_DEFS.map((m) => {
    const vals = results.map((r) => r[m.key] ?? 0);
    const best = m.lowerBetter ? Math.min(...vals) : Math.max(...vals);
    const winner = results.find((r) => (r[m.key] ?? 0) === best);
    return { metric: m.label, policy: winner?.policy, color: POLICY_META[winner?.policy]?.color };
  });

  const tally = {};
  for (const w of winners) {
    tally[w.policy] = (tally[w.policy] ?? 0) + 1;
  }
  const overall = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];

  return (
    <div className="cmp-winner-section">
      <h3 className="as-section-title">
        🏆 Overall Winner —{" "}
        <span style={{ color: POLICY_META[overall?.[0]]?.color }}>
          {POLICY_META[overall?.[0]]?.label ?? overall?.[0]}
        </span>
        <span className="muted"> ({overall?.[1]} categories)</span>
      </h3>
      <div className="cmp-winner-chips">
        {winners.map((w) => (
          <span
            key={w.metric}
            className="cmp-winner-chip"
            style={{ borderColor: w.color }}
          >
            <span style={{ color: w.color }}>★ {POLICY_META[w.policy]?.label}</span>
            <span className="muted"> — {w.metric}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function AlgorithmComparison() {
  const [seed, setSeed] = useState(42);
  const [count, setCount] = useState(20);
  const [pattern, setPattern] = useState("IMMEDIATE");
  const [selectedPolicies, setSelectedPolicies] = useState(new Set(ALL_POLICIES));
  const [timeQuantum, setTimeQuantum] = useState(10);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastParams, setLastParams] = useState(null);

  const togglePolicy = (p) => {
    setSelectedPolicies((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        if (next.size > 1) next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  };

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    try {
      const policies = ALL_POLICIES.filter((p) => selectedPolicies.has(p));
      const params = {
        seed,
        count,
        pattern,
        policies,
        ...(selectedPolicies.has("ROUND_ROBIN") ? { timeQuantumSeconds: timeQuantum } : {}),
      };
      setLastParams(params);
      const data = await runAlgorithmComparison(params);
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="cmp-panel" aria-label="Algorithm comparison">
      <header className="as-header">
        <div>
          <p className="eyebrow">Performance analysis</p>
          <h2>Algorithm Comparison</h2>
          <p className="as-subtitle">
            Simulate multiple scheduling policies against the same deterministic
            workload and compare their performance side-by-side.
          </p>
        </div>
      </header>

      {/* Configuration */}
      <div className="cmp-config">
        <div className="cmp-config-row">
          <label className="as-field">
            <span>Seed (deterministic)</span>
            <input
              type="number"
              min={0}
              max={2147483647}
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              disabled={loading}
              id="cmp-seed"
            />
          </label>
          <label className="as-field">
            <span>Job count</span>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              disabled={loading}
            >
              {[10, 20, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n} jobs
                </option>
              ))}
            </select>
          </label>
          <label className="as-field">
            <span>Arrival pattern</span>
            <select
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              disabled={loading}
            >
              {ARRIVALS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          {selectedPolicies.has("ROUND_ROBIN") && (
            <label className="as-field">
              <span>Time quantum (s)</span>
              <input
                type="number"
                min={1}
                max={3600}
                value={timeQuantum}
                onChange={(e) => setTimeQuantum(Number(e.target.value))}
                disabled={loading}
              />
            </label>
          )}
        </div>

        {/* Algorithm selector */}
        <div className="cmp-policy-row">
          <span className="cmp-policy-label">Algorithms to compare:</span>
          {ALL_POLICIES.map((p) => {
            const meta = POLICY_META[p];
            const active = selectedPolicies.has(p);
            return (
              <button
                key={p}
                type="button"
                className={`cmp-policy-chip${active ? " active" : ""}`}
                style={active ? { background: meta.color, borderColor: meta.color } : {}}
                onClick={() => togglePolicy(p)}
                disabled={loading}
                title={meta.desc}
              >
                {meta.label}
              </button>
            );
          })}
        </div>

        <div className="cmp-run-row">
          <button
            type="button"
            className="btn btn-primary cmp-run-btn"
            onClick={handleRun}
            disabled={loading || selectedPolicies.size === 0}
          >
            {loading ? (
              <>
                <span className="cmp-spinner" aria-hidden="true" />
                Simulating…
              </>
            ) : (
              "▶ Run Comparison"
            )}
          </button>
          <p className="hint" style={{ margin: 0 }}>
            Same seed = identical jobs for every algorithm. Pure in-memory
            simulation — nothing is written to the database.
          </p>
        </div>

        {lastParams && (
          <p className="hint mono">
            Seed {lastParams.seed} · {lastParams.count} jobs · {lastParams.pattern} ·{" "}
            {lastParams.policies.join(", ")}
          </p>
        )}
      </div>

      {error && <p className="error-banner">{error}</p>}

      {/* Results */}
      {results && results.length > 0 && (
        <>
          <WinnerSummary results={results} />

          {/* Bar charts grid */}
          <div className="cmp-charts-grid">
            {METRIC_DEFS.map((m) => (
              <BarChart
                key={m.key}
                title={m.label}
                metricKey={m.key}
                results={results}
                unit={m.unit}
                lowerBetter={m.lowerBetter}
              />
            ))}
          </div>

          {/* Legend */}
          <div className="cmp-legend">
            {results.map((r) => {
              const meta = POLICY_META[r.policy] ?? { color: "#888", label: r.policy };
              return (
                <span key={r.policy} className="cmp-legend-item">
                  <span
                    className="cmp-legend-dot"
                    style={{ background: meta.color }}
                  />
                  {meta.label}
                  <span className="muted"> — {meta.desc}</span>
                </span>
              );
            })}
            <span className="cmp-legend-item muted">
              ★ = best value for that metric
            </span>
          </div>

          <SummaryTable results={results} />

          <p className="hint">
            Simulation uses the same deterministic seed across all algorithms.
            Results show scheduling metrics only — actual execution time may vary
            in a live cluster.
          </p>
        </>
      )}

      {!results && !loading && (
        <div className="cmp-empty">
          <div className="cmp-empty-icon">📊</div>
          <p>Configure the workload above and click <strong>Run Comparison</strong> to see results.</p>
          <p className="muted">
            The same seed guarantees identical jobs are scheduled by each
            algorithm — making the comparison perfectly fair.
          </p>
        </div>
      )}
    </section>
  );
}
