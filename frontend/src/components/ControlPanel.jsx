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
export function ControlPanel(props) {
  const {
    form,
    onFormChange,
    policy,
    onPolicyChange,
    strategy,
    onStrategyChange,
    timeQuantumSeconds,
    onTimeQuantumChange,
    autoRunning,
    busy,
  } = props;
  const disabled = busy !== null;
  return (
    <section className="panel" aria-label="Orchestrator controls">
      <header className="panel-head">
        <div>
          <h2>Prepare a run</h2>
        </div>
        <button
          type="button"
          className="btn btn-demo"
          onClick={props.onDemo}
          disabled={disabled || autoRunning}
        >
          <Icon name="play" />Try a demo · 10 jobs
        </button>
      </header>

      <div className="control-grid">
        {/* 1. Workload generator */}
        <fieldset className="control-block">
          <legend><span className="step-number">1</span>Workload generator</legend>

          <label htmlFor="job-count">Number of jobs</label>
          <select
            id="job-count"
            value={form.count}
            disabled={disabled}
            onChange={(event) =>
              onFormChange({
                ...form,
                count: Number(event.target.value),
              })
            }
          >
            {COUNTS.map((count) => (
              <option key={count} value={count}>
                {count} jobs
              </option>
            ))}
          </select>

          <label htmlFor="arrival">Arrival pattern</label>
          <select
            id="arrival"
            value={form.arrival}
            disabled={disabled}
            onChange={(event) =>
              onFormChange({ ...form, arrival: event.target.value })
            }
          >
            {ARRIVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="profile">Workload type</label>
          <select
            id="profile"
            value={form.profile}
            disabled={disabled}
            onChange={(event) =>
              onFormChange({
                ...form,
                profile: event.target.value,
              })
            }
          >
            <option value="SLEEP">Sleep · short pauses</option>
            <option value="MIXED_COMPUTE">
              Mixed compute
            </option>
            <option value="CPU_INTENSIVE">CPU calculations</option>
            <option value="SORTING">Sorting</option>
            <option value="DATA_PROCESSING">Data processing</option>
            <option value="MATRIX_MULTIPLICATION">Matrix products</option>
          </select>
          <p className="hint">Generated jobs use 64-256 MiB and short, bounded workloads. Resources are sized automatically.</p>

          <details className="control-details">
            <summary>Reproducibility</summary>
            <label htmlFor="seed">Deterministic seed</label>
            <input
              id="seed"
              type="number"
              min={0}
              max={2147483647}
              value={form.seed}
              disabled={disabled}
              onChange={(event) =>
                onFormChange({ ...form, seed: Number(event.target.value) })
              }
            />
            <p className="hint">
              The same seed and settings reproduce job specifications and workload checksums. Timing can vary.
            </p>
          </details>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={props.onGenerate}
            disabled={disabled}
          >
            <Icon name="plus" />
            {busy === "generate" ? "Generating…" : "Generate workload"}
          </button>
        </fieldset>

        {/* 2 & 3. Scheduler and placement */}
        <fieldset className="control-block">
          <legend><span className="step-number">2</span>Scheduling policy</legend>
          <label htmlFor="policy">Policy</label>
          <select
            id="policy"
            aria-label="Scheduling policy"
            value={policy}
            disabled={disabled}
            onChange={(event) => onPolicyChange(event.target.value)}
          >
            {POLICIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {policy === "ROUND_ROBIN" ? (
            <>
              <label htmlFor="quantum">Recorded time quantum (s)</label>
              <input
                id="quantum"
                type="number"
                min={1}
                max={3600}
                value={timeQuantumSeconds}
                disabled={disabled}
                onChange={(event) =>
                  onTimeQuantumChange(Number(event.target.value))
                }
              />
              <p className="hint">The quantum is recorded for study runs. Running containers are not paused or resumed.</p>
            </>
          ) : null}

          <p className="control-subtitle"><span className="step-number">3</span>Placement strategy</p>
          <label htmlFor="strategy">Strategy</label>
          <select
            id="strategy"
            value={strategy}
            disabled={disabled}
            onChange={(event) => onStrategyChange(event.target.value)}
          >
            {STRATEGIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint scheduling-note">
            <Icon name="info" />
            Choose how jobs are ordered and which worker receives each job.
            The backend schedules and reserves capacity.
          </p>
        </fieldset>

        {/* 4. Execution */}
        <fieldset className="control-block">
          <legend><span className="step-number">4</span>Run the orchestrator</legend>

          <button
            type="button"
            className={autoRunning ? "btn btn-secondary" : "btn btn-primary"}
            onClick={props.onToggleAuto}
            disabled={disabled}
          >
            <Icon name={autoRunning ? "pause" : "play"} />
            {autoRunning ? "Pause orchestrator" : "Run orchestrator"}
          </button>
          <p className="hint">Pause stops new run requests. Containers already running continue.</p>
          <button type="button" className="btn btn-stop" onClick={props.onKillAll}
            disabled={disabled}>
            <Icon name="stop" />
            {busy === "kill-all" ? "Stopping workloads…" : "Kill all workloads"}
          </button>
          <details className="control-details">
            <summary>Cleanup</summary>
            <button type="button" className="btn btn-ghost" onClick={props.onClearGenerated}
              disabled={disabled || autoRunning}>
              {busy === "clear-generated" ? "Clearing…" : "Clear generated workload"}
            </button>
            <p className="hint">Removes generated jobs that have not started scheduling, including future arrivals.</p>
            <button type="button" className="btn btn-ghost" onClick={props.onReset}
              disabled={disabled || autoRunning}>
              {busy === "reset" ? "Clearing…" : "Clear finished jobs"}
            </button>
            <p className="hint">Removes completed, failed, interrupted, and cancelled jobs. Pause the orchestrator before cleanup.</p>
          </details>
        </fieldset>
      </div>
    </section>
  );
}
