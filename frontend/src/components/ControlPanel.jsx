import { Icon } from "./Icon.jsx";

const COUNTS = [10, 25, 50, 100];
const ARRIVALS = [
  {
    value: "IMMEDIATE",
    label: "Immediate · ready now",
  },
  { value: "LIGHT", label: "Light · 20–40s apart" },
  { value: "MEDIUM", label: "Medium · 8–16s apart" },
  { value: "HEAVY", label: "Heavy · 2–6s apart" },
  { value: "CONSTANT", label: "Constant · every 10s" },
  { value: "BURST", label: "Burst · 5 jobs every 30s" },
  { value: "INCREASING", label: "Increasing · ramp up" },
  { value: "DECREASING", label: "Decreasing · ramp down" },
  { value: "PERIODIC", label: "Periodic · repeating" },
];
const POLICIES = [
  { value: "FCFS", label: "FCFS · arrival order" },
  { value: "SJF", label: "SJF · shortest first" },
  { value: "PRIORITY", label: "Priority · with aging" },
  { value: "ROUND_ROBIN", label: "Round Robin · round order" },
];
const STRATEGIES = [
  { value: "FIRST_FIT", label: "First Fit · first that fits" },
  { value: "LEAST_LOADED", label: "Least Loaded · lowest load" },
  { value: "RESOURCE_AWARE", label: "Resource-Aware · balanced fit" },
];
const JOBS_PER_TICK = [
  { value: 1, label: "step-by-step demo(One job starts every 2 seconds)" },
  { value: 5, label: "steady load(several workers busy)" },
  { value: 25, label: "fill the cluster(stress test / autoscaling)" },
];

/**
 * The controls needed while a run is in progress, in one row that stays under
 * the navigation bar: how jobs are chosen and placed, and start, pause, stop.
 */
export function RunBar(props) {
  const {
    policy, onPolicyChange, strategy, onStrategyChange, timeQuantumSeconds,
    onTimeQuantumChange, autoRunning, busy, workloadOpen, onToggleWorkload,
  } = props;
  const disabled = busy !== null;
  return (
    <section className="run-bar" aria-label="Run controls" aria-busy={disabled}>
      <p className={`run-state${autoRunning ? " is-running" : ""}`} role="status">
        <span aria-hidden="true" />
        {autoRunning ? "Running" : "Idle"}
      </p>

      <label className="run-field" htmlFor="policy">
        <span>Policy</span>
        <select id="policy" value={policy} disabled={disabled}
          onChange={(event) => onPolicyChange(event.target.value)}>
          {POLICIES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      {policy === "ROUND_ROBIN" ? (
        <label className="run-field run-field-narrow" htmlFor="quantum"
          title="When a quantum expires and another job is waiting, the container is stopped and the job is requeued. It restarts from the beginning on its next turn, up to a preemption limit.">
          <span>Quantum (s)</span>
          <input id="quantum" type="number" min={1} max={3600} value={timeQuantumSeconds}
            disabled={disabled} onChange={(event) => onTimeQuantumChange(Number(event.target.value))} />
        </label>
      ) : null}

      <label className="run-field" htmlFor="strategy">
        <span>Placement</span>
        <select id="strategy" value={strategy} disabled={disabled}
          onChange={(event) => onStrategyChange(event.target.value)}>
          {STRATEGIES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="run-field run-field-wide" htmlFor="jobs-per-tick"
        title="Each tick runs every 2s. Starting more jobs per tick fills the workers, which is what triggers autoscaling.">
        <span>Jobs started per tick</span>
        <select id="jobs-per-tick" value={props.jobsPerTick} disabled={disabled}
          onChange={(event) => props.onJobsPerTickChange(Number(event.target.value))}>
          {JOBS_PER_TICK.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <div className="run-actions">
        <button type="button" className={autoRunning ? "btn btn-secondary" : "btn btn-primary"}
          onClick={props.onToggleAuto} disabled={disabled}>
          <Icon name={autoRunning ? "pause" : "play"} />
          {autoRunning ? "Pause" : "Run orchestrator"}
        </button>
        <button type="button" className="btn btn-stop" onClick={props.onKillAll} disabled={disabled}>
          <Icon name="stop" />
          {busy === "kill-all" ? "Stopping…" : "Kill all"}
        </button>
        <button type="button" className="btn btn-ghost" aria-expanded={workloadOpen}
          aria-controls="workload-panel" onClick={onToggleWorkload}>
          <Icon name="plus" />Workload
          <Icon name="chevron" className={`run-chevron${workloadOpen ? " is-open" : ""}`} />
        </button>
      </div>
    </section>
  );
}

/** Creating and clearing work. Opens on an empty cluster and folds away after generating. */
export function WorkloadPanel(props) {
  const { form, onFormChange, autoRunning, busy } = props;
  const disabled = busy !== null;
  return (
    <section id="workload-panel" className="panel workload-panel" aria-label="Workload">
      <header className="panel-head">
        <div>
          <h2>Workload</h2>
        </div>
        <button type="button" className="btn btn-demo" onClick={props.onDemo}
          disabled={disabled || autoRunning}>
          <Icon name="play" />Try a demo · 10 jobs
        </button>
      </header>

      <div className="workload-grid">
        <label htmlFor="job-count">Number of jobs
          <select id="job-count" value={form.count} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, count: Number(event.target.value) })}>
            {COUNTS.map((count) => <option key={count} value={count}>{count} jobs</option>)}
          </select>
        </label>

        <label htmlFor="arrival">Arrival pattern
          <select id="arrival" value={form.arrival} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, arrival: event.target.value })}>
            {ARRIVALS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label htmlFor="profile">Workload type
          <select id="profile" value={form.profile} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, profile: event.target.value })}>
            <option value="SLEEP">Sleep · short pauses</option>
            <option value="MIXED_COMPUTE">Mixed compute</option>
            <option value="CPU_INTENSIVE">CPU calculations</option>
            <option value="SORTING">Sorting</option>
            <option value="DATA_PROCESSING">Data processing</option>
            <option value="MATRIX_MULTIPLICATION">Matrix products</option>
          </select>
        </label>

        <label htmlFor="seed" title="The same seed and settings reproduce job specifications and workload checksums.">
          Seed
          <input id="seed" type="number" min={0} max={2147483647} value={form.seed} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, seed: Number(event.target.value) })} />
        </label>

        <button type="button" className="btn btn-secondary workload-generate" onClick={props.onGenerate}
          disabled={disabled}>
          <Icon name="plus" />
          {busy === "generate" ? "Generating…" : "Generate workload"}
        </button>
      </div>

      <details className="control-details">
        <summary>Cleanup</summary>
        <div className="workload-cleanup">
          <button type="button" className="btn btn-ghost" onClick={props.onClearGenerated}
            disabled={disabled || autoRunning}>
            {busy === "clear-generated" ? "Clearing…" : "Clear generated workload"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={props.onReset}
            disabled={disabled || autoRunning}>
            {busy === "reset" ? "Clearing…" : "Clear finished jobs"}
          </button>
        </div>
        <p className="hint">
          Clear generated removes generated jobs that have not started scheduling, including future
          occurrences. Pause the orchestrator before cleanup.
        </p>
      </details>
    </section>
  );
}
