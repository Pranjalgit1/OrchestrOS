import type { WorkerStateView } from "../api";

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export interface WorkerGridProps {
  workers: WorkerStateView[];
  onSelectJob: (jobId: string) => void;
}

/**
 * Logical workers with their committed capacity.
 *
 * The numbers are the workers' own counters, which only transactional
 * reservation and release ever change.
 */
export function WorkerGrid({ workers, onSelectJob }: WorkerGridProps) {
  return (
    <section className="panel" aria-label="Workers">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Logical workers</p>
          <h2>Capacity and running containers</h2>
        </div>
      </header>

      <div className="worker-grid">
        {workers.map((worker) => (
          <article key={worker.id} className="worker-card">
            <header>
              <strong>{worker.name}</strong>
              <span className={`badge badge-${worker.status.toLowerCase()}`}>{worker.status}</span>
            </header>

            <div className="worker-meter">
              <div className="meter-head">
                <span>CPU</span>
                <strong>{percent(worker.cpuUtilization)}</strong>
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, worker.cpuUtilization * 100)}%` }}
                />
              </div>
              <small>
                {worker.cpuAllocatedMillicores} / {worker.cpuCapacityMillicores} m
              </small>
            </div>

            <div className="worker-meter">
              <div className="meter-head">
                <span>Memory</span>
                <strong>{percent(worker.memoryUtilization)}</strong>
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, worker.memoryUtilization * 100)}%` }}
                />
              </div>
              <small>
                {worker.memoryAllocatedMiB} / {worker.memoryCapacityMiB} MiB
              </small>
            </div>

            <div className="worker-running">
              {worker.runningJobs.length === 0 ? (
                <small className="muted">No container running</small>
              ) : (
                worker.runningJobs.map((job) => (
                  <button
                    key={job.jobId}
                    type="button"
                    className="chip chip-live"
                    onClick={() => onSelectJob(job.jobId)}
                  >
                    {job.jobName}
                    {job.containerShortId ? ` · ${job.containerShortId}` : ""}
                  </button>
                ))
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
