import { useEffect, useState } from "react";
import pkg from "../package.json";
import { fetchHealthStatus, fetchRuntime } from "./api";
import { MonitoringPanel } from "./MonitoringPanel.jsx";
import { OrchestratorConsole } from "./OrchestratorConsole.jsx";
import { Icon } from "./components/Icon.jsx";
import { PageHeader } from "./components/PageHeader.jsx";
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
  "Reactive and ML-predictive worker autoscaling with recorded decisions",
  "Multi-policy benchmark with comparison charts",
  "Reactive vs ML autoscaling comparison with timelines and a plain-language verdict",
];
const futureCapabilities = [
  "Worker-level failure recovery",
];
/** One view per tab, so each feature fits on roughly one screen. Number keys 1–4 switch views. */
export const TABS = [
  ["run", "Run workload"],
  ["autoscaling", "Autoscaling"],
  ["comparison", "Comparison"],
  ["monitoring", "Monitoring"],
];
const TAB_ICONS = { run: "play", autoscaling: "scaling", comparison: "compare", monitoring: "activity" };
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

/** The view a key press selects, or null. Typing in a field or holding a modifier never switches views. */
export function shortcutTab(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const target = event.target;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return null;
  const index = Number(event.key) - 1;
  return Number.isInteger(index) && index >= 0 && index < TABS.length ? TABS[index][0] : null;
}

/**
 * API, MySQL, and Docker as the dashboard last saw them. "System online"
 * means all three answered; any other state names what is missing.
 */
export function systemStatus({ health, healthError, runtime, runtimeError }) {
  const api = healthError ? "down" : health ? "up" : "checking";
  const database = healthError ? "unknown" : health?.dependencies?.database ?? "checking";
  const docker = runtimeError ? "down" : runtime ? "up" : "checking";
  const states = { api, database, docker };
  const down = Object.entries(states).filter(([, state]) => state === "down" || state === "unknown");
  const overall = down.length === 0 && api === "up" && database === "up" && docker === "up" ? "online"
    : down.length ? "degraded" : "checking";
  const label = overall === "online" ? "System Online"
    : overall === "checking" ? "Checking services" : "Degraded";
  return { ...states, overall, label };
}

/**
 * The sidebar's service rows. Every value is measured: the API's round trip
 * as this browser saw it, MySQL as the health check reported it, and running
 * containers against workers in service.
 */
export function serviceRows(status, { latencyMs = null, runningContainers = null, workerCount = null } = {}) {
  const word = { up: "up", down: "down", unknown: "unknown", checking: "…" };
  return [
    { key: "api", name: "API", state: status.api,
      value: status.api === "up" && latencyMs !== null ? `${latencyMs}ms` : word[status.api] ?? status.api,
      title: "Round trip of the last health check from this browser" },
    { key: "database", name: "MySQL", state: status.database, value: word[status.database] ?? status.database,
      title: "Database reachability reported by the backend" },
    { key: "docker", name: "Docker", state: status.docker,
      value: status.docker === "up" && runningContainers !== null && workerCount !== null
        ? `${runningContainers} / ${workerCount}` : word[status.docker] ?? status.docker,
      title: "Running containers / workers in service" },
  ];
}

const SERVICE_NAMES = { api: "API", database: "MySQL", docker: "Docker" };

/** The top bar's one-line service status: "API, MySQL, Docker connected", or what is not. */
export function servicesSummary(status) {
  if (status.overall === "online") return "API, MySQL, Docker connected";
  const missing = Object.keys(SERVICE_NAMES)
    .filter((key) => status[key] === "down" || status[key] === "unknown").map((key) => SERVICE_NAMES[key]);
  if (missing.length) return `${missing.join(", ")} not connected`;
  return "Checking services…";
}

/** The footer's backend status: whether the API answered and what it said about the database. */
export function backendSummary(status) {
  if (status.api === "down") return "API offline";
  if (status.api !== "up") return "Checking API…";
  if (status.database === "up") return "API online, database connected";
  if (status.database === "down") return "API online, database unreachable";
  return "API online, database unknown";
}

function initialTheme() {
  try {
    const saved = localStorage.getItem("orchestros-console-theme");
    if (saved === "light" || saved === "dark") return saved;
    if (saved === "system" && typeof matchMedia === "function") {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    // Storage can be unavailable; fall through to the default.
  }
  return "light";
}

export function App() {
  const [theme, setTheme] = useState(initialTheme);
  // The tab lives in the URL hash, so reloads and links keep the same view.
  const [tab, setTab] = useState(() =>
    typeof window === "undefined" ? "run" : tabFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => {
      setTab(tabFromHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    const onKey = (event) => {
      const next = shortcutTab(event);
      if (next) window.location.hash = next;
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const [orchestrator, setOrchestrator] = useState({ autoRunning: false });
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
    // The round trip is timed here so the sidebar reports what this browser measured.
    const timedHealth = async (signal) => {
      const started = performance.now();
      const body = await fetchHealthStatus(signal);
      return { ...body, latencyMs: Math.round(performance.now() - started) };
    };
    const poller = createMonitoringPoller({
      sources: { health: { label: "Service health", fetch: timedHealth, intervalMs: 10_000 } },
      onData: (_, status) => setHealth(status),
      onError: setError,
    });
    return () => poller.stop();
  }, []);
  // Docker is polled separately, so a stopped engine never shows as a backend error.
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  useEffect(() => {
    const poller = createMonitoringPoller({
      sources: { runtime: { label: "Docker", fetch: fetchRuntime, intervalMs: 15_000 } },
      onData: (_, status) => { setRuntime(status); setRuntimeError(null); },
      onError: setRuntimeError,
    });
    return () => poller.stop();
  }, []);
  const status = systemStatus({ health, healthError: error, runtime, runtimeError });
  const services = serviceRows(status, {
    latencyMs: health?.latencyMs ?? null,
    runningContainers: orchestrator.runningContainers ?? null,
    workerCount: orchestrator.workerCount ?? null,
  });
  // The measured values behind the one-line status, for anyone who hovers it.
  const servicesDetail = services.map((service) => `${service.name}: ${service.value}`).join(" · ");
  const backendState = status.api === "up" && status.database === "up" ? "up"
    : status.api === "down" || status.database === "down" ? "down" : "checking";
  return (
    <main className="shell app-shell" id="overview">
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="app-topbar">
        <a className="topbar-brand" href="#run" aria-label="OrchestrOS, go to Run workload" title={`OrchestrOS v${pkg.version}`}>
          <span className="logo-mark"><Icon name="workflow" /></span>
          <strong>OrchestrOS</strong>
        </a>
        <span className="topbar-tagline">Workload orchestrator</span>
        <div className="topbar-end">
          <p className={`topbar-status is-${status.overall}`} title={servicesDetail}>
            <span className="service-dot" aria-hidden="true" />
            <span role="status">{servicesSummary(status)}</span>
            <span className="sr-only"> ({servicesDetail})</span>
          </p>
          <select className="theme-select" aria-label="Colour theme" value={theme}
            onChange={(event) => setTheme(event.target.value)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>
      <div className="app-body">
        <nav className="app-sidebar" aria-label="Views">
          <h2 className="sidebar-heading">Workloads</h2>
          <div className="sidebar-nav">
            {TABS.map(([id, label], index) => (
              <a key={id} href={`#${id}`} aria-current={tab === id ? "page" : undefined}
                aria-keyshortcuts={String(index + 1)}>
                <Icon name={TAB_ICONS[id]} />
                <span>{label}</span>
                {id === "run" && orchestrator.autoRunning && tab !== "run" ? (
                  <span className="tab-live" title="The orchestrator is running">
                    <span className="sr-only"> (running)</span>
                  </span>
                ) : null}
              </a>
            ))}
          </div>
        </nav>

        <div className="app-main">
          {error ? (
            <p className="error-banner">
              {error}. Check that the backend and MySQL are running.
            </p>
          ) : null}

          <div id="content" tabIndex={-1} className={`tab-view tab-${tab}`}>
            {/* Always mounted: auto-run and polling continue while another tab is open. */}
            <OrchestratorConsole view={tab} onStatusChange={setOrchestrator} />
            {tab === "monitoring" ? (
              <>
                <PageHeader crumbs={["cluster", "monitoring"]} title="Monitoring"
                  subtitle="Reserved capacity, queue, throughput, and lifecycle timings, read from MySQL." />
                <MonitoringPanel />
              </>
            ) : null}
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
            <span>OrchestrOS · local compute, persistent state</span>
            <span className={`footer-status is-${backendState}`}>
              <span className="service-dot" aria-hidden="true" />{backendSummary(status)}
            </span>
          </footer>
        </div>
      </div>
    </main>
  );
}
