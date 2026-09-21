import { Router } from "express";

import { getHealthStatus } from "./health.service.js";

export const healthRouter = Router();

healthRouter.get("/", async (_request, response, next) => {
  try {
    const health = await getHealthStatus();
    response.status(health.status === "ok" ? 200 : 503).json(health);
  } catch (error) {
    next(error);
  }
});
