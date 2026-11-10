import { Icon } from "./Icon.jsx";
import {
  STRATEGY_LABELS,
  STRATEGY_ORDER,
  keyTakeaway,
  strategyClass,
  strategyDescription,
  summaryRows,
} from "../scaling.chart.js";

const STATUS_TEXT = { PENDING: "Waiting", RUNNING: "Running", COMPLETED: "Completed", FAILED: "Failed", ABORTED: "Stopped" };

/** A run's status; a running run also says how far it has got. */
function RunStatus({ run, progress }) {
  const live = run.status === "RUNNING" && progress?.strategy === run.strategy;
  const text = live ? `Running · ${progress.finishedJobs}/${progress.totalJobs} jobs` : STATUS_TEXT[run.status] ?? run.status;
  return (
    <span className={`sc-run-status is-${run.status.toLowerCase()}`}>
      {run.status === "COMPLETED" ? <Icon name="check" /> : null}{text}
    </span>
  );
}

/**
 * The automatically worded result with the measured values behind it, then
 * each strategy: its status and how it decides.
 */
export function TakeawayCard({ comparison, runs, settings, progress }) {
  const takeaway = keyTakeaway(comparison);
  const ordered = STRATEGY_ORDER.map((strategy) => runs.find((run) => run.strategy === strategy)).filter(Boolean);
  return (
    <section className="card sc-takeaway" aria-labelledby="sc-takeaway-title">
      <p className="sc-eyebrow">Takeaway</p>
      <div role="status">
        <h2 id="sc-takeaway-title">{takeaway.title}</h2>
        <p>{takeaway.points.length ? takeaway.points.join(" ") : takeaway.detail}</p>
      </div>
      <ul className="sc-runs" aria-label="Strategies">
        {ordered.map((run) => (
          <li key={run.id} className={strategyClass(run.strategy)}>
            <div className="sc-run-head">
              <span className="sc-dot" aria-hidden="true" />
              <strong>{STRATEGY_LABELS[run.strategy]}</strong>
              <RunStatus run={run} progress={progress} />
            </div>
            <p>{strategyDescription(run.strategy, settings)}</p>
            {run.failureReason ? <p className="sc-run-note">{run.failureReason}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Better({ winner }) {
  if (winner === "ML" || winner === "REACTIVE") {
    return (
      <span className={`sc-better ${strategyClass(winner)}`}>
        <span className="sc-dot" aria-hidden="true" />{STRATEGY_LABELS[winner]}
      </span>
    );
  }
  return <span className="sc-better is-none">{winner === "TIE" ? "About the same" : "—"}</span>;
}

/** The winner's value is bold; the other is muted. A tie, or no verdict yet, leaves both plain. */
function valueClass(row, strategy) {
  if (row.winner === strategy) return "num mono is-best";
  if (row.winner === "ML" || row.winner === "REACTIVE") return "num mono is-worse";
  return "num mono";
}

/** Both strategies side by side on the measurements that matter, with the change and who did better. */
export function ResultsTable({ comparison, runs }) {
  const rows = summaryRows(comparison, runs);
  return (
    <section className="card sc-results" aria-labelledby="sc-results-title">
      <header className="card-head">
        <h2 id="sc-results-title">Results</h2>
        <p>Lower is better for every metric. Differences under 5% aren&apos;t called.</p>
      </header>
      <div className="table-scroll">
        <table className="data-table sc-results-table">
          <caption className="sr-only">
            Reactive and ML-assisted results; the difference is ML-assisted relative to Reactive
          </caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" className="num"><span className="sc-dot strategy-reactive" aria-hidden="true" />Reactive</th>
              <th scope="col" className="num"><span className="sc-dot strategy-ml" aria-hidden="true" />ML-assisted</th>
              <th scope="col" className="num">ML vs Reactive</th>
              <th scope="col">Better</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}{row.unitNote ? <small> ({row.unitNote})</small> : null}</th>
                <td className={valueClass(row, "REACTIVE")}>{row.reactiveText}</td>
                <td className={valueClass(row, "ML")}>{row.mlText}</td>
                <td className="num mono">{row.difference}</td>
                <td><Better winner={row.winner} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
