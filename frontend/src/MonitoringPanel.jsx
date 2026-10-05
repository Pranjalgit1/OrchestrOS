import { useEffect, useRef, useState } from "react";
import {
  captureSample,
  fetchJobMetrics,
  fetchOverview,
  fetchSampleHistory,
  STATE_CHANGED_EVENT,
} from "./api";
import { createMonitoringPoller } from "./monitoring.poller.js";
import { CapacityGauge } from "./components/CapacityGauge.jsx";
import { Icon } from "./components/Icon.jsx";

const REFRESH_SECONDS = 2;
const WINDOW_MINUTES = 60;
/** Job states shown in the queue breakdown, in lifecycle order. */
const QUEUE_ORDER = [
  "CREATED",
  "QUEUED",
  "WAITING",
  "SCHEDULED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "CANCELLED",
];
const TIMING_LABELS = {
  queueWait: "Queue wait",
  placementDelay: "Placement delay",
  startDelay: "Start delay",
  execution: "Execution",
  turnaround: "Total turnaround",
};
function percent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}
function seconds(value) {
  if (value === null) return "-";
  if (value < 1) return `${Math.round(value * 1000)}ms`;
  return `${Math.round(value * 100) / 100}s`;
}
/** Inline sparkline of recorded cluster utilization, drawn without a chart library. */
function Sparkline({ history }) {
  if (!history || history.points.length < 2) {
    return (
      <p className="muted spark-placeholder">
        {history?.pointCount === 0
          ? "No samples recorded yet. The sampler writes one every few seconds."
          : "Collecting samples…"}
      </p>
    );
  }
  const points = history.points;
  const width = 600;
  const height = 90;
  const step = width / Math.max(1, points.length - 1);
  const line = (pick) =>
    points
      .map((_, index) => {
        const x = index * step;
        const y = height - pick(index) * height;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const cpuPath = line((index) => points[index]?.cpuUtilization ?? 0);
  const memoryPath = line((index) => points[index]?.memoryUtilization ?? 0);
  return (
    <figure className="spark">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cluster utilization over the last ${history.windowMinutes} minutes`}
      >
        <g className="spark-grid">
          {[0, 22.5, 45, 67.5, 90].map((y) => <line key={y} x1="0" x2={width} y1={y} y2={y} />)}
        </g>
        <path d={cpuPath} className="spark-cpu" />
        <path d={memoryPath} className="spark-memory" />
      </svg>
      <figcaption>
        <span className="key key-cpu">CPU</span>
        <span className="key key-memory">Memory</span>
      </figcaption>
    </figure>
  );
}
export function MonitoringPanel() {
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const poller = useRef(null);
  useEffect(() => {
    const setters = { overview: setOverview, jobs: setJobs, history: setHistory };
    const current = createMonitoringPoller({
      sources: {
        overview: { label: "Live state", fetch: fetchOverview, intervalMs: REFRESH_SECONDS * 1000 },
        jobs: { label: "Job timings", fetch: (signal) => fetchJobMetrics(WINDOW_MINUTES, signal), intervalMs: 5000 },
        history: { label: "Chart history", fetch: (signal) => fetchSampleHistory(WINDOW_MINUTES, signal), intervalMs: 5000 },
      },
      onData: (key, data) => setters[key](data),
      onError: setError,
    });
    poller.current = current;
    const refreshLive = () => current.refresh(["overview", "jobs"]);
    window.addEventListener(STATE_CHANGED_EVENT, refreshLive);
    return () => {
      window.removeEventListener(STATE_CHANGED_EVENT, refreshLive);
      current.stop();
      poller.current = null;
    };
  }, []);
  const onCapture = async () => {
    setBusy(true);
    try {
      await captureSample();
      poller.current?.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Sample capture failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return <MonitoringView overview={overview} jobs={jobs} history={history}
    error={error} busy={busy} onRefresh={() => poller.current?.refresh()} onCapture={() => void onCapture()} />;
}

/** Display metrics independently of polling so every loading/data state can be reviewed. */
export function MonitoringView({ overview, jobs, history, error, busy, onRefresh, onCapture }) {
  return (
    <section className="monitor" aria-label="Live monitoring">
      <header className="monitor-head">
        <div>
          <p className="eyebrow">Live monitoring</p>
          <h2>Cluster state</h2>
        </div>
        <details className="monitor-tools">
          <summary>Monitoring tools</summary>
          <p className="hint">Live state updates automatically. Refresh reads it now; Save snapshot records worker values for the chart.</p>
          <div className="monitor-actions">
            <button type="button" onClick={onRefresh} disabled={busy}
              title="Read the latest monitoring values without writing to the database">
              <Icon name="refresh" />Refresh now
            </button>
            <button type="button" onClick={onCapture} disabled={busy}
              title="Save one CPU and memory reservation snapshot per worker">
              <Icon name="camera" />{busy ? "Saving…" : "Save snapshot"}
            </button>
          </div>
        </details>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      {overview ? (
        <>
          <div className="monitor-grid">
            <article className="tile reserved-tile">
              <h3>Reserved capacity</h3>
              <CapacityGauge cpu={overview.cluster.cpuUtilization}
                memory={overview.cluster.memoryUtilization} label="Cluster capacity" />
              <dl className="capacity-legend">
                <div>
                  <dt title="Millicores: 1000m = 1 CPU core"><span className="metric-dot cpu-dot" />CPU (m)</dt>
                  <dd>{overview.cluster.cpuAllocatedMillicores.toLocaleString()} / {overview.cluster.cpuCapacityMillicores.toLocaleString()} m</dd>
                </div>
                <div>
                  <dt><span className="metric-dot memory-dot" />Memory</dt>
                  <dd>{overview.cluster.memoryAllocatedMiB.toLocaleString()} / {overview.cluster.memoryCapacityMiB.toLocaleString()} MiB</dd>
                </div>
              </dl>
            </article>

            <article className="tile">
              <h3>Queue</h3>
              <dl className="stats">
                <div>
                  <dt>Waiting to run</dt>
                  <dd>{overview.queue.waitingToRun}</dd>
                </div>
                <div>
                  <dt>Running</dt>
                  <dd>{overview.queue.active}</dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>{overview.queue.finished}</dd>
                </div>
                <div>
                  <dt>Active reservations</dt>
                  <dd>{overview.reservations.active}</dd>
                </div>
              </dl>
              <div className="chips">
                {QUEUE_ORDER.filter(
                  (status) => overview.queue.byStatus[status],
                ).map((status) => (
                  <span className={`chip status-${status.toLowerCase()}`} key={status}>
                    {status} {overview.queue.byStatus[status]}
                  </span>
                ))}
                {overview.queue.total === 0 ? (
                  <span className="muted">No jobs yet</span>
                ) : null}
              </div>
            </article>

            <article className="tile">
              <h3>Throughput ({jobs?.windowMinutes ?? WINDOW_MINUTES} min)</h3>
              <dl className="stats">
                <div>
                  <dt>Finished</dt>
                  <dd>{jobs?.terminalInWindow ?? 0}</dd>
                </div>
                <div>
                  <dt>Per minute</dt>
                  <dd>{jobs?.completionsPerMinute ?? 0}</dd>
                </div>
                <div>
                  <dt>Success rate</dt>
                  <dd className="healthy">
                    {jobs?.successRate === null || jobs === null
                      ? "-"
                      : percent(jobs.successRate)}
                  </dd>
                </div>
              </dl>
            </article>
          </div>

          <article className="tile wide">
            <div className="chart-heading">
              <h3>Recorded utilization</h3>
              <span className="mono" title="Saved worker snapshots draw this chart. History is pruned according to the configured retention period.">
                {history ? `${history.pointCount} chart points over ${history.windowMinutes} min · ` : ""}
                {overview.samples.stored} saved worker snapshots
              </span>
            </div>
            <Sparkline history={history} />
          </article>

          <article className="tile wide">
            <h3>Workers</h3>
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th scope="col">Worker</th>
                    <th scope="col">Status</th>
                    <th scope="col" title="Millicores: 1000m = 1 CPU core">CPU (m)</th>
                    <th scope="col">Memory</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Running</th>
                    <th scope="col">Completed</th>
                    <th scope="col">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.workers.map((worker) => (
                    <tr key={worker.workerId}>
                      <td>{worker.name}</td>
                      <td
                        className={
                          worker.status === "BUSY" ? "pending" : "healthy"
                        }
                      >
                        {worker.status}
                      </td>
                      <td>
                        {worker.cpuAllocatedMillicores}/
                        {worker.cpuCapacityMillicores}m
                        <small> ({percent(worker.cpuUtilization)})</small>
                      </td>
                      <td>
                        {worker.memoryAllocatedMiB}/{worker.memoryCapacityMiB} MiB
                        <small> ({percent(worker.memoryUtilization)})</small>
                      </td>
                      <td>{worker.reservedAllocations}</td>
                      <td>{worker.runningExecutions}</td>
                      <td>{worker.jobsCompleted}</td>
                      <td>{worker.jobsFailed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <div className="monitor-grid two">
            <article className="tile">
              <h3>Lifecycle timings</h3>
              <div className="table-scroll">
                <table className="grid">
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">n</th>
                      <th scope="col">avg</th>
                      <th scope="col">p95</th>
                      <th scope="col">max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(jobs?.timings ?? {}).map(
                      ([metric, stats]) => (
                        <tr key={metric}>
                          <td>{TIMING_LABELS[metric] ?? metric}</td>
                          <td>{stats.count}</td>
                          <td>{seconds(stats.averageSeconds)}</td>
                          <td>{seconds(stats.p95Seconds)}</td>
                          <td>{seconds(stats.maximumSeconds)}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="tile">
              <h3>Running now</h3>
              <div className="running-viewport">
                {overview.executions.running.length === 0 ? (
                  <div className="empty-state running-empty">
                    <Icon name="box" />
                    <p>No containers running.</p>
                  </div>
                ) : (
                  <ul className="runlist">
                    {overview.executions.running.map((execution) => (
                      <li key={execution.executionId}>
                        <strong>{execution.jobName}</strong>
                        <span className="muted">
                          {execution.workloadType} on {execution.workerName} ·{" "}
                          {execution.elapsedSeconds}s
                          {execution.containerId
                            ? ` · ${execution.containerId.slice(0, 12)}`
                            : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          </div>

          <p className="muted footnote">
            Refreshing every {REFRESH_SECONDS}s · last read{" "}
            {new Date(overview.capturedAt).toLocaleTimeString()}
            {overview.samples.latestAt
              ? ` · last sample ${new Date(overview.samples.latestAt).toLocaleTimeString()}`
              : ""}
          </p>
        </>
      ) : (
        <p className="muted">Loading metrics…</p>
      )}
    </section>
  );
}
