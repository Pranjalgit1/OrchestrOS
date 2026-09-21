import { useEffect, useState } from "react";

import { fetchHealthStatus, type HealthStatus } from "./api";

const currentCapabilities = [
  "PostgreSQL-backed job records",
  "Controlled job lifecycle",
  "Logical worker registry",
];

const futureCapabilities = [
  "Automated workload generation",
  "Policy-based scheduling",
  "Resource-aware placement",
  "Docker workload execution",
  "Monitoring and autoscaling",
  "Failure recovery",
];

export function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchHealthStatus(controller.signal)
      .then((status) => {
        setHealth(status);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Health check failed");
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
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Phase 1 · Data Layer</p>
        <h1>OrchestrOS</h1>
        <p className="subtitle">
          A Kubernetes-inspired local container orchestration prototype with resource-aware
          scheduling, safe allocation, monitoring, recovery, and ML-assisted scaling.
        </p>
      </header>

      <section className="status-grid" aria-label="Phase 1 service status">
        <article className="status-card">
          <span>Frontend</span>
          <strong className="healthy">Online</strong>
          <small>React + Vite</small>
        </article>
        <article className="status-card">
          <span>Backend API</span>
          <strong className={apiState === "Online" ? "healthy" : "pending"}>{apiState}</strong>
          <small>Node.js + Express</small>
        </article>
        <article className="status-card">
          <span>Database</span>
          <strong className={databaseState === "up" ? "healthy" : "pending"}>
            {databaseState === "up" ? "Connected" : databaseState === "down" ? "Unavailable" : "Checking"}
          </strong>
          <small>PostgreSQL + Prisma</small>
        </article>
      </section>

      {error ? <p className="error-banner">{error}. Check that the backend and PostgreSQL are running.</p> : null}

      <section className="foundation-panel">
        <div>
          <p className="eyebrow">Implemented now</p>
          <h2>Persistent orchestration state</h2>
          <p>
            Jobs and logical workers are validated by the API and stored in PostgreSQL. Logical
            workers represent tracked capacity on this one physical machine; they are not separate
            computers.
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
    </main>
  );
}
