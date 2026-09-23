import type { JobStateView, PlacementStrategy } from "../api";

export interface JobDetailProps {
  job: JobStateView | null;
  strategy: PlacementStrategy;
  busy: string | null;
  onPlace: (jobId: string) => void;
  onReserve: (jobId: string) => void;
  onExecute: (jobId: string) => void;
  onRelease: (jobId: string) => void;
  onCancel: (jobId: string) => void;
}

/**
 * What happened to one job, and the per-stage controls for demonstrating the
 * pipeline one call at a time. Every value shown is reported by the backend.
 */
export function JobDetail(props: JobDetailProps) {
  const { job, busy } = props;

  if (!job) {
    return (
      <section className="panel" aria-label="Job detail">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Job detail</p>
            <h2>Nothing selected</h2>
          </div>
        </header>
        <p className="muted">Pick a job from the queue to see exactly what happened to it.</p>
      </section>
    );
  }

  const disabled = busy !== null;
  const canPlace = job.status === "SCHEDULED" && !job.assignedWorkerId;
  const canReserve = job.status === "SCHEDULED" && !!job.assignedWorkerId && !job.reservation;
  const canExecute = job.status === "SCHEDULED" && !!job.reservation;
  const canRelease = !!job.reservation;
  const canCancel = job.status === "QUEUED";

  return (
    <section className="panel" aria-label="Job detail">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Job detail</p>
          <h2>{job.name}</h2>
        </div>
        <span className={`status status-${job.status.toLowerCase()}`}>{job.status}</span>
      </header>

      <dl className="facts">
        <div>
          <dt>Workload</dt>
          <dd>
            {job.workloadType.replace(/_/g, " ").toLowerCase()} · size {job.workloadSize}
          </dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>
            {job.cpuRequiredMillicores}m CPU · {job.memoryRequiredMiB} MiB
          </dd>
        </div>
        <div>
          <dt>Priority / estimate</dt>
          <dd>
            {job.priority} · {job.estimatedDurationSeconds}s
          </dd>
        </div>
        <div>
          <dt>Scheduled by</dt>
          <dd>{job.schedulingPolicy ?? "not scheduled yet"}</dd>
        </div>
        <div>
          <dt>Placed by</dt>
          <dd>
            {job.placementStrategy
              ? `${job.placementStrategy} → ${job.assignedWorkerName ?? "unknown"}`
              : "not placed yet"}
          </dd>
        </div>
        <div>
          <dt>Pipeline stage</dt>
          <dd>{job.stage}</dd>
        </div>
      </dl>

      {job.reservation ? (
        <div className="callout callout-db">
          <strong>Resource reserved</strong>
          <span>
            {job.assignedWorkerName ?? "worker"} · {job.reservation.cpuMillicores}m CPU /{" "}
            {job.reservation.memoryMiB} MiB
          </span>
          <small>
            Committed by a PostgreSQL transaction holding a row lock on the worker, so a concurrent
            job cannot claim the same capacity.
          </small>
        </div>
      ) : null}

      {job.execution ? (
        <div className="callout callout-docker">
          <strong>Docker execution · attempt {job.execution.attempt}</strong>
          <span className="mono">
            {job.execution.containerShortId ?? "no container"} · {job.execution.status}
          </span>
          <small>
            {job.execution.startedAt
              ? `Started ${new Date(job.execution.startedAt).toLocaleTimeString()}`
              : "Not started"}
            {job.execution.elapsedSeconds !== null
              ? ` · ${job.execution.elapsedSeconds}s elapsed`
              : ""}
            {job.execution.exitCode !== null ? ` · exit ${job.execution.exitCode}` : ""}
          </small>
          {job.execution.failureReason ? (
            <small className="warn">{job.execution.failureReason}</small>
          ) : null}
        </div>
      ) : null}

      {job.result ? (
        <div className="callout callout-result">
          <strong>Recorded result</strong>
          <span className="mono">checksum {job.result.checksum}</span>
          <small>
            {job.result.operations?.toLocaleString()} operations · effective size{" "}
            {job.result.effectiveSize?.toLocaleString()} · runner {job.result.runnerDurationMs}ms
          </small>
          <small>
            The same seed reproduces this checksum exactly, which is how runs are compared.
          </small>
        </div>
      ) : null}

      {job.failureReason && !job.execution?.failureReason ? (
        <p className="warn">{job.failureReason}</p>
      ) : null}

      <details className="stage-controls">
        <summary>Advance one stage at a time (for demonstration)</summary>
        <div className="stage-buttons">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !canPlace}
            onClick={() => props.onPlace(job.id)}
          >
            Place with {props.strategy}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !canReserve}
            onClick={() => props.onReserve(job.id)}
          >
            Reserve resources
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !canExecute}
            onClick={() => props.onExecute(job.id)}
          >
            Start container
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !canRelease}
            onClick={() => props.onRelease(job.id)}
          >
            Release resources
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !canCancel}
            onClick={() => props.onCancel(job.id)}
          >
            Cancel job
          </button>
        </div>
        <p className="hint">
          These call the same stage endpoints the orchestrator uses. Buttons are disabled when the
          job is not in a state that allows the action.
        </p>
      </details>
    </section>
  );
}
