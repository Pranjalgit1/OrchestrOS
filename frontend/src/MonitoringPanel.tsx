import { useCallback, useEffect, useRef, useState } from "react";

import {
  captureSample,
  fetchJobMetrics,
  fetchOverview,
  fetchSampleHistory,
  type JobMetrics,
  type MonitoringOverview,
  type SampleHistory,
} from "./api";

const REFRESH_SECONDS = 5;
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
] as const;

const TIMING_LABELS: Record<string, string> = {
  queueWait: "Queue wait",
  placementDelay: "Placement delay",
  startDelay: "Start delay",
  execution: "Execution",
  turnaround: "Total turnaround",
};

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function seconds(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return `${Math.round(value * 1000)}ms`;
  return `${Math.round(value * 100) / 100}s`;
}

function Bar({ label, used, capacity, utilization, unit }: {
  label: string;
  used: number;
  capacity: number;
  utilization: number;
  unit: string;
}) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <strong>{percent(utilization)}</strong>
      </div>
      <div className="meter-track">
        <div
          className="meter-fill"
          style={{ width: `${Math.min(100, utilization * 100)}%` }}
          role="progressbar"
          aria-label={`${label} utilization`}
          aria-valuenow={Math.round(utilization * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <small>
        {used.toLocaleString()} / {capacity.toLocaleString()} {unit} reserved
      </small>
    </div>
  );
}

/** Inline sparkline of recorded cluster utilization, drawn without a chart library. */
function Sparkline({ history }: { history: SampleHistory | null }) {
  if (!history || history.points.length < 2) {
    return (
      <p className="muted">
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

  const line = (pick: (index: number) => number): string =>
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
        <path d={cpuPath} className="spark-cpu" />
        <path d={memoryPath} className="spark-memory" />
      </svg>
      <figcaption>
        <span className="key key-cpu">CPU</span>
        <span className="key key-memory">Memory</span>
        <span className="muted">
          {points.length} samples over {history.windowMinutes} min
        </span>
      </figcaption>
    </figure>
  );
}

export function MonitoringPanel() {
  const [overview, setOverview] = useState<MonitoringOverview | null>(null);
  const [jobs, setJobs] = useState<JobMetrics | null>(null);
  const [history, setHistory] = useState<SampleHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [nextOverview, nextJobs, nextHistory] = await Promise.all([
        fetchOverview(signal),
        fetchJobMetrics(WINDOW_MINUTES, signal),
        fetchSampleHistory(WINDOW_MINUTES, signal),
      ]);
      if (!mounted.current) return;
      setOverview(nextOverview);
      setJobs(nextJobs);
      setHistory(nextHistory);
      setError(null);
    } catch (reason) {
      if (signal?.aborted || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to load metrics");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);

    const timer = setInterval(() => {
      void load(controller.signal);
    }, REFRESH_SECONDS * 1000);

    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const onCapture = async () => {
    setBusy(true);
    try {
      await captureSample();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sample capture failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="monitor" aria-label="Live monitoring">
      <header className="monitor-head">
        <div>
          <p className="eyebrow">Live monitoring</p>
          <h2>Cluster state</h2>
        </div>
        <div className="monitor-actions">
          <button type="button" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
          <button type="button" onClick={() => void onCapture()} disabled={busy}>
            {busy ? "Capturing…" : "Capture sample"}
          </button>
        </div>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      {overview ? (
        <>
          <div className="monitor-grid">
            <article className="tile">
              <Bar
                label="CPU"
                used={overview.cluster.cpuAllocatedMillicores}
                capacity={overview.cluster.cpuCapacityMillicores}
                utilization={overview.cluster.cpuUtilization}
                unit="millicores"
              />
              <Bar
                label="Memory"
                used={overview.cluster.memoryAllocatedMiB}
                capacity={overview.cluster.memoryCapacityMiB}
                utilization={overview.cluster.memoryUtilization}
                unit="MiB"
              />
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
                {QUEUE_ORDER.filter((status) => overview.queue.byStatus[status]).map((status) => (
                  <span className="chip" key={status}>
                    {status} {overview.queue.byStatus[status]}
                  </span>
                ))}
                {overview.queue.total === 0 ? <span className="muted">No jobs yet</span> : null}
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
                  <dd>{jobs?.successRate === null || jobs === null ? "—" : percent(jobs.successRate)}</dd>
                </div>
                <div>
                  <dt>Samples stored</dt>
                  <dd>{overview.samples.stored}</dd>
                </div>
              </dl>
            </article>
          </div>

          <article className="tile wide">
            <h3>Recorded utilization</h3>
            <Sparkline history={history} />
          </article>

          <article className="tile wide">
            <h3>Workers</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Worker</th>
                  <th scope="col">Status</th>
                  <th scope="col">CPU</th>
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
                    <td className={worker.status === "BUSY" ? "pending" : "healthy"}>
                      {worker.status}
                    </td>
                    <td>
                      {worker.cpuAllocatedMillicores}/{worker.cpuCapacityMillicores}m
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
          </article>

          <div className="monitor-grid two">
            <article className="tile">
              <h3>Lifecycle timings</h3>
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
                  {Object.entries(jobs?.timings ?? {}).map(([metric, stats]) => (
                    <tr key={metric}>
                      <td>{TIMING_LABELS[metric] ?? metric}</td>
                      <td>{stats.count}</td>
                      <td>{seconds(stats.averageSeconds)}</td>
                      <td>{seconds(stats.p95Seconds)}</td>
                      <td>{seconds(stats.maximumSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>

            <article className="tile">
              <h3>Running now</h3>
              {overview.executions.running.length === 0 ? (
                <p className="muted">No containers running.</p>
              ) : (
                <ul className="runlist">
                  {overview.executions.running.map((execution) => (
                    <li key={execution.executionId}>
                      <strong>{execution.jobName}</strong>
                      <span className="muted">
                        {execution.workloadType} on {execution.workerName} · {execution.elapsedSeconds}s
                        {execution.containerId ? ` · ${execution.containerId.slice(0, 12)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
