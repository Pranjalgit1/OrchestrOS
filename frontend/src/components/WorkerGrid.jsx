/** Share of capacity as a 0–100 bar width; capacity zero has no bar. */
export function barWidth(used, capacity) {
  if (!capacity) return 0;
  return Math.max(0, Math.min(100, (used / capacity) * 100));
}

function ReservedBar({ used, capacity, unit, kind }) {
  return (
    <div className={`res-bar res-${kind}`}>
      <span className="res-track" aria-hidden="true"><span style={{ width: `${barWidth(used, capacity)}%` }} /></span>
      <span className="res-value mono">{used} / {capacity}{unit}</span>
    </div>
  );
}

/**
 * Workers as a table. Counters are capacity committed by transactional
 * reservations, not live RAM use. Each row carries the worker's running
 * containers and its finished attempts, so there is one place to read a worker.
 */
export function WorkerGrid({ workers, onSelectJob, title = "Workers", settingsHref = null }) {
  const totalCpu = workers.reduce((sum, worker) => sum + worker.cpuCapacityMillicores, 0);
  const totalMemory = workers.reduce((sum, worker) => sum + worker.memoryCapacityMiB, 0);
  return (
    <section className="card workers-card" aria-label={title}>
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          <p>Bars show reserved limits, not live RAM usage</p>
        </div>
        <ul className="res-legend" aria-label="Bar colours">
          <li className="res-cpu"><span aria-hidden="true" />CPU</li>
          <li className="res-memory"><span aria-hidden="true" />Memory</li>
        </ul>
      </header>
      <div className="table-scroll">
        <table className="data-table worker-table">
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col" title="Millicores: 1000m = 1 CPU core">CPU reserved</th>
              <th scope="col">Memory reserved</th>
              <th scope="col" className="num">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {workers.length === 0 ? (
              <tr><td colSpan={4} className="table-empty">No workers in service.</td></tr>
            ) : workers.map((worker) => (
              <tr key={worker.id}>
                <th scope="row">
                  <span className="worker-name mono">{worker.name}</span>
                  {worker.autoscaled ? <span className="tag" title="Added by the autoscaler">auto</span> : null}
                  <span className="worker-state">
                    <span className={`state-dot state-${worker.status.toLowerCase()}`} aria-hidden="true" />
                    {worker.status.toLowerCase()} ·{" "}
                    {worker.runningJobs.length === 0 ? "no container" : worker.runningJobs.map((job, index) => (
                      <span key={job.jobId}>
                        {index ? ", " : ""}
                        <button type="button" className="link mono" onClick={() => onSelectJob(job.jobId)}
                          title={job.containerShortId ? `Container ${job.containerShortId}` : undefined}>
                          {job.jobName}
                        </button>
                      </span>
                    ))}
                  </span>
                </th>
                <td><ReservedBar used={worker.cpuAllocatedMillicores} capacity={worker.cpuCapacityMillicores} unit="m" kind="cpu" /></td>
                <td><ReservedBar used={worker.memoryAllocatedMiB} capacity={worker.memoryCapacityMiB} unit=" MiB" kind="memory" /></td>
                <td className="num mono" title="Finished container attempts on this worker">
                  <strong>{worker.jobsCompleted ?? 0}</strong> ok · {worker.jobsFailed ?? 0} fail
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="card-foot">
        <span>Total capacity <span className="mono">{totalCpu}m · {totalMemory} MiB</span></span>
        {settingsHref ? <a href={settingsHref}>Autoscaling settings</a> : null}
      </footer>
    </section>
  );
}
