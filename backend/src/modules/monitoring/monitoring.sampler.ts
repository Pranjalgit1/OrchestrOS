import { env } from "../../config/env.js";
import { monitoringService, type SampleCaptureResult } from "./monitoring.service.js";

/** The only capability the sampler needs, so it can be driven by a test double. */
export interface SampleRecorder {
  captureSample(retentionHours: number): Promise<SampleCaptureResult>;
}

/**
 * Periodic utilization sampler.
 *
 * This is the project's only background loop, and it is deliberately confined to
 * observation: it writes `worker_samples` and prunes old ones, and touches no
 * orchestration state. It is started by `server.ts` rather than by `app.ts`, so
 * importing the Express app (as every test does) never starts a timer.
 */
export class MonitoringSampler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly service: SampleRecorder = monitoringService,
    private readonly intervalSeconds: number = env.MONITORING_SAMPLE_INTERVAL_SECONDS,
    private readonly retentionHours: number = env.MONITORING_SAMPLE_RETENTION_HOURS,
  ) {}

  get enabled(): boolean {
    return this.intervalSeconds > 0;
  }

  get active(): boolean {
    return this.timer !== null;
  }

  /** Starts sampling. A zero interval means monitoring history is opt-in only. */
  start(): void {
    if (!this.enabled || this.timer) return;

    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.intervalSeconds * 1_000);

    // The sampler must never be the reason the process stays alive.
    this.timer.unref();
  }

  stop(): void {
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
  async sampleOnce(): Promise<void> {
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
