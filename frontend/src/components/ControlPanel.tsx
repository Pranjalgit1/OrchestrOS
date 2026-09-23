import type {
  ArrivalChoice,
  GenerateWorkloadRequest,
  PlacementStrategy,
  SchedulingPolicy,
} from "../api";

const COUNTS: GenerateWorkloadRequest["count"][] = [10, 25, 50, 100];

const ARRIVALS: { value: ArrivalChoice; label: string }[] = [
  { value: "IMMEDIATE", label: "Immediate — all jobs eligible at once (Custom)" },
  { value: "LIGHT", label: "Light — 20–40s apart" },
  { value: "MEDIUM", label: "Medium — 8–16s apart" },
  { value: "HEAVY", label: "Heavy — 2–6s apart" },
  { value: "CONSTANT", label: "Constant — every 10s" },
  { value: "BURST", label: "Burst — groups of 5, 30s apart" },
  { value: "INCREASING", label: "Increasing — ramping up" },
  { value: "DECREASING", label: "Decreasing — ramping down" },
  { value: "PERIODIC", label: "Periodic — repeating profile" },
];

const POLICIES: { value: SchedulingPolicy; label: string }[] = [
  { value: "FCFS", label: "FCFS — first come, first served" },
  { value: "SJF", label: "SJF — shortest job first" },
  { value: "PRIORITY", label: "Priority — highest priority, with aging" },
  { value: "ROUND_ROBIN", label: "Round Robin — rotate by quantum" },
];

const STRATEGIES: { value: PlacementStrategy; label: string }[] = [
  { value: "FIRST_FIT", label: "First Fit — first worker that fits" },
  { value: "LEAST_LOADED", label: "Least Loaded — lowest current load" },
  { value: "RESOURCE_AWARE", label: "Resource-Aware — best balanced fit" },
];

export interface ControlPanelProps {
  form: GenerateWorkloadRequest;
  onFormChange: (next: GenerateWorkloadRequest) => void;
  policy: SchedulingPolicy;
  onPolicyChange: (next: SchedulingPolicy) => void;
  strategy: PlacementStrategy;
  onStrategyChange: (next: PlacementStrategy) => void;
  timeQuantumSeconds: number;
  onTimeQuantumChange: (next: number) => void;
  batchSize: number;
  onBatchSizeChange: (next: number) => void;
  autoRunning: boolean;
  busy: string | null;
  onGenerate: () => void;
  onRunNext: () => void;
  onRunBatch: () => void;
  onToggleAuto: () => void;
  onReset: () => void;
  onDemo: () => void;
}

export function ControlPanel(props: ControlPanelProps) {
  const {
    form,
    onFormChange,
    policy,
    onPolicyChange,
    strategy,
    onStrategyChange,
    timeQuantumSeconds,
    onTimeQuantumChange,
    batchSize,
    onBatchSizeChange,
    autoRunning,
    busy,
  } = props;
  const disabled = busy !== null;

  return (
    <section className="panel" aria-label="Orchestrator controls">
      <header className="panel-head">
        <div>
          <p className="eyebrow">Control panel</p>
          <h2>Operate the orchestrator</h2>
        </div>
        <button
          type="button"
          className="btn btn-demo"
          onClick={props.onDemo}
          disabled={disabled}
        >
          Demo Mode — generate 10 and run
        </button>
      </header>

      <div className="control-grid">
        {/* 1. Workload generator */}
        <fieldset className="control-block">
          <legend>1 · Workload generator</legend>

          <label htmlFor="job-count">Number of jobs</label>
          <select
            id="job-count"
            value={form.count}
            disabled={disabled}
            onChange={(event) =>
              onFormChange({
                ...form,
                count: Number(event.target.value) as GenerateWorkloadRequest["count"],
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
              onFormChange({ ...form, arrival: event.target.value as ArrivalChoice })
            }
          >
            {ARRIVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {form.arrival === "IMMEDIATE" ? (
            <>
              <label htmlFor="profile">Workload type</label>
              <select
                id="profile"
                value={form.profile}
                disabled={disabled}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    profile: event.target.value as GenerateWorkloadRequest["profile"],
                  })
                }
              >
                <option value="SLEEP">Sleep — 4–10s each, easy to watch</option>
                <option value="MIXED_COMPUTE">Mixed compute — CPU, matrix, sort, data</option>
              </select>

              <div className="control-row">
                <span>
                  <label htmlFor="cpu">CPU per job (m)</label>
                  <input
                    id="cpu"
                    type="number"
                    min={100}
                    max={6000}
                    step={100}
                    value={form.cpuMillicores}
                    disabled={disabled}
                    onChange={(event) =>
                      onFormChange({ ...form, cpuMillicores: Number(event.target.value) })
                    }
                  />
                </span>
                <span>
                  <label htmlFor="mem">Memory per job (MiB)</label>
                  <input
                    id="mem"
                    type="number"
                    min={64}
                    max={8192}
                    step={64}
                    value={form.memoryMiB}
                    disabled={disabled}
                    onChange={(event) =>
                      onFormChange({ ...form, memoryMiB: Number(event.target.value) })
                    }
                  />
                </span>
              </div>
            </>
          ) : (
            <p className="hint">
              This pattern spaces arrivals over time, so jobs become eligible gradually. The queue
              shows how long each one still has to wait.
            </p>
          )}

          <label htmlFor="seed">Deterministic seed</label>
          <div className="control-row">
            <input
              id="seed"
              type="number"
              min={0}
              max={2147483647}
              value={form.seed}
              disabled={disabled}
              onChange={(event) => onFormChange({ ...form, seed: Number(event.target.value) })}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() =>
                onFormChange({ ...form, seed: Math.floor(Math.random() * 2_000_000) })
              }
            >
              Shuffle
            </button>
          </div>
          <p className="hint">The same seed always produces the same jobs and the same results.</p>

          <button
            type="button"
            className="btn btn-primary"
            onClick={props.onGenerate}
            disabled={disabled}
          >
            {busy === "generate" ? "Generating…" : "Generate Workload"}
          </button>
        </fieldset>

        {/* 2 & 3. Scheduler and placement */}
        <fieldset className="control-block">
          <legend>2 · Scheduling policy</legend>
          <select
            aria-label="Scheduling policy"
            value={policy}
            disabled={disabled}
            onChange={(event) => onPolicyChange(event.target.value as SchedulingPolicy)}
          >
            {POLICIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {policy === "ROUND_ROBIN" ? (
            <>
              <label htmlFor="quantum">Time quantum (s)</label>
              <input
                id="quantum"
                type="number"
                min={1}
                max={3600}
                value={timeQuantumSeconds}
                disabled={disabled}
                onChange={(event) => onTimeQuantumChange(Number(event.target.value))}
              />
            </>
          ) : null}

          <legend className="legend-spaced">3 · Placement strategy</legend>
          <select
            aria-label="Placement strategy"
            value={strategy}
            disabled={disabled}
            onChange={(event) => onStrategyChange(event.target.value as PlacementStrategy)}
          >
            {STRATEGIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint">
            The backend applies both of these. Placement is advisory until reservation commits the
            capacity in a transaction.
          </p>
        </fieldset>

        {/* 4. Execution */}
        <fieldset className="control-block">
          <legend>4 · Run the orchestrator</legend>

          <button
            type="button"
            className="btn btn-primary"
            onClick={props.onRunNext}
            disabled={disabled || autoRunning}
          >
            {busy === "run-next" ? "Running…" : "Run Next Job"}
          </button>

          <label htmlFor="batch">Jobs per batch</label>
          <input
            id="batch"
            type="number"
            min={1}
            max={25}
            value={batchSize}
            disabled={disabled}
            onChange={(event) => onBatchSizeChange(Number(event.target.value))}
          />
          <button
            type="button"
            className="btn"
            onClick={props.onRunBatch}
            disabled={disabled || autoRunning}
          >
            {busy === "run-batch" ? "Running…" : `Run ${batchSize} Now`}
          </button>

          <button
            type="button"
            className={autoRunning ? "btn btn-stop" : "btn btn-primary"}
            onClick={props.onToggleAuto}
          >
            {autoRunning ? "Pause Orchestrator" : "Run Orchestrator (auto)"}
          </button>
          <p className="hint">
            Auto keeps asking the backend for the next job until the queue drains. Each decision is
            still made by the backend.
          </p>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={props.onReset}
            disabled={disabled || autoRunning}
          >
            {busy === "reset" ? "Clearing…" : "Clear finished jobs"}
          </button>
        </fieldset>
      </div>
    </section>
  );
}
