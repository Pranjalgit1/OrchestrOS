import { CapacityGauge } from "./CapacityGauge.jsx";

/**
 * Worker counters reflect capacity committed by transactional reservations.
 * Each card also carries the worker's finished attempts, so there is one place
 * to read a worker rather than a card here and a table elsewhere.
 */
export function WorkerGrid({ workers, onSelectJob, title = "Workers" }) {
  return (
    <section className="panel worker-panel" aria-label="Workers">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
        </div>
      </header>
      <p className="hint worker-explanation">
        Rings show reserved limits, not the actual RAM usage
      </p>
      <div className="worker-grid">
        {workers.map((worker) => (
          <article key={worker.id} className="worker-card">
            <header>
              <strong className="mono">{worker.name}</strong>
              {worker.autoscaled ? (
                <span className="badge badge-auto" title="Added by the autoscaler">auto</span>
              ) : null}
              <span className={`badge badge-${worker.status.toLowerCase()}`}>
                {worker.status}
              </span>
            </header>
            <CapacityGauge cpu={worker.cpuUtilization} memory={worker.memoryUtilization}
              label={`${worker.name} capacity`} caption={worker.status === "IDLE" ? "idle" : "reserved"} />
            <dl className="capacity-legend">
              <div>
                <dt title="Millicores: 1000m = 1 CPU core"><span className="metric-dot cpu-dot" />CPU reserved</dt>
                <dd>{worker.cpuAllocatedMillicores} / {worker.cpuCapacityMillicores} m</dd>
              </div>
              <div>
                <dt><span className="metric-dot memory-dot" />Memory reserved</dt>
                <dd>{worker.memoryAllocatedMiB} / {worker.memoryCapacityMiB} MiB</dd>
              </div>
            </dl>
            <p className="worker-outcomes" title="Finished container attempts on this worker">
              {worker.jobsCompleted ?? 0} completed · {worker.jobsFailed ?? 0} failed
            </p>
            <div className="worker-running">
              {worker.runningJobs.length === 0 ? (
                <small className="muted">No container running</small>
              ) : worker.runningJobs.map((job) => (
                <button key={job.jobId} type="button" className="chip chip-live"
                  onClick={() => onSelectJob(job.jobId)}>
                  {job.jobName}{job.containerShortId ? ` · ${job.containerShortId}` : ""}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
