/**
 * Every view opens the same way: the title with an optional status pill, one
 * line of context, and the view's actions on the right.
 */
export function PageHeader({ title, status = null, subtitle = null, actions = null }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <div className="page-title-row">
          <h1>{title}</h1>
          {status ? (
            <span className={`page-status is-${status.tone ?? "idle"}`} role="status">
              <span aria-hidden="true" />{status.label}
            </span>
          ) : null}
        </div>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
