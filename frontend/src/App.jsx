import { useEffect, useState } from "react";
import { fetchHealthStatus } from "./api";
import { MonitoringPanel } from "./MonitoringPanel.jsx";
import { OrchestratorConsole } from "./OrchestratorConsole.jsx";
import { Icon } from "./components/Icon.jsx";
const currentCapabilities = [
  "MySQL-backed job records",
  "Controlled job lifecycle",
  "Logical worker registry",
  "Deterministic workload batches",
  "FCFS, SJF, Priority, Round Robin scheduling",
  "Resource-aware worker placement",
  "Transaction-safe CPU and memory reservation",
  "Controlled Docker workload execution",
  "Reproducible result checksums",
  "Live operational metrics and utilization history",
  "Browser-driven orchestration with per-stage controls",
  "Restart recovery and workload cleanup",
];
const futureCapabilities = [
  "Reactive autoscaling",
  "Worker-level failure recovery",
  "Preemption and individual runtime cancellation",
];
export function App() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("orchestros-console-theme");
      return ["light", "dark", "system"].includes(saved) ? saved : "dark";
    } catch {
      return "dark";
    }
  });
  const [activeSection, setActiveSection] = useState("console");
  useEffect(() => {
    const updateSection = () => {
      const section = window.location.hash.slice(1);
      if (["console", "pipeline", "job-queue", "monitoring"].includes(section)) setActiveSection(section);
    };
    updateSection();
    window.addEventListener("hashchange", updateSection);
    return () => window.removeEventListener("hashchange", updateSection);
  }, []);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("orchestros-console-theme", theme);
    } catch {
      // Theme selection still works when browser storage is unavailable.
    }
  }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    fetchHealthStatus(controller.signal)
      .then((status) => {
        setHealth(status);
        setError(null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : "Health check failed",
          );
        }
      });
    return () => controller.abort();
  }, []);
  const apiState =
    health?.status === "ok"
      ? "Online"
      : health?.status === "degraded"
        ? "Degraded"
        : error
          ? "Unavailable"
          : "Checking";
  const databaseState = health?.dependencies.database ?? "checking";
  return (
    <main className="shell" id="overview">
      <a className="skip-link" href="#console">Skip to controls</a>
      <header className="console-header">
        <a className="console-identity" href="#console" aria-label="OrchestrOS control panel">
          <span className="logo-mark"><Icon name="workflow" /></span>
          <strong>Orchestrator</strong>
          <span className="console-label">/ operator console</span>
        </a>
        <nav aria-label="Dashboard sections">
          {[
            ["console", "Control panel"], ["pipeline", "Pipeline"],
            ["job-queue", "Job queue"], ["monitoring", "Monitoring"],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={activeSection === id ? "location" : undefined}
              onClick={() => setActiveSection(id)}>{label}</a>
          ))}
        </nav>
        <select className="theme-select" aria-label="Color theme" value={theme}
          onChange={(event) => setTheme(event.target.value)}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">System</option>
        </select>
      </header>

      {error ? (
        <p className="error-banner">
          {error}. Check that the backend and MySQL are running.
        </p>
      ) : null}

      <div id="console" tabIndex={-1}>
        <OrchestratorConsole />
      </div>

      <div id="monitoring">
        <MonitoringPanel />
      </div>

      <details className="foundation-details">
        <summary>Architecture and supported capabilities</summary>
        <section className="foundation-panel">
          <div>
            <p className="eyebrow">Implemented now</p>
            <h2>Scheduled, reserved, executed, and measured</h2>
            <p>
              Seeded workloads become queued jobs, the scheduler picks the next
              job by policy, and placement chooses a logical worker. Reservation
              commits capacity inside a MySQL transaction that locks the worker
              row, so concurrent jobs can never over-allocate it. The job then
              runs as one locked-down container limited to exactly that
              reservation, and recording its result releases the capacity in a
              single transaction. Every number on this page is read back from
              those same records, so it cannot disagree with them.
            </p>
            <ul>
              {currentCapabilities.map((capability) => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow">Planned increments</p>
            <ul>
              {futureCapabilities.map((capability) => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          </div>
        </section>
      </details>
      <footer className="workspace-footer">
        <span>OrchestrOS</span>
        <span className="service-health" role="status">
          <span className={apiState === "Online" && databaseState === "up" ? "healthy" : "pending"}>
            API {apiState.toLowerCase()} · database {databaseState === "up" ? "connected" : databaseState}
          </span>
          <span>Local compute. Persistent state.</span>
        </span>
      </footer>
    </main>
  );
}
