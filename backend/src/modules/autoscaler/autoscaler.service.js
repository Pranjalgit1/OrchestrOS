import { totalmem } from "node:os";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app-error.js";
import { HOST_MEMORY_FRACTION, ScaleAction, decideScaling } from "./autoscaler.policy.js";
import { prismaAutoscalerRepository } from "./autoscaler.repository.js";
/** Thresholds start here; capacity and limits come from the environment. */
export function defaultAutoscalerConfig() {
  return {
    enabled: env.AUTOSCALE_ENABLED,
    maxWorkers: env.AUTOSCALE_MAX_WORKERS,
    workerCpuMillicores: env.AUTOSCALE_WORKER_CPU_MILLICORES,
    workerMemoryMiB: env.AUTOSCALE_WORKER_MEMORY_MIB,
    scaleUpQueueThreshold: 2,
    scaleUpUtilization: 0.75,
    scaleDownUtilization: 0.4,
    idleSeconds: 30,
    cooldownSeconds: 15,
  };
}
const EVENT_HISTORY = 20;
/**
 * Reactive autoscaler for logical workers.
 *
 * Each pass reads one snapshot, makes one pure decision, and applies at most
 * one change in a transaction that also records why. Passes never overlap, and
 * like the monitoring sampler the loop is started by `server.js`, so importing
 * the app in tests never starts a timer. Settings changed at runtime last until
 * the backend restarts; the scaling history is kept in MySQL.
 */
export class AutoscalerService {
  repository;
  config;
  intervalSeconds;
  clock;
  hostMemoryMiB;
  timer = null;
  running = false;
  lastDecision = null;
  constructor(
    repository = prismaAutoscalerRepository,
    {
      config = defaultAutoscalerConfig(),
      intervalSeconds = env.AUTOSCALE_INTERVAL_SECONDS,
      clock = () => new Date(),
      hostMemoryMiB = () => Math.floor(totalmem() / 1024 / 1024),
    } = {},
  ) {
    this.repository = repository;
    this.config = { ...config };
    this.intervalSeconds = intervalSeconds;
    this.clock = clock;
    this.hostMemoryMiB = hostMemoryMiB;
  }
  get loopEnabled() {
    return this.intervalSeconds > 0;
  }
  start() {
    if (!this.loopEnabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1_000);
    this.timer.unref();
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
  /** A timer pass: failures are logged, never thrown, so the loop survives. */
  async tick() {
    try {
      await this.evaluate();
    } catch (error) {
      console.error("Autoscaler pass failed:", error instanceof Error ? error.message : error);
    }
  }
  updateConfig(patch) {
    const next = { ...this.config, ...patch };
    if (next.scaleDownUtilization >= next.scaleUpUtilization) {
      throw new AppError(
        "scaleDownUtilization must be below scaleUpUtilization, or the cluster would flap",
        400,
        "INVALID_AUTOSCALER_CONFIG",
      );
    }
    this.config = next;
    return this.config;
  }
  /** One evaluation; applies the decision unless another pass is running. */
  async evaluate() {
    if (this.running) {
      return { action: ScaleAction.NONE, reason: "Another evaluation is in progress", applied: false };
    }
    this.running = true;
    try {
      const now = this.clock();
      const snapshot = await this.repository.readSnapshot(now);
      const decision = decideScaling(
        { ...snapshot, hostMemoryLimitMiB: Math.floor(this.hostMemoryMiB() * HOST_MEMORY_FRACTION) },
        this.config,
        now,
      );
      let outcome = null;
      if (decision.action === ScaleAction.SCALE_UP) {
        outcome = await this.repository.scaleUp(decision, {
          cpuMillicores: this.config.workerCpuMillicores,
          memoryMiB: this.config.workerMemoryMiB,
        });
      } else if (decision.action === ScaleAction.SCALE_DOWN) {
        outcome = await this.repository.scaleDown(decision);
      }
      const applied = outcome?.status === "SCALED";
      this.lastDecision = {
        ...decision,
        applied,
        // A stale or busy target means the cluster changed under the decision;
        // the next pass decides again from fresh data.
        ...(outcome && !applied ? { reason: `${decision.reason} (skipped: target ${outcome.status.toLowerCase()})` } : {}),
        evaluatedAt: now.toISOString(),
      };
      return this.lastDecision;
    } finally {
      this.running = false;
    }
  }
  async status() {
    const events = await this.repository.listEvents(EVENT_HISTORY);
    return {
      config: this.config,
      loop: { enabled: this.loopEnabled, intervalSeconds: this.intervalSeconds },
      hostMemoryLimitMiB: Math.floor(this.hostMemoryMiB() * HOST_MEMORY_FRACTION),
      lastDecision: this.lastDecision,
      events,
    };
  }
}
export const autoscalerService = new AutoscalerService();
