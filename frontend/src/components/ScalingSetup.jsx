import { MIXED_COMPUTE_TYPES } from "../api";
import { POLICY_LABELS } from "../benchmark.chart.js";
import { Icon } from "./Icon.jsx";

export const COUNTS = [10, 25, 50];
export const PATTERNS = [
  ["INCREASING", "Increasing (ramp-up)"],
  ["BURST", "Burst (5 jobs every 30s)"],
  ["PERIODIC", "Periodic (repeating)"],
  ["CONSTANT", "Constant (every 10s)"],
  ["DECREASING", "Decreasing (ramp-down)"],
  ["HEAVY", "Heavy (2–6s apart)"],
  ["MEDIUM", "Medium (8–16s apart)"],
  ["IMMEDIATE", "Immediate (all at once)"],
  ["LIGHT", "Light (20–40s apart)"],
];
export const PROFILES = [
  ["SLEEP", "Sleep, short pauses"],
  ["MIXED_COMPUTE", "Mixed compute"],
  ["CPU_INTENSIVE", "CPU calculations"],
  ["SORTING", "Sorting"],
  ["DATA_PROCESSING", "Data processing"],
  ["MATRIX_MULTIPLICATION", "Matrix products"],
];
export const POLICIES = ["FCFS", "SJF", "PRIORITY", "ROUND_ROBIN"];
export const PLACEMENTS = [["LEAST_LOADED", "Least Loaded"], ["FIRST_FIT", "First Fit"], ["RESOURCE_AWARE", "Resource-Aware"]];

const labelOf = (pairs, value) => pairs.find(([key]) => key === value)?.[1] ?? value;

/** The workload type as chosen in the form: one type, or the mixed-compute set. */
export function profileOf(workloadTypes = []) {
  const types = [...workloadTypes].sort();
  if (types.length === MIXED_COMPUTE_TYPES.length && [...MIXED_COMPUTE_TYPES].sort().every((type, index) => type === types[index])) {
    return "MIXED_COMPUTE";
  }
  return types.length === 1 ? types[0] : types.join(", ");
}

/** The settings a stored comparison ran with, as shown in the setup bar. */
export function setupItems(comparison) {
  return [
    { key: "jobs", label: "Jobs", value: String(comparison.jobCount) },
    { key: "pattern", label: "Arrival pattern", value: labelOf(PATTERNS, comparison.pattern) },
    { key: "workload", label: "Workload type", value: labelOf(PROFILES, profileOf(comparison.workloadTypes)) },
    { key: "policy", label: "Scheduling", value: POLICY_LABELS[comparison.schedulingPolicy] ?? comparison.schedulingPolicy },
    { key: "placement", label: "Placement", value: labelOf(PLACEMENTS, comparison.placementStrategy) },
    { key: "seed", label: "Seed", value: String(comparison.seed) },
  ];
}

/** Arrival patterns and placements as short phrases for the setup strip. */
const PATTERN_WORDS = {
  INCREASING: "Increasing", BURST: "Burst", PERIODIC: "Periodic", CONSTANT: "Constant", DECREASING: "Decreasing",
  HEAVY: "Heavy", MEDIUM: "Medium", IMMEDIATE: "Immediate", LIGHT: "Light",
};
const PLACEMENT_WORDS = { LEAST_LOADED: "Least-loaded", FIRST_FIT: "First-fit", RESOURCE_AWARE: "Resource-aware" };

/**
 * The shown comparison's settings as one readable line: "25 jobs / Immediate
 * arrival / …". Each phrase keeps the full setting as its tooltip.
 */
export function setupPhrases(comparison) {
  const items = Object.fromEntries(setupItems(comparison).map((item) => [item.key, item]));
  const policy = items.policy.value;
  return [
    { key: "jobs", text: `${comparison.jobCount} ${comparison.jobCount === 1 ? "job" : "jobs"}` },
    { key: "pattern", text: `${PATTERN_WORDS[comparison.pattern] ?? comparison.pattern} arrival`, title: items.pattern.value },
    { key: "workload", text: items.workload.value },
    { key: "policy", text: comparison.schedulingPolicy === "ROUND_ROBIN"
      ? `${policy} scheduling (${comparison.timeQuantumSeconds}s quantum)` : `${policy} scheduling` },
    { key: "placement", text: `${PLACEMENT_WORDS[comparison.placementStrategy] ?? items.placement.value} placement` },
    { key: "seed", text: `Seed ${comparison.seed}` },
  ];
}

/** Read-only line of the settings the shown comparison used; Edit starts a new experiment from them. */
export function SetupSummary({ comparison, onEdit = null, canEdit = true }) {
  return (
    <section className="sc-setup-strip" aria-label="Experiment setup">
      <h2>Setup</h2>
      <ul>
        {setupPhrases(comparison).map((phrase) => (
          <li key={phrase.key} title={phrase.title}>{phrase.text}</li>
        ))}
      </ul>
      {onEdit ? (
        <button type="button" className="link sc-setup-edit" disabled={!canEdit} onClick={onEdit}
          title="Start a new experiment from these settings">
          Edit
        </button>
      ) : null}
    </section>
  );
}

/** Compact form for a new comparison. Reactive always runs first, then ML-assisted. */
export function SetupForm({ form, onFormChange, onStart, onCancel, busy, canCancel }) {
  const set = (patch) => onFormChange({ ...form, ...patch });
  return (
    <form className="sc-setup sc-setup-form" aria-label="New experiment"
      onSubmit={(event) => { event.preventDefault(); onStart(); }}>
      <h2>New experiment</h2>
      <div className="sc-setup-fields">
        <label htmlFor="sc-count">Jobs
          <select id="sc-count" value={form.count} disabled={busy}
            onChange={(event) => set({ count: Number(event.target.value) })}>
            {COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label htmlFor="sc-pattern">Arrival pattern
          <select id="sc-pattern" value={form.pattern} disabled={busy}
            onChange={(event) => set({ pattern: event.target.value })}>
            {PATTERNS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="sc-profile">Workload type
          <select id="sc-profile" value={form.profile} disabled={busy}
            onChange={(event) => set({ profile: event.target.value })}>
            {PROFILES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="sc-policy">Scheduling
          <select id="sc-policy" value={form.policy} disabled={busy}
            onChange={(event) => set({ policy: event.target.value })}>
            {POLICIES.map((policy) => <option key={policy} value={policy}>{POLICY_LABELS[policy]}</option>)}
          </select>
        </label>
        <label htmlFor="sc-placement">Placement
          <select id="sc-placement" value={form.strategy} disabled={busy}
            onChange={(event) => set({ strategy: event.target.value })}>
            {PLACEMENTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="sc-seed">Seed
          <input id="sc-seed" type="number" min={0} max={2147483647} step={1} required value={form.seed}
            disabled={busy} onChange={(event) => set({ seed: event.target.value })} />
        </label>
        {form.policy === "ROUND_ROBIN" ? (
          <label htmlFor="sc-quantum">Quantum (s)
            <input id="sc-quantum" type="number" min={1} max={3600} step={1} required value={form.timeQuantumSeconds}
              disabled={busy} onChange={(event) => set({ timeQuantumSeconds: event.target.value })} />
          </label>
        ) : null}
      </div>
      <div className="sc-setup-actions">
        {canCancel ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        ) : null}
        <button type="submit" className="btn btn-brand" disabled={busy}>
          <Icon name="play" />{busy ? "Starting…" : "Compare Reactive vs ML"}
        </button>
      </div>
      <p className="sc-setup-note">
        Runs the same seeded workload twice, Reactive then ML-assisted, using the thresholds on the Autoscaling tab.
        Needs an idle cluster.
      </p>
    </form>
  );
}
