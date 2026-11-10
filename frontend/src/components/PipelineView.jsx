import { Icon } from "./Icon.jsx";

const STAGES = [
  { stage: "QUEUE", label: "Job queue", note: "Persisted in MySQL" },
  { stage: "SCHEDULER", label: "Scheduler", note: "Picks which job runs next" },
  { stage: "PLACEMENT", label: "Placement", note: "Picks which worker runs it" },
  { stage: "RESERVATION", label: "Reservation", note: "Transaction + row lock" },
  { stage: "EXECUTION", label: "Docker execution", note: "Container under limits" },
  { stage: "COMPLETED", label: "Completed", note: "Result stored, capacity freed" },
];

/** "1 failed, 1 interrupted, 20 cancelled" from the backend's status counts. */
export function endedEarlyText(statusCounts = {}) {
  return ["FAILED", "INTERRUPTED", "CANCELLED"]
    .filter((status) => (statusCounts[status] ?? 0) > 0)
    .map((status) => `${statusCounts[status]} ${status.toLowerCase()}`)
    .join(", ");
}

/**
 * The pipeline as a row of numbered stages.
 *
 * Counts come from the backend's derived stage for every job, so this reflects
 * database state rather than anything the UI tracked itself. A stage holding
 * jobs is underlined; the selected job's stage is filled.
 */
export function PipelineView({ stageCounts, statusCounts, selected, onShowEnded }) {
  const activeStage = selected?.stage ?? null;
  const ended = stageCounts.TERMINATED ?? 0;
  const breakdown = endedEarlyText(statusCounts);
  return (
    <section id="pipeline" className="section" aria-labelledby="pipeline-title">
      <header className="section-head">
        <h2 id="pipeline-title">Pipeline</h2>
        <p>
          {selected
            ? <>Tracing <strong className="mono">{selected.name}</strong>{selected.stage === "TERMINATED" ? " — ended early" : ""}</>
            : "Select a job in the queue to trace it through each stage"}
        </p>
      </header>
      <div className="card pipeline-card">
        <ol className="pipeline-stages">
          {STAGES.map((entry, index) => {
            const count = stageCounts[entry.stage] ?? 0;
            return (
              <li key={entry.stage}
                className={`pipeline-step${activeStage === entry.stage ? " is-active" : ""}${count > 0 ? " has-jobs" : ""}`}>
                <span className="pipeline-step-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="pipeline-step-label">{entry.label}</span>
                <span className="pipeline-step-count">{count}</span>
                <small>{entry.note}</small>
              </li>
            );
          })}
        </ol>
        {ended > 0 ? (
          <p className={`pipeline-ended${activeStage === "TERMINATED" ? " is-active" : ""}`}>
            <Icon name="info" />
            <span>{ended} job{ended === 1 ? "" : "s"} didn't finish{breakdown ? ` — ${breakdown}` : ""}</span>
            {onShowEnded ? (
              <button type="button" className="link" onClick={onShowEnded}>Show in queue ›</button>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
