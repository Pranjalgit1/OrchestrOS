import { useCallback, useEffect, useRef, useState } from "react";

import {
  assignPlacement,
  cancelJob,
  clearFinishedJobs,
  fetchOrchestratorState,
  generateWorkload,
  releaseResources,
  reserveResources,
  runOrchestrator,
  startExecution,
  type GenerateWorkloadRequest,
  type OrchestratorState,
  type PlacementStrategy,
  type RunOrchestratorResult,
  type SchedulingPolicy,
} from "./api";
import { ActivityLog, type ActivityEntry } from "./components/ActivityLog";
import { ControlPanel } from "./components/ControlPanel";
import { JobDetail } from "./components/JobDetail";
import { JobQueue, type StatusFilter } from "./components/JobQueue";
import { PipelineView } from "./components/PipelineView";
import { WorkerGrid } from "./components/WorkerGrid";

const POLL_MS = 1_500;
const AUTO_TICK_MS = 2_000;

/** Codes that mean "nothing to do right now" rather than a real problem. */
const BENIGN_STOPS = new Set(["NOTHING_ELIGIBLE", "INSUFFICIENT_RESOURCES"]);

const DEFAULT_FORM: GenerateWorkloadRequest = {
  count: 10,
  arrival: "IMMEDIATE",
  seed: 42,
  profile: "SLEEP",
  cpuMillicores: 800,
  memoryMiB: 256,
};

export function OrchestratorConsole() {
  const [state, setState] = useState<OrchestratorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [form, setForm] = useState<GenerateWorkloadRequest>(DEFAULT_FORM);
  const [policy, setPolicy] = useState<SchedulingPolicy>("FCFS");
  const [strategy, setStrategy] = useState<PlacementStrategy>("LEAST_LOADED");
  const [timeQuantumSeconds, setTimeQuantumSeconds] = useState(10);
  const [batchSize, setBatchSize] = useState(5);

  const [autoRunning, setAutoRunning] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  const mounted = useRef(true);
  const logId = useRef(0);
  // Kept in a ref so the auto-run timer always sees the current selections.
  const settings = useRef({ policy, strategy, timeQuantumSeconds, batchSize });
  settings.current = { policy, strategy, timeQuantumSeconds, batchSize };

  const log = useCallback((kind: ActivityEntry["kind"], label: string, detail: string) => {
    logId.current += 1;
    const entry: ActivityEntry = {
      id: logId.current,
      at: new Date().toLocaleTimeString(),
      kind,
      label,
      detail,
    };
    setEntries((current) => [entry, ...current].slice(0, 80));
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchOrchestratorState(signal);
      if (!mounted.current) return;
      setState(next);
      setError(null);
    } catch (reason) {
      if (signal?.aborted || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to read orchestrator state");
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
    (result: RunOrchestratorResult) => {
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
            stage.status === "SKIPPED" ? `skipped — ${stage.detail}` : stage.detail,
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
    async (key: string, label: string, action: () => Promise<void>) => {
      setBusy(key);
      try {
        await action();
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
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
        `${batch.jobCount} jobs · pattern ${batch.pattern} · seed ${batch.seed}`,
      );
    });

  const runOnce = useCallback(
    async (maxJobs: number) => {
      const current = settings.current;
      const result = await runOrchestrator({
        policy: current.policy,
        strategy: current.strategy,
        maxJobs,
        ...(current.policy === "ROUND_ROBIN"
          ? { timeQuantumSeconds: current.timeQuantumSeconds }
          : {}),
      });
      logRun(result);
      return result;
    },
    [logRun],
  );

  const onRunNext = () => act("run-next", "Run next", async () => void (await runOnce(1)));
  const onRunBatch = () =>
    act("run-batch", "Run batch", async () => void (await runOnce(batchSize)));

  // Auto-run: React only decides to keep asking; the backend decides what happens.
  useEffect(() => {
    if (!autoRunning) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await runOnce(settings.current.batchSize);
        if (cancelled || !mounted.current) return;
        await refresh();

        const snapshot = await fetchOrchestratorState();
        const pending =
          snapshot.stageCounts.QUEUE +
          snapshot.stageCounts.SCHEDULER +
          snapshot.stageCounts.PLACEMENT +
          snapshot.stageCounts.RESERVATION +
          snapshot.stageCounts.EXECUTION;

        if (pending === 0 && result.stoppedBecause === "NOTHING_ELIGIBLE") {
          setAutoRunning(false);
          log("info", "Orchestrator idle", "Queue drained and no containers left running");
        }
      } catch (reason) {
        if (cancelled) return;
        setAutoRunning(false);
        const message = reason instanceof Error ? reason.message : String(reason);
        log("error", "Auto run stopped", message);
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
      const batch = await generateWorkload({ ...DEFAULT_FORM, seed: form.seed });
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
        batchSize={batchSize}
        onBatchSizeChange={setBatchSize}
        autoRunning={autoRunning}
        busy={busy}
        onGenerate={onGenerate}
        onRunNext={onRunNext}
        onRunBatch={onRunBatch}
        onToggleAuto={() => setAutoRunning((value) => !value)}
        onReset={onReset}
        onDemo={onDemo}
      />

      {error ? <p className="error-banner">{error}</p> : null}

      {autoRunning ? (
        <p className="running-banner">
          Orchestrator is running automatically — asking the backend for the next job every{" "}
          {AUTO_TICK_MS / 1000}s.
        </p>
      ) : null}

      {state ? (
        <>
          <PipelineView stageCounts={state.stageCounts} selected={selected} />

          <div className="split">
            <WorkerGrid workers={state.workers} onSelectJob={setSelectedJobId} />
            <JobDetail
              job={selected}
              strategy={strategy}
              busy={busy}
              onPlace={(jobId) =>
                act("stage", "Placement", async () => {
                  await assignPlacement(jobId, strategy);
                  log("stage", "Placement", `Assigned ${jobId.slice(0, 8)} with ${strategy}`);
                })
              }
              onReserve={(jobId) =>
                act("stage", "Reservation", async () => {
                  await reserveResources(jobId);
                  log("stage", "Reservation", `Capacity committed for ${jobId.slice(0, 8)}`);
                })
              }
              onExecute={(jobId) =>
                act("stage", "Execution", async () => {
                  await startExecution(jobId);
                  log("stage", "Execution", `Container started for ${jobId.slice(0, 8)}`);
                })
              }
              onRelease={(jobId) =>
                act("stage", "Release", async () => {
                  await releaseResources(jobId);
                  log("stage", "Release", `Capacity released for ${jobId.slice(0, 8)}`);
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
            selectedJobId={selectedJobId}
            filter={filter}
            onFilterChange={setFilter}
            onSelectJob={setSelectedJobId}
          />

          <ActivityLog entries={entries} onClear={() => setEntries([])} />

          <p className="muted footnote">
            Reading backend state every {POLL_MS / 1000}s · last read{" "}
            {new Date(state.capturedAt).toLocaleTimeString()} · {state.totals.jobs} job(s),{" "}
            {state.totals.activeReservations} active reservation(s),{" "}
            {state.totals.runningContainers} running container(s)
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
