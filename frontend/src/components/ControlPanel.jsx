import { Icon } from "./Icon.jsx";

const COUNTS = [10, 25, 50, 100];
const ARRIVALS = [
  { value: "IMMEDIATE", label: "Immediate — ready now" },
  { value: "LIGHT", label: "Light — 20–40s apart" },
  { value: "MEDIUM", label: "Medium — 8–16s apart" },
  { value: "HEAVY", label: "Heavy — 2–6s apart" },
  { value: "CONSTANT", label: "Constant — every 10s" },
  { value: "BURST", label: "Burst — 5 jobs every 30s" },
  { value: "INCREASING", label: "Increasing — ramp up" },
  { value: "DECREASING", label: "Decreasing — ramp down" },
  { value: "PERIODIC", label: "Periodic — repeating" },
];
export const POLICIES = [
  { value: "FCFS", label: "FCFS — arrival order" },
  { value: "SJF", label: "SJF — shortest job first" },
  { value: "PRIORITY", label: "Priority — with aging" },
  { value: "ROUND_ROBIN", label: "Round Robin — time slices" },
];
export const STRATEGIES = [
  { value: "FIRST_FIT", label: "First fit — first worker that fits" },
  { value: "LEAST_LOADED", label: "Least loaded — lowest reserved share" },
  { value: "RESOURCE_AWARE", label: "Resource-aware — balanced fit" },
];
export const JOBS_PER_TICK = [
  { value: 1, label: "1 every 2s — step-by-step demo" },
  { value: 5, label: "5 every 2s — steady load" },
  { value: 25, label: "25 every 2s — fill the cluster" },
];

/** The Run page's actions: add work, stop everything, and start or pause the orchestrator. */
export function RunActions({ autoRunning, busy, workloadOpen, onToggleWorkload, onKillAll, onToggleAuto }) {
  const disabled = busy !== null;
  return (
    <>
      <button type="button" className="btn btn-ghost" aria-expanded={workloadOpen}
        aria-controls="workload-panel" onClick={onToggleWorkload}>
        <Icon name="plus" />Add workload
        <Icon name="chevron" className={`run-chevron${workloadOpen ? " is-open" : ""}`} />
      </button>
      <button type="button" className="btn btn-stop" onClick={onKillAll} disabled={disabled}>
        <Icon name="stop" />{busy === "kill-all" ? "Stopping…" : "Kill all"}
      </button>
      <button type="button" className={autoRunning ? "btn btn-secondary" : "btn btn-primary"}
        onClick={onToggleAuto} disabled={disabled}>
        <Icon name={autoRunning ? "pause" : "play"} />
        {autoRunning ? "Pause" : "Run orchestrator"}
      </button>
    </>
  );
}

/** How jobs are chosen, where they go, and how fast they start: one bordered row of settings. */
export function RunSettings({
  policy, onPolicyChange, strategy, onStrategyChange, timeQuantumSeconds, onTimeQuantumChange,
  jobsPerTick, onJobsPerTickChange, busy,
}) {
  const disabled = busy !== null;
  return (
    <section className="run-settings" aria-label="Run settings">
      <label htmlFor="policy">
        <span>Scheduling policy</span>
        <select id="policy" value={policy} disabled={disabled}
          onChange={(event) => onPolicyChange(event.target.value)}>
          {POLICIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {policy === "ROUND_ROBIN" ? (
        <label htmlFor="quantum" className="run-settings-narrow"
          title="When a quantum expires and another job is waiting, the container is stopped and the job is requeued. It restarts from the beginning on its next turn, up to a preemption limit.">
          <span>Quantum (s)</span>
          <input id="quantum" type="number" min={1} max={3600} value={timeQuantumSeconds}
            disabled={disabled} onChange={(event) => onTimeQuantumChange(Number(event.target.value))} />
        </label>
      ) : null}
      <label htmlFor="strategy">
        <span>Placement</span>
        <select id="strategy" value={strategy} disabled={disabled}
          onChange={(event) => onStrategyChange(event.target.value)}>
          {STRATEGIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label htmlFor="jobs-per-tick"
        title="The orchestrator ticks every 2s. Starting more jobs per tick fills the workers, which is what triggers autoscaling.">
        <span>Jobs started per tick</span>
        <select id="jobs-per-tick" value={jobsPerTick} disabled={disabled}
          onChange={(event) => onJobsPerTickChange(Number(event.target.value))}>
          {JOBS_PER_TICK.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </section>
  );
}

/** Creating and clearing work. Opens on an empty cluster and folds away after generating. */
export function WorkloadPanel(props) {
  const { form, onFormChange, autoRunning, busy } = props;
  const disabled = busy !== null;
  return (
    <section id="workload-panel" className="card workload-card" aria-label="Add workload">
      <header className="card-head">
        <div>
          <h2>Add workload</h2>
          <p>Seeded jobs: the same seed and settings reproduce the same specifications.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={props.onDemo}
          disabled={disabled || autoRunning}>
          <Icon name="play" />Try a demo · 10 jobs
        </button>
      </header>

      <div className="workload-fields">
        <label htmlFor="job-count">Number of jobs
          <select id="job-count" value={form.count} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, count: Number(event.target.value) })}>
            {COUNTS.map((count) => <option key={count} value={count}>{count} jobs</option>)}
          </select>
        </label>
        <label htmlFor="arrival">Arrival pattern
          <select id="arrival" value={form.arrival} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, arrival: event.target.value })}>
            {ARRIVALS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label htmlFor="profile">Workload type
          <select id="profile" value={form.profile} disabled={disabled}
            onChange={(event) => onFormChange({ ...form, profile: event.target.value })}>
            <option value="SLEEP">Sleep — short pauses</option>
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
        <button type="button" className="btn btn-primary" onClick={props.onGenerate} disabled={disabled}>
          <Icon name="plus" />{busy === "generate" ? "Generating…" : "Generate workload"}
        </button>
      </div>

      <div className="workload-cleanup">
        <span>Cleanup</span>
        <button type="button" className="btn btn-ghost btn-small" onClick={props.onClearGenerated}
          disabled={disabled || autoRunning}>
          {busy === "clear-generated" ? "Clearing…" : "Clear generated workload"}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={props.onReset}
          disabled={disabled || autoRunning}>
          {busy === "reset" ? "Clearing…" : "Clear finished jobs"}
        </button>
        <small>Removes unstarted generated jobs, or finished jobs. Pause the orchestrator first.</small>
      </div>
    </section>
  );
}
