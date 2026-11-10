import { useState } from "react";
import { JOB_STATUSES, jobStatusLabel, selectQueueJobs, jobAge } from "../job-queue.view.js";
import { Icon } from "./Icon.jsx";

const COLUMNS = [
  ["name", "Job"], ["worker", "Worker"], ["status", "Status"], ["age", "Age"],
  ["cpuRequiredMillicores", "CPU request"], ["memoryRequiredMiB", "Memory request"],
  ["priority", "Prio", "num"], ["estimatedDurationSeconds", "Est.", "num"],
];
export const SORT_OPTIONS = [
  ["updated", "desc", "Latest update"],
  ["age", "asc", "Newest first"],
  ["priority", "desc", "Highest priority"],
  ["estimatedDurationSeconds", "asc", "Shortest estimate"],
  ["cpuRequiredMillicores", "desc", "Largest CPU request"],
  ["memoryRequiredMiB", "desc", "Largest memory request"],
  ["name", "asc", "Name"],
];

/** What the container did, from the execution the backend recorded. */
export function resultLabel(job) {
  if (!job.execution) return job.status === "QUEUED" || job.status === "SCHEDULED" ? "waiting" : "not started";
  const { status, containerShortId, elapsedSeconds, exitCode } = job.execution;
  if (status === "RUNNING") return `${containerShortId ?? "running"} · ${elapsedSeconds ?? 0}s`;
  if (status === "COMPLETED") return `exit ${exitCode ?? "?"} · ${elapsedSeconds ?? 0}s`;
  return `${status.toLowerCase()} · exit ${exitCode ?? "?"}`;
}

function ResourceRequest({ value, capacity, unit, kind }) {
  const share = capacity > 0 ? Math.max(0, Math.min(100, (value / capacity) * 100)) : null;
  return (
    <div className={`res-bar res-${kind} res-compact`}>
      {share !== null ? (
        <span className="res-track" aria-hidden="true" title={`${Math.round(share)}% of the assigned worker's capacity`}>
          <span style={{ width: `${share}%` }} />
        </span>
      ) : <span className="res-track is-empty" aria-hidden="true" title="Not assigned to a worker" />}
      <span className="res-value mono">{value}{unit}</span>
      {share !== null ? <span className="sr-only"> of {capacity}{unit} on the assigned worker</span> : null}
    </div>
  );
}

export function JobQueue({ jobs, totalJobs = jobs.length, workers = [], capturedAt, selectedJobId, filter, onFilterChange, onSelectJob }) {
  const [query, setQuery] = useState("");
  const [worker, setWorker] = useState("ALL");
  const [sort, setSort] = useState({ key: "updated", direction: "desc" });
  const visible = selectQueueJobs(jobs, { filter, query, worker, sort });
  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, jobs.filter((job) => job.status === status).length]));
  const workerById = new Map(workers.map((entry) => [entry.id, entry]));
  const now = capturedAt ? Date.parse(capturedAt) : Date.now();
  const hasFilters = filter !== "ALL" || query !== "" || worker !== "ALL";
  const resetFilters = () => { setQuery(""); setWorker("ALL"); onFilterChange("ALL"); };
  const sortBy = (key) => setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  const sortValue = `${sort.key}:${sort.direction}`;

  return (
    <section id="job-queue" className="card queue-card" aria-label="Job queue">
      <header className="card-head">
        <h2>Job queue <span className="count mono">{totalJobs}</span></h2>
        <label className="queue-sort-select" htmlFor="queue-sort">
          <span>Sort</span>
          <select id="queue-sort" value={sortValue}
            onChange={(event) => { const [key, direction] = event.target.value.split(":"); setSort({ key, direction }); }}>
            {SORT_OPTIONS.map(([key, direction, label]) => <option key={key} value={`${key}:${direction}`}>{label}</option>)}
            {SORT_OPTIONS.some(([key, direction]) => `${key}:${direction}` === sortValue) ? null
              : <option value={sortValue}>By column</option>}
          </select>
        </label>
      </header>

      <div className="queue-tools">
        <label className="queue-find">
          <span className="sr-only">Search jobs</span>
          <Icon name="search" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, type, worker or container" />
        </label>
        <label className="sr-only" htmlFor="queue-worker">Worker</label>
        <select id="queue-worker" className="queue-worker" value={worker} onChange={(event) => setWorker(event.target.value)}>
          <option value="ALL">All workers</option>
          <option value="UNASSIGNED">Unassigned</option>
          {workers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          {worker !== "ALL" && worker !== "UNASSIGNED" && !workerById.has(worker) ? <option value={worker}>Unavailable worker</option> : null}
        </select>
      </div>

      <div className="queue-tabs" role="group" aria-label="Filter jobs by status">
        {["ALL", ...JOB_STATUSES].map((option) => (
          <button key={option} type="button" className={filter === option ? "is-on" : undefined}
            aria-pressed={filter === option} onClick={() => onFilterChange(option)}>
            {option === "ALL" ? "All" : jobStatusLabel(option)}
            <span className="mono">{option === "ALL" ? jobs.length : counts[option]}</span>
          </button>
        ))}
        {filter === "ENDED" ? (
          <button type="button" className="is-on" aria-pressed="true" onClick={() => onFilterChange("ALL")}>
            Ended early <span className="mono">{counts.FAILED + counts.INTERRUPTED + counts.CANCELLED}</span> ×
          </button>
        ) : null}
        {hasFilters ? <button type="button" className="link queue-clear" onClick={resetFilters}>Clear filters</button> : null}
      </div>

      {visible.length === 0 ? (
        <div className="table-empty">
          {jobs.length === 0 ? "No jobs yet. Add a workload to fill the queue." : "No jobs match these filters."}
        </div>
      ) : (
        <div className="table-scroll queue-scroll" role="region" aria-label="Job queue table" tabIndex={0}>
          <table className="data-table queue-table">
            <thead><tr>
              {COLUMNS.map(([key, label, align]) => (
                <th key={key} scope="col" className={align}
                  title={key === "cpuRequiredMillicores" ? "Millicores: 1000m = 1 CPU core" : undefined}
                  aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="th-sort" onClick={() => sortBy(key)}>
                    {label}{sort.key === key ? <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span> : null}
                  </button>
                </th>
              ))}
              <th scope="col">Result</th>
            </tr></thead>
            <tbody>{visible.map((job) => {
              const assignedWorker = workerById.get(job.assignedWorkerId);
              return (
                <tr key={job.id} className={selectedJobId === job.id ? "is-selected" : undefined} onClick={() => onSelectJob(job.id)}>
                  <td className="queue-job">
                    <button type="button" className="link mono" aria-pressed={selectedJobId === job.id}>{job.name}</button>
                    <small>{job.workloadType.replace(/_/g, " ").toLowerCase()}
                      {job.status === "QUEUED" && job.secondsUntilEligible > 0 ? ` · eligible in ${job.secondsUntilEligible}s` : ""}
                    </small>
                  </td>
                  <td className="mono">{job.assignedWorkerName ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className="job-status">
                      <span className={`state-dot state-${job.status.toLowerCase()}`} aria-hidden="true" />{jobStatusLabel(job.status)}
                    </span>
                  </td>
                  <td className="mono">{job.createdAt ? <time dateTime={job.createdAt} title={`Created ${new Date(job.createdAt).toLocaleString()}`}>{jobAge(job.createdAt, now)}</time> : "—"}</td>
                  <td><ResourceRequest value={job.cpuRequiredMillicores} capacity={assignedWorker?.cpuCapacityMillicores} unit="m" kind="cpu" /></td>
                  <td><ResourceRequest value={job.memoryRequiredMiB} capacity={assignedWorker?.memoryCapacityMiB} unit=" MiB" kind="memory" /></td>
                  <td className="num mono">{job.priority}</td>
                  <td className="num mono">{job.estimatedDurationSeconds}s</td>
                  <td className="mono queue-result">{resultLabel(job)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      <footer className="card-foot">
        <span>Requests shown as share of the assigned worker's capacity. Age is time since creation.</span>
        <span className="mono">{visible.length} of {jobs.length} loaded{totalJobs > jobs.length ? ` · ${totalJobs} total` : ""}</span>
      </footer>
    </section>
  );
}
