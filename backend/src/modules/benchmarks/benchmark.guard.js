import { ConflictError } from "../../errors/app-error.js";
import { runningExperiment, sentenceStart } from "./experiment.registry.js";
// Imported for its registration, so the guard works even if nothing else loaded it.
import "./benchmark.service.js";

/**
 * Route middleware for actions that would change what a running experiment
 * measures: adding or clearing jobs, advancing the pipeline by hand, or
 * changing the autoscaler. A policy benchmark and an autoscaling comparison
 * both call the services directly, so their own work is never blocked.
 * Stopping all workloads stays allowed; it is the emergency stop, and the
 * experiment records the run as aborted.
 */
export function rejectWhileBenchmarking(_request, _response, next) {
  const running = runningExperiment();
  if (running) {
    next(new ConflictError(
      `${sentenceStart(running)} is running. Wait for it to finish or stop it first.`,
      "BENCHMARK_RUNNING",
    ));
    return;
  }
  next();
}
