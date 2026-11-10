/**
 * A running narration of what the backend reported for each action.
 *
 * Every line is text the backend returned, so the log doubles as the audit
 * trail for a demonstration.
 */
export function ActivityLog({ entries, onClear }) {
  return (
    <section className="card activity-card" aria-label="Activity">
      <header className="card-head">
        <div>
          <h2>Activity</h2>
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClear} disabled={entries.length === 0}>
          Clear
        </button>
      </header>
      <div className="activity-list">
        {entries.length === 0 ? (
          <p className="activity-empty">No actions yet. Run the orchestrator or add a workload.</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} className={`activity-${entry.kind}`}>
                <time className="mono">{entry.at}</time>
                <span>
                  <strong>{entry.label}</strong>
                  {entry.detail ? <> — {entry.detail}</> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
