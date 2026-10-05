import { useCallback, useEffect, useRef, useState } from "react";
import {
  assignPlacement,
  cancelJob,
  clearFinishedJobs,
  clearGeneratedWorkload,
  fetchOrchestratorState,
  generateWorkload,
  killAllWorkloads,
  releaseResources,
  reserveResources,
  runOrchestrator,
  startExecution,
} from "./api";
import { ActivityLog } from "./components/ActivityLog.jsx";
import { ControlPanel } from "./components/ControlPanel.jsx";
import { JobDetail } from "./components/JobDetail.jsx";
import { JobQueue } from "./components/JobQueue.jsx";
import { PipelineView } from "./components/PipelineView.jsx";
import { WorkerGrid } from "./components/WorkerGrid.jsx";
const POLL_MS = 3_000;
const AUTO_TICK_MS = 2_000;
/** Codes that mean "nothing to do right now" rather than a real problem. */
const BENIGN_STOPS = new Set(["NOTHING_ELIGIBLE", "INSUFFICIENT_RESOURCES"]);
const DEFAULT_FORM = {
  count: 10,
  arrival: "IMMEDIATE",
  seed: 42,
  profile: "SLEEP",
};
export function OrchestratorConsole() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [policy, setPolicy] = useState("FCFS");
  const [strategy, setStrategy] = useState("LEAST_LOADED");
  const [timeQuantumSeconds, setTimeQuantumSeconds] = useState(10);
  const [autoRunning, setAutoRunning] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [entries, setEntries] = useState([]);
  const mounted = useRef(true);
  const logId = useRef(0);
  // Kept in a ref so the auto-run timer always sees the current selections.
  const settings = useRef({ policy, strategy, timeQuantumSeconds });
  settings.current = { policy, strategy, timeQuantumSeconds };
  const log = useCallback((kind, label, detail) => {
    logId.current += 1;
    const entry = {
      id: logId.current,
      at: new Date().toLocaleTimeString(),
      kind,
      label,
      detail,
    };
    setEntries((current) => [entry, ...current].slice(0, 80));
  }, []);
  const refresh = useCallback(async (signal) => {
    try {
      const next = await fetchOrchestratorState(signal);
      if (!mounted.current) return;
      setState(next);
      setError(null);
    } catch (reason) {
      if (signal?.aborted || !mounted.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Failed to read orchestrator state",
      );
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), POLL_MS);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  /** Narrates a run response, one line per stage the backend reported. */
  const logRun = useCallback(
    (result) => {
      for (const step of result.steps) {
        if (!step.jobId) {
          const reason = step.stages[0]?.detail ?? "Nothing to do";
          log("info", "Idle", reason);
          continue;
        }
        for (const stage of step.stages) {
          log(
            stage.status === "FAILED" ? "error" : "stage",
            `${step.jobName} · ${stage.stage}`,
            stage.status === "SKIPPED"
              ? `skipped - ${stage.detail}`
              : stage.detail,
          );
        }
      }
      if (result.stoppedBecause && !BENIGN_STOPS.has(result.stoppedBecause)) {
        log("error", "Stopped", result.stoppedBecause);
      }
    },
    [log],
  );
  const act = useCallback(
    async (key, label, action) => {
      setBusy(key);
      try {
        await action();
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        log("error", label, message);
        setError(message);
      } finally {
        if (mounted.current) setBusy(null);
        await refresh();
      }
    },
    [log, refresh],
  );
  const onGenerate = () =>
    act("generate", "Generate", async () => {
      const batch = await generateWorkload(form);
      log(
        "info",
        "Workload generated",
        `${batch.jobCount} jobs · pattern ${batch.parameters.arrivalPattern ?? batch.pattern} · seed ${batch.seed}`,
      );
    });
  const onClearGenerated = () =>
    act("clear-generated", "Clear generated workload", async () => {
      const result = await clearGeneratedWorkload();
      log(
        "info",
        "Cleared generated workload",
        `${result.deletedJobs} unstarted generated job(s) removed`,
      );
      setSelectedJobId(null);
    });
  const onKillAll = () => {
    setAutoRunning(false);
    return act("kill-all", "Kill all workloads", async () => {
      const result = await killAllWorkloads();
      log(result.failures.length ? "error" : "info", "Kill all workloads",
        `${result.stoppedContainers} container(s) removed; ${result.cancelledExecutions} execution(s) and ${result.cancelledJobs} queued/scheduled job(s) cancelled; ${result.releasedReservations} reservation(s) released`);
      if (result.failures.length) {
        throw new Error(result.failures.map((failure) => failure.message).join("; "));
      }
      setSelectedJobId(null);
    });
  };
  const runOnce = useCallback(
    async () => {
      const current = settings.current;
      const result = await runOrchestrator({
        policy: current.policy,
        strategy: current.strategy,
        // One start per tick keeps study runs easy to follow and limits bursts.
        maxJobs: 1,
        ...(current.policy === "ROUND_ROBIN"
          ? { timeQuantumSeconds: current.timeQuantumSeconds }
          : {}),
      });
      logRun(result);
      return result;
    },
    [logRun],
  );
  // Auto-run: React only decides to keep asking; the backend decides what happens.
  useEffect(() => {
    if (!autoRunning) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const result = await runOnce();
        if (cancelled || !mounted.current) return;
        await refresh();
        const snapshot = await fetchOrchestratorState();
        // The queue displays a limited set of recent changes, not every job.
        const pending = ["CREATED", "QUEUED", "WAITING", "SCHEDULED", "RUNNING"]
          .reduce((total, status) => total + (snapshot.statusCounts[status] ?? 0), 0);
        if (pending === 0 && result.stoppedBecause === "NOTHING_ELIGIBLE") {
          setAutoRunning(false);
          log(
            "info",
            "Orchestrator idle",
            "Queue drained and no containers left running",
          );
        }
      } catch (reason) {
        if (cancelled) return;
        setAutoRunning(false);
        const message =
          reason instanceof Error ? reason.message : String(reason);
        log("error", "Auto run stopped", message);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), AUTO_TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [autoRunning, runOnce, refresh, log]);
  const onDemo = () =>
    act("generate", "Demo mode", async () => {
      const batch = await generateWorkload({
        ...DEFAULT_FORM,
        seed: form.seed,
      });
      setForm({ ...DEFAULT_FORM, seed: form.seed });
      log(
        "info",
        "Demo workload generated",
        `${batch.jobCount} sleep jobs · seed ${batch.seed} · all eligible immediately`,
      );
      setAutoRunning(true);
    });
  const onReset = () =>
    act("reset", "Clear finished", async () => {
      const result = await clearFinishedJobs();
      log(
        "info",
        "Cleared finished jobs",
        `${result.deletedJobs} job(s), ${result.deletedExecutions} execution(s) removed`,
      );
      setSelectedJobId(null);
    });
  const selected = state?.jobs.find((job) => job.id === selectedJobId) ?? null;
  return (
    <>
      <ControlPanel
        form={form}
        onFormChange={setForm}
        policy={policy}
        onPolicyChange={setPolicy}
        strategy={strategy}
        onStrategyChange={setStrategy}
        timeQuantumSeconds={timeQuantumSeconds}
        onTimeQuantumChange={setTimeQuantumSeconds}
        autoRunning={autoRunning}
        busy={busy}
        onGenerate={onGenerate}
        onKillAll={onKillAll}
        onClearGenerated={onClearGenerated}
        onToggleAuto={() => setAutoRunning((value) => !value)}
        onReset={onReset}
        onDemo={onDemo}
      />

      {error ? <p className="error-banner">{error}</p> : null}

      {state ? (
        <>
          <PipelineView stageCounts={state.stageCounts} selected={selected} />

          <div className="split">
            <WorkerGrid
              workers={state.workers}
              onSelectJob={setSelectedJobId}
            />
            <JobDetail
              job={selected}
              strategy={strategy}
              busy={busy}
              onPlace={(jobId) =>
                act("stage", "Placement", async () => {
                  await assignPlacement(jobId, strategy);
                  log(
                    "stage",
                    "Placement",
                    `Assigned ${jobId.slice(0, 8)} with ${strategy}`,
                  );
                })
              }
              onReserve={(jobId) =>
                act("stage", "Reservation", async () => {
                  await reserveResources(jobId);
                  log(
                    "stage",
                    "Reservation",
                    `Capacity committed for ${jobId.slice(0, 8)}`,
                  );
                })
              }
              onExecute={(jobId) =>
                act("stage", "Execution", async () => {
                  await startExecution(jobId);
                  log(
                    "stage",
                    "Execution",
                    `Container started for ${jobId.slice(0, 8)}`,
                  );
                })
              }
              onRelease={(jobId) =>
                act("stage", "Release", async () => {
                  await releaseResources(jobId);
                  log(
                    "stage",
                    "Release",
                    `Capacity released for ${jobId.slice(0, 8)}`,
                  );
                })
              }
              onCancel={(jobId) =>
                act("stage", "Cancel", async () => {
                  await cancelJob(jobId);
                  log("stage", "Cancel", `Job ${jobId.slice(0, 8)} cancelled`);
                })
              }
            />
          </div>

          <JobQueue
            jobs={state.jobs}
            totalJobs={state.totals.jobs}
            selectedJobId={selectedJobId}
            filter={filter}
            onFilterChange={setFilter}
            onSelectJob={setSelectedJobId}
          />

          <ActivityLog entries={entries} onClear={() => setEntries([])} />

          <p className="muted footnote">
            Reading backend state every {POLL_MS / 1000}s · last read{" "}
            {new Date(state.capturedAt).toLocaleTimeString()} ·{" "}
            {state.totals.jobs} job(s), {state.totals.activeReservations} active
            reservation(s), {state.totals.runningContainers} running
            container(s)
            {state.totals.waitingForArrival > 0
              ? ` · ${state.totals.waitingForArrival} waiting for arrival time`
              : ""}
          </p>
        </>
      ) : (
        <p className="muted">Loading orchestrator state…</p>
      )}
    </>
  );
}
