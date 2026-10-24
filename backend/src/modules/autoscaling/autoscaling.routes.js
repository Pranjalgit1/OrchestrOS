import { Router } from "express";
import { autoScalingConfigSchema, triggerAutoScalingSchema } from "./autoscaling.schemas.js";
import { autoScalingService } from "./autoscaling.service.js";

export const autoScalingRouter = Router();

/** Returns current scaler mode, config, live metrics, and recent decisions. */
autoScalingRouter.get("/status", async (_request, response) => {
  const status = await autoScalingService.getStatus();
  response.json(status);
});

/** Update scaler configuration (mode, thresholds, worker bounds). */
autoScalingRouter.post("/config", (request, response) => {
  const updates = autoScalingConfigSchema.parse(request.body);
  const config = autoScalingService.updateConfig(updates);
  response.json({ updated: true, config });
});

/**
 * Manually trigger an evaluation cycle.
 * Supports dry-run mode: evaluates and returns what would happen without making changes.
 */
autoScalingRouter.post("/trigger", async (request, response) => {
  const { dryRun } = triggerAutoScalingSchema.parse(request.body ?? {});
  const decisions = await autoScalingService.evaluate(dryRun);
  response.status(200).json({ dryRun, decisions });
});
