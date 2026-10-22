import { ConflictError } from "../../errors/app-error.js";
import { benchmarkService } from "./benchmark.service.js";

/**
 * Route middleware for actions that would change what a running benchmark
 * measures: adding or clearing jobs, advancing the pipeline by hand, or
 * changing the autoscaler. The benchmark calls the services directly, so its
 * own work is never blocked. Stopping all workloads stays allowed; it is the
 * emergency stop, and the benchmark records the run as aborted.
 */
export function rejectWhileBenchmarking(_request, _response, next) {
  if (benchmarkService.isRunning) {
    next(new ConflictError(
      "A policy benchmark is running. Wait for it to finish or stop it first.",
      "BENCHMARK_RUNNING",
    ));
    return;
  }
  next();
}
