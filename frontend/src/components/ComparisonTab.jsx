import { useState } from "react";
import { BenchmarkPanel } from "./BenchmarkPanel.jsx";
import { ScalingComparisonPanel } from "./ScalingComparisonPanel.jsx";

/** The two experiments on the Comparison tab. */
export const COMPARISON_MODES = [
  { value: "autoscaling", label: "Autoscaling: Reactive vs ML", hint: "The same workload with each autoscaling strategy" },
  { value: "policies", label: "Scheduling policies", hint: "FCFS vs SJF vs Priority vs Round Robin" },
];

/** Pure view of the mode switch: a row of tabs above the page title, one selected. */
export function ComparisonModeSwitch({ mode, onModeChange }) {
  return (
    <fieldset className="page-tabs comparison-mode">
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

/**
 * Lets the reader choose which comparison to run or read; only the chosen one
 * polls. `unfinishedJobs` comes from the console's state, so the policy page
 * can say whether the cluster is idle enough to start.
 */
export function ComparisonTab({ initialMode = "autoscaling", unfinishedJobs = null }) {
  const [mode, setMode] = useState(initialMode);
  const modeSwitch = <ComparisonModeSwitch mode={mode} onModeChange={setMode} />;
  if (mode === "autoscaling") return <ScalingComparisonPanel modeSwitch={modeSwitch} />;
  return <BenchmarkPanel modeSwitch={modeSwitch} unfinishedJobs={unfinishedJobs} />;
}
