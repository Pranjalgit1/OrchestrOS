import type { JobStateView } from "../api";

const STATUS_FILTERS = [
  "ALL",
  "QUEUED",
  "SCHEDULED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface JobQueueProps {
  jobs: JobStateView[];
  selectedJobId: string | null;
  filter: StatusFilter;
  onFilterChange: (next: StatusFilter) => void;
  onSelectJob: (jobId: string) => void;
}

function containerLabel(job: JobStateView): string {
  if (!job.execution) return "—";
  const status = job.execution.status;
  const short = job.execution.containerShortId;
  if (status === "RUNNING") {
    return `running ${short ?? ""} · ${job.execution.elapsedSeconds ?? 0}s`;
  }
  if (status === "COMPLETED") {
    return `exit ${job.execution.exitCode ?? "?"} · ${job.execution.elapsedSeconds ?? 0}s`;
  }
  return `${status.toLowerCase()} · exit ${job.execution.exitCode ?? "?"}`;
}

export function JobQueue({
  jobs,
  selectedJobId,
  filter,
  onFilterChange,
  onSelectJob,
}: JobQueueProps) {
  const visible = filter === "ALL" ? jobs : jobs.filter((job) => job.status === filter);

  return (
    <section className="panel" aria-label="Job queue">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Live job queue</p>
          <h2>{jobs.length} job(s) in the database</h2>
        </div>
        <div className="filters">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`chip${filter === option ? " chip-on" : ""}`}
              onClick={() => onFilterChange(option)}
            >
              {option === "ALL" ? "All" : option}
            </button>
          ))}
        </div>
      </header>

      {visible.length === 0 ? (
        <p className="muted">
          {jobs.length === 0
            ? "No jobs yet. Generate a workload to fill the queue."
            : "No jobs match this filter."}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Type</th>
                <th scope="col">CPU</th>
                <th scope="col">Memory</th>
                <th scope="col">Prio</th>
                <th scope="col">Est.</th>
                <th scope="col">Status</th>
                <th scope="col">Worker</th>
                <th scope="col">Container</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((job) => (
                <tr
                  key={job.id}
                  className={`job-row${selectedJobId === job.id ? " is-selected" : ""}`}
                  onClick={() => onSelectJob(job.id)}
                >
                  <td>
                    <button type="button" className="link">
                      {job.name}
                    </button>
                    {job.status === "QUEUED" && job.secondsUntilEligible > 0 ? (
                      <small className="muted"> · eligible in {job.secondsUntilEligible}s</small>
                    ) : null}
                  </td>
                  <td>{job.workloadType.replace(/_/g, " ").toLowerCase()}</td>
                  <td>{job.cpuRequiredMillicores}m</td>
                  <td>{job.memoryRequiredMiB} MiB</td>
                  <td>{job.priority}</td>
                  <td>{job.estimatedDurationSeconds}s</td>
                  <td>
                    <span className={`status status-${job.status.toLowerCase()}`}>
                      {job.status}
                    </span>
                  </td>
                  <td>{job.assignedWorkerName ?? "—"}</td>
                  <td className="mono">{containerLabel(job)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
