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
import { reservationChart } from "./reservation.chart.js";

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
function sampleTime(value) {
  return new Date(value).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
/** Recorded reservations; this chart does not measure host CPU or RAM usage. */
function Sparkline({ history, status }) {
  if (!history || history.points.length === 0) {
    return (
      <p className="muted spark-placeholder">
        {status?.error
          ? "Recorded samples unavailable. Use Refresh now in Monitoring tools to retry."
          : history
            ? "No recorded samples in this window. Use Save snapshot in Monitoring tools to record one now."
            : "Loading recorded samples…"}
      </p>
    );
  }
  const points = history.points;
  const width = 600;
  const height = 90;
  const chart = reservationChart(points, width, height);
  return (
    <figure className="spark">
      <div className="spark-plot">
        <div className="spark-scale" aria-hidden="true">
          {[100, 75, 50, 25, 0].map((value) => <span key={value}>{value}%</span>)}
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Recorded CPU and memory reservations, from ${sampleTime(chart.start)} to ${sampleTime(chart.end)}, as percentages of worker capacity. Sample values are listed below.`}
        >
          <g className="spark-grid">
            {[0, 22.5, 45, 67.5, 90].map((y) => <line key={y} x1="0" x2={width} y1={y} y2={y} />)}
          </g>
          <path d={chart.cpuPath} className="spark-cpu" />
          <path d={chart.memoryPath} className="spark-memory" />
          {points.length === 1 ? (
            <>
              <circle cx={chart.coordinates[0].x} cy={chart.coordinates[0].cpuY} r="2" className="spark-point-cpu" />
              <circle cx={chart.coordinates[0].x} cy={chart.coordinates[0].memoryY} r="2" className="spark-point-memory" />
            </>
          ) : null}
        </svg>
      </div>
      <div className="spark-times" aria-hidden="true">
        <span>{sampleTime(chart.start)}</span><span>{sampleTime(chart.end)}</span>
      </div>
      <figcaption>
        <span className="key key-cpu">CPU</span>
        <span className="key key-memory">Memory</span>
      </figcaption>
      <p className="hint">Lines connect recorded samples. Time between samples is unmeasured. Values show reserved limits, not actual host usage.</p>
      {status?.error ? (
        <p className="hint">History refresh failed. Showing the last recorded samples; use Refresh now to retry.</p>
      ) : null}
      <details className="sample-values">
        <summary>Sample values</summary>
        <div className="table-scroll">
          <table className="grid">
            <caption className="sr-only">Recorded reservations as percentages of worker capacity</caption>
            <thead><tr><th scope="col">Captured at</th><th scope="col">CPU reserved (%)</th><th scope="col">Memory reserved (%)</th></tr></thead>
            <tbody>{points.map((point) => (
              <tr key={point.capturedAt}>
                <td><time dateTime={point.capturedAt}>{sampleTime(point.capturedAt)}</time></td>
                <td>{percent(point.cpuUtilization)}</td><td>{percent(point.memoryUtilization)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
export function MonitoringPanel() {
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [readStatus, setReadStatus] = useState({});
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
      onStatus: (key, status) => setReadStatus((current) => ({ ...current, [key]: status })),
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
    error={error} readStatus={readStatus} busy={busy} onRefresh={() => poller.current?.refresh()} onCapture={() => void onCapture()} />;
}

/** Display metrics independently of polling so every loading/data state can be reviewed. */
export function MonitoringView({ overview, jobs, history, error, readStatus = {}, busy, onRefresh, onCapture }) {
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
          <div className="monitor-grid quad">
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
                  <dd>{jobs?.terminalInWindow ?? "—"}</dd>
                </div>
                <div>
                  <dt>Per minute</dt>
                  <dd>{jobs?.completionsPerMinute ?? "—"}</dd>
                </div>
                <div>
                  <dt>Success rate</dt>
                  <dd className="healthy">
                    {jobs?.successRate == null
                      ? "—"
                      : percent(jobs.successRate)}
                  </dd>
                </div>
              </dl>
              <p className="hint" role="status">
                {readStatus.jobs?.error
                  ? jobs
                    ? "Job metrics refresh failed. Showing the last successful read; use Refresh now to retry."
                    : "Job metrics unavailable. Use Refresh now in Monitoring tools to retry."
                  : !jobs ? "Loading job metrics…" : null}
                {readStatus.jobs?.lastSuccessAt
                  ? ` Last read ${new Date(readStatus.jobs.lastSuccessAt).toLocaleTimeString()}.`
                  : ""}
              </p>
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

          <article className="tile wide">
            <div className="chart-heading">
              <h3>Recorded CPU and memory reservations</h3>
              <span className="mono" title="Saved worker snapshots draw this chart. History is pruned according to the configured retention period.">
                {history ? `${history.pointCount} chart points in the last ${history.windowMinutes} min · ` : ""}
                {overview.samples.stored} saved worker snapshots
              </span>
            </div>
            <Sparkline history={history} status={readStatus.history} />
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

          <article className="tile timings-tile">
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
