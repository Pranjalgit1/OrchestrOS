import { useState } from "react";
import { BenchmarkPanel } from "./BenchmarkPanel.jsx";
import { ScalingComparisonPanel } from "./ScalingComparisonPanel.jsx";

/** The two experiments on the Comparison tab. */
export const COMPARISON_MODES = [
  { value: "policies", label: "Scheduling policies", hint: "FCFS vs SJF vs Priority vs Round Robin" },
  { value: "autoscaling", label: "Autoscaling: Reactive vs ML", hint: "The same workload with each autoscaling strategy" },
];

/** Pure view of the mode switch, so it renders in tests without a backend. */
export function ComparisonModeSwitch({ mode, onModeChange }) {
  return (
    <fieldset className="strategy-toggle comparison-mode">
      <legend className="sr-only">What to compare</legend>
      {COMPARISON_MODES.map((option) => (
        <label key={option.value} title={option.hint} className={option.value === mode ? "is-selected" : undefined}>
          <input type="radio" name="comparison-mode" value={option.value} checked={option.value === mode}
            onChange={() => onModeChange(option.value)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

/** Lets the reader choose which comparison to run or read; only the chosen one polls. */
export function ComparisonTab({ initialMode = "policies" }) {
  const [mode, setMode] = useState(initialMode);
  return (
    <>
      <div className="comparison-mode-bar">
        <span>Compare</span>
        <ComparisonModeSwitch mode={mode} onModeChange={setMode} />
      </div>
      {mode === "autoscaling" ? <ScalingComparisonPanel /> : <BenchmarkPanel />}
    </>
  );
}
