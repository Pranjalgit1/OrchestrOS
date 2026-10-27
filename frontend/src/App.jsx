import { useEffect, useState } from "react";
import { fetchHealthStatus } from "./api";
import { MonitoringPanel } from "./MonitoringPanel.jsx";
import { OrchestratorConsole } from "./OrchestratorConsole.jsx";
import { Icon } from "./components/Icon.jsx";
import { createMonitoringPoller } from "./monitoring.poller.js";
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
  "Round Robin preemption with requeue",
  "Per-job cancellation, including running containers",
  "Automatic and manual retry of failed jobs",
  "Reactive worker autoscaling with recorded decisions",
  "Multi-policy benchmark with comparison charts",
];
/** One view per tab, so each feature fits on roughly one screen. */
export const TABS = [
  ["run", "Run"],
  ["autoscaling", "Autoscaling"],
  ["comparison", "Policy comparison"],
  ["monitoring", "Monitoring"],
];
const TAB_IDS = TABS.map(([id]) => id);
/** Older section links still land on the tab that now holds that section. */
const LEGACY_HASHES = {
  console: "run", pipeline: "run", "job-queue": "run", benchmark: "comparison",
};
export function tabFromHash(hash) {
  const id = hash.replace(/^#/, "");
  if (TAB_IDS.includes(id)) return id;
  return LEGACY_HASHES[id] ?? "run";
}
const futureCapabilities = [
  "Worker-level failure recovery",
];
export function ServiceHealth({ health, error, status }) {
  const apiState = error ? "Unavailable"
    : health?.status === "ok" ? "Online"
      : health?.status === "degraded" ? "Degraded" : "Checking";
  const databaseState = error ? "unknown" : health?.dependencies?.database ?? "checking";
  return (
    <span className="service-health" role="status">
      <span className={apiState === "Online" && databaseState === "up" ? "healthy" : "pending"}>
        API {apiState.toLowerCase()} · database {databaseState === "up" ? "connected" : databaseState}
      </span>
      {status?.lastCheckedAt ? (
        <span>Checked {new Date(status.lastCheckedAt).toLocaleTimeString()}</span>
      ) : null}
      <span>Local compute. Persistent state.</span>
    </span>
  );
}
export function App() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("orchestros-console-theme");
      return ["light", "dark", "system"].includes(saved) ? saved : "light";
    } catch {
      return "light";
    }
  });
  // The tab lives in the URL hash, so reloads and links keep the same view.
  const [tab, setTab] = useState(() =>
    typeof window === "undefined" ? "run" : tabFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => {
      setTab(tabFromHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [orchestrator, setOrchestrator] = useState({ autoRunning: false });
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [healthStatus, setHealthStatus] = useState(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("orchestros-console-theme", theme);
    } catch {
      // Theme selection still works when browser storage is unavailable.
    }
  }, [theme]);
  useEffect(() => {
    const poller = createMonitoringPoller({
      sources: { health: { label: "Service health", fetch: fetchHealthStatus, intervalMs: 10_000 } },
      onData: (_, status) => setHealth(status),
      onError: setError,
      onStatus: (_, status) => setHealthStatus(status),
    });
    return () => poller.stop();
  }, []);
  const servicesConnected = !error && health?.status === "ok" && health?.dependencies?.database === "up";
  const connectionLabel = error ? "Connection unavailable"
    : servicesConnected ? "Systems connected"
      : health?.status === "degraded" ? "Service degraded" : "Connecting to services";
  return (
    <main className="shell" id="overview">
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="console-header">
        <a className="console-identity" href="#run" aria-label="OrchestrOS, go to Run">
          <span className="logo-mark"><Icon name="workflow" /></span>
          <strong>OrchestrOS</strong>
          <span className="console-label">Workload console</span>
        </a>
        <nav aria-label="Dashboard views">
          {TABS.map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? "page" : undefined}>
              {label}
              {id === "run" && orchestrator.autoRunning && tab !== "run" ? (
                <span className="tab-live" title="The orchestrator is running">
                  <span className="sr-only"> (running)</span>
                </span>
              ) : null}
            </a>
          ))}
        </nav>
        <span className="header-status" role="status" title={connectionLabel}>
          <span className={`connection-indicator${servicesConnected ? " is-connected" : ""}`} aria-hidden="true" />
          <span className="header-status-label">{servicesConnected ? "Connected" : connectionLabel}</span>
        </span>
        <select className="theme-select" aria-label="Color theme" value={theme}
          onChange={(event) => setTheme(event.target.value)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
      </header>

      {error ? (
        <p className="error-banner">
          {error}. Check that the backend and MySQL are running.
        </p>
      ) : null}

      <div id="content" tabIndex={-1} className={`tab-view tab-${tab}`}>
        {/* Always mounted: auto-run and polling continue while another tab is open. */}
        <OrchestratorConsole view={tab} onStatusChange={setOrchestrator} />
        {tab === "monitoring" ? <MonitoringPanel /> : null}
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
              single transaction. The dashboard reads job and resource records
              from MySQL. Panels refresh independently, and the job table shows
              recent updates.
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
        <ServiceHealth health={health} error={error} status={healthStatus} />
      </footer>
    </main>
  );
}
