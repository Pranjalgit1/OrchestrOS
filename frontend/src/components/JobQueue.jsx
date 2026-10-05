const STATUS_FILTERS = [
  "ALL",
  "QUEUED",
  "SCHEDULED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
];
function containerLabel(job) {
  if (!job.execution) return "-";
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
}) {
  const visible =
    filter === "ALL" ? jobs : jobs.filter((job) => job.status === filter);
  return (
    <section id="job-queue" className="panel queue-panel" aria-label="Job queue">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Live job queue</p>
          <h2>{jobs.length} job(s) in the database</h2>
        </div>
      </header>
      <div className="filters" aria-label="Filter jobs by status">
        {STATUS_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            className={`chip${filter === option ? " chip-on" : ""}`}
            aria-pressed={filter === option}
            onClick={() => onFilterChange(option)}
          >
            {option === "ALL" ? "All" : option}
          </button>
        ))}
      </div>

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
                      <small className="muted">
                        {" "}
                        · eligible in {job.secondsUntilEligible}s
                      </small>
                    ) : null}
                  </td>
                  <td>{job.workloadType.replace(/_/g, " ").toLowerCase()}</td>
                  <td>{job.cpuRequiredMillicores}m</td>
                  <td>{job.memoryRequiredMiB} MiB</td>
                  <td>{job.priority}</td>
                  <td>{job.estimatedDurationSeconds}s</td>
                  <td>
                    <span
                      className={`status status-${job.status.toLowerCase()}`}
                    >
                      {job.status}
                    </span>
                  </td>
                  <td>{job.assignedWorkerName ?? "-"}</td>
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
