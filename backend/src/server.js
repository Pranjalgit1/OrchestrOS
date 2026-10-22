import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { executionService } from "./modules/executions/execution.service.js";
import { monitoringSampler } from "./modules/monitoring/monitoring.sampler.js";
import { autoscalerService } from "./modules/autoscaler/autoscaler.service.js";
import { ensureStudyWorkers } from "./modules/workers/worker.defaults.js";
import { benchmarkService } from "./modules/benchmarks/benchmark.service.js";
import { prismaBenchmarkRepository } from "./modules/benchmarks/benchmark.repository.js";
// Reconcile containers before accepting new start requests after a restart.
try {
  const recovery = await executionService.recover();
  if (recovery.checked) console.log("Execution recovery:", recovery);
} catch (error) {
  console.error("Execution recovery failed:", error.message);
}
try {
  await ensureStudyWorkers(prisma);
} catch (error) {
  console.error("Study worker setup failed:", error.message);
}
try {
  // A suite still RUNNING in the database lost its runner with the old process.
  const abandoned = await prismaBenchmarkRepository.abandonInterruptedSuites();
  if (abandoned) console.log(`Marked ${abandoned} interrupted benchmark(s) as aborted`);
} catch (error) {
  console.error("Benchmark recovery failed:", error.message);
}
const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`OrchestrOS backend listening on http://${env.HOST}:${env.PORT}`);
});
// Started here rather than in app.js so importing the app never starts a timer.
monitoringSampler.start();
autoscalerService.start();
if (autoscalerService.loopEnabled) {
  console.log(
    `Autoscaler evaluating every ${autoscalerService.intervalSeconds}s ` +
      `(${autoscalerService.config.enabled ? "enabled" : "disabled; toggle it from the dashboard"})`,
  );
}
if (monitoringSampler.enabled) {
  console.log(
    `Monitoring sampler running every ${env.MONITORING_SAMPLE_INTERVAL_SECONDS}s, ` +
      `keeping ${env.MONITORING_SAMPLE_RETENTION_HOURS}h of history`,
  );
} else {
  console.log(
    "Monitoring sampler disabled; capture samples with POST /api/monitoring/sample",
  );
}
let shuttingDown = false;
let recovering = false;
const recoveryTimer = setInterval(async () => {
  if (recovering || shuttingDown) return;
  recovering = true;
  try {
    const recovery = await executionService.recover();
    if (recovery.failures.length) console.error("Execution recovery:", recovery.failures);
    await ensureStudyWorkers(prisma);
  } catch (error) {
    console.error("Execution recovery failed:", error.message);
  } finally {
    recovering = false;
  }
}, 30_000);
recoveryTimer.unref();
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(recoveryTimer);
  console.log(`${signal} received; shutting down OrchestrOS backend`);
  monitoringSampler.stop();
  autoscalerService.stop();
  // Stop a running benchmark so it records itself as aborted before exit.
  if (benchmarkService.isRunning) {
    try {
      benchmarkService.abort(benchmarkService.active.suiteId);
    } catch {
      // It finished in the meantime.
    }
  }
  server.close(async (error) => {
    await benchmarkService.awaitCompletion();
    // Let running containers finish being recorded, otherwise their executions
    // would stay RUNNING and keep holding reservations.
    await executionService.awaitPendingSettlements();
    await prisma.$disconnect();
    if (error) {
      console.error("Backend shutdown failed", error);
      process.exit(1);
    }
    process.exit(0);
  });
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
