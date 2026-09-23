export interface ActivityEntry {
  id: number;
  at: string;
  kind: "info" | "stage" | "error";
  label: string;
  detail: string;
}

export interface ActivityLogProps {
  entries: ActivityEntry[];
  onClear: () => void;
}

/**
 * A running narration of what the backend reported for each action.
 *
 * Every line is text the backend returned, so the log doubles as the audit
 * trail for a demonstration.
 */
export function ActivityLog({ entries, onClear }: ActivityLogProps) {
  return (
    <section className="panel" aria-label="Activity log">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Activity</p>
          <h2>What the backend reported</h2>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClear}>
          Clear
        </button>
      </header>

      {entries.length === 0 ? (
        <p className="muted">No actions yet.</p>
      ) : (
        <ul className="log">
          {entries.map((entry) => (
            <li key={entry.id} className={`log-${entry.kind}`}>
              <span className="log-time mono">{entry.at}</span>
              <span className="log-label">{entry.label}</span>
              <span className="log-detail">{entry.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
