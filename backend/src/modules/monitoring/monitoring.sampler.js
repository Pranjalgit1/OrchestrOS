import { env } from "../../config/env.js";
import { monitoringService } from "./monitoring.service.js";
/**
 * Periodic utilization sampler.
 *
 * This is the project's only background loop, and it is deliberately confined to
 * observation: it writes `worker_samples` and prunes old ones, and touches no
 * orchestration state. It is started by `server.js` rather than by `app.js`, so
 * importing the Express app (as every test does) never starts a timer.
 */
export class MonitoringSampler {
  service;
  intervalSeconds;
  retentionHours;
  timer = null;
  running = false;
  constructor(
    service = monitoringService,
    intervalSeconds = env.MONITORING_SAMPLE_INTERVAL_SECONDS,
    retentionHours = env.MONITORING_SAMPLE_RETENTION_HOURS,
  ) {
    this.service = service;
    this.intervalSeconds = intervalSeconds;
    this.retentionHours = retentionHours;
  }
  get enabled() {
    return this.intervalSeconds > 0;
  }
  get active() {
    return this.timer !== null;
  }
  /** Starts sampling. A zero interval means monitoring history is opt-in only. */
  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.intervalSeconds * 1_000);
    // The sampler must never be the reason the process stays alive.
    this.timer.unref();
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
  /**
   * One sampling pass, guarded so a slow database cannot overlap passes.
   *
   * A failure is logged and skipped: a missed observation must never take the
   * orchestrator down with it.
   */
  async sampleOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.captureSample(this.retentionHours);
    } catch (error) {
      console.error(
        "Monitoring sample failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running = false;
    }
  }
}
export const monitoringSampler = new MonitoringSampler();
