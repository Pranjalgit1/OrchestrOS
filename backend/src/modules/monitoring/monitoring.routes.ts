import { Router } from "express";

import { env } from "../../config/env.js";
import {
  jobMetricsQuerySchema,
  sampleHistoryQuerySchema,
} from "./monitoring.schemas.js";
import { monitoringService } from "./monitoring.service.js";

export const monitoringRouter = Router();

/** Live cluster, queue, and execution state as one consistent read. */
monitoringRouter.get("/overview", async (_request, response) => {
  response.json(await monitoringService.overview());
});

/** Job lifecycle timings and completion rate over a bounded window. */
monitoringRouter.get("/jobs", async (request, response) => {
  const query = jobMetricsQuerySchema.parse(request.query);
  response.json(await monitoringService.jobMetrics(query));
});

/** Recorded utilization history, collapsed into cluster points over time. */
monitoringRouter.get("/samples", async (request, response) => {
  const query = sampleHistoryQuerySchema.parse(request.query);
  response.json(await monitoringService.sampleHistory(query));
});

/** Reports how sampling is configured, so the dashboard can explain gaps. */
monitoringRouter.get("/config", (_request, response) => {
  response.json({
    sampleIntervalSeconds: env.MONITORING_SAMPLE_INTERVAL_SECONDS,
    sampleRetentionHours: env.MONITORING_SAMPLE_RETENTION_HOURS,
    periodicSamplingEnabled: env.MONITORING_SAMPLE_INTERVAL_SECONDS > 0,
  });
});

/** Records one sampling pass immediately, independent of the periodic timer. */
monitoringRouter.post("/sample", async (_request, response) => {
  const result = await monitoringService.captureSample(
    env.MONITORING_SAMPLE_RETENTION_HOURS,
  );
  response.status(201).json(result);
});
