import { useEffect, useState } from "react";

import { fetchHealthStatus, type HealthStatus } from "./api";

const currentCapabilities = [
  "PostgreSQL-backed job records",
  "Controlled job lifecycle",
  "Logical worker registry",
  "Deterministic workload batches",
  "FCFS, SJF, Priority, Round Robin scheduling",
  "Resource-aware worker placement",
  "Transaction-safe CPU and memory reservation",
  "Controlled Docker workload execution",
  "Reproducible result checksums",
];

const futureCapabilities = [
  "Monitoring and autoscaling",
  "Failure recovery",
  "Preemption and runtime cancellation",
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
        <p className="eyebrow">Phase 6 · Controlled Execution</p>
        <h1>OrchestrOS</h1>
        <p className="subtitle">
          A Kubernetes-inspired local container orchestration prototype with reproducible
          workloads, resource-aware scheduling, safe allocation, recovery, and assisted scaling.
        </p>
      </header>

      <section className="status-grid" aria-label="Service status">
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
          <h2>Scheduled, reserved, and actually executed</h2>
          <p>
            Seeded workloads become queued jobs, the scheduler picks the next job by policy, and
            placement chooses a logical worker. Reservation commits capacity inside a PostgreSQL
            transaction that locks the worker row, so concurrent jobs can never over-allocate it.
            The job then runs as one locked-down container limited to exactly that reservation,
            and recording its result releases the capacity in a single transaction.
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
