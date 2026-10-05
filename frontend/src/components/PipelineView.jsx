import { Icon } from "./Icon.jsx";

const STAGES = [
  { stage: "QUEUE", label: "Job Queue", note: "Persisted in MySQL" },
  { stage: "SCHEDULER", label: "Scheduler", note: "Which job runs next" },
  { stage: "PLACEMENT", label: "Placement", note: "Which worker runs it" },
  {
    stage: "RESERVATION",
    label: "Reservation",
    note: "Transaction + row lock",
  },
  {
    stage: "EXECUTION",
    label: "Docker Execution",
    note: "Container under limits",
  },
  {
    stage: "COMPLETED",
    label: "Completed",
    note: "Result stored, capacity freed",
  },
];
/**
 * The pipeline as a row of stages.
 *
 * Counts come from the backend's derived stage for every job, so this reflects
 * database state rather than anything the UI tracked itself.
 */
export function PipelineView({ stageCounts, selected }) {
  const activeStage = selected?.stage ?? null;
  return (
    <section id="pipeline" className="panel pipeline-panel" aria-label="Pipeline">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Pipeline</p>
          <h2>Where every job is</h2>
        </div>
        {selected ? (
          <p className="hint hint-inline">
            Highlighting <strong>{selected.name}</strong>
            {selected.stage === "TERMINATED" ? " - ended early" : ""}
          </p>
        ) : (
          <p className="hint hint-inline">Select a job below to trace it.</p>
        )}
      </header>

      <ol className="pipeline">
        {STAGES.map((entry, index) => {
          const count = stageCounts[entry.stage] ?? 0;
          const isActive = activeStage === entry.stage;
          return (
            <li
              key={entry.stage}
              className={`pipeline-stage${isActive ? " is-active" : ""}${count > 0 ? " has-jobs" : ""}`}
            >
              <span className="pipeline-index">{index + 1}</span>
              <span className="pipeline-label">{entry.label}</span>
              <span className="pipeline-count">{count}</span>
              <small>{entry.note}</small>
            </li>
          );
        })}
      </ol>

      {stageCounts.TERMINATED > 0 ? (
        <p className="pipeline-warning">
          <Icon name="info" />{stageCounts.TERMINATED} job(s) ended as failed, interrupted, or
          cancelled.
        </p>
      ) : null}
    </section>
  );
}
