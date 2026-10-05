import { CapacityGauge } from "./CapacityGauge.jsx";

/** Worker counters reflect capacity committed by transactional reservations. */
export function WorkerGrid({ workers, hostMemory, onSelectJob }) {
  return (
    <section className="panel worker-panel" aria-label="Workers">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Logical workers</p>
          <h2>Capacity and running containers</h2>
        </div>
      </header>
      <p className="hint worker-explanation">
        Workers are scheduling slots on the same computer. Rings show reserved
        limits, not actual RAM usage. Jobs run in Docker containers.
      </p>
      {hostMemory ? (
        <p className="host-memory mono">
          Backend host: {(hostMemory.totalMiB / 1024).toFixed(1)} GiB RAM,
          {" "}{(hostMemory.freeMiB / 1024).toFixed(1)} GiB free
          {" · "}Worker budget: {(hostMemory.workerBudgetMiB / 1024).toFixed(1)} GiB
        </p>
      ) : null}
      <div className="worker-grid">
        {workers.map((worker) => (
          <article key={worker.id} className="worker-card">
            <header>
              <strong className="mono">{worker.name}</strong>
              <span className={`badge badge-${worker.status.toLowerCase()}`}>
                {worker.status}
              </span>
            </header>
            <CapacityGauge cpu={worker.cpuUtilization} memory={worker.memoryUtilization}
              label={`${worker.name} capacity`} caption={worker.status === "IDLE" ? "idle" : "reserved"} />
            <dl className="capacity-legend">
              <div>
                <dt><span className="metric-dot cpu-dot" />CPU reserved</dt>
                <dd>{worker.cpuAllocatedMillicores} / {worker.cpuCapacityMillicores} m</dd>
              </div>
              <div>
                <dt><span className="metric-dot memory-dot" />Memory reserved</dt>
                <dd>{worker.memoryAllocatedMiB} / {worker.memoryCapacityMiB} MiB</dd>
              </div>
            </dl>
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
