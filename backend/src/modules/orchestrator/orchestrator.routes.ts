import { Router } from "express";

import {
  orchestratorStateQuerySchema,
  runOrchestratorSchema,
} from "./orchestrator.schemas.js";
import { orchestratorService } from "./orchestrator.service.js";

export const orchestratorRouter = Router();

/**
 * Runs the pipeline for up to `maxJobs` jobs.
 *
 * This is what the dashboard calls. The individual stage endpoints
 * (`/api/scheduler/dispatch`, `/api/placement/assign`, `/api/resources/reserve`,
 * `/api/executions/start`) remain available and unchanged for debugging and for
 * demonstrating one stage at a time.
 */
orchestratorRouter.post("/run", async (request, response) => {
  const input = runOrchestratorSchema.parse(request.body ?? {});
  response.status(202).json(await orchestratorService.run(input));
});

/** Everything the dashboard needs to render, in one consistent read. */
orchestratorRouter.get("/state", async (request, response) => {
  const query = orchestratorStateQuerySchema.parse(request.query);
  response.json(await orchestratorService.state(query));
});

/**
 * Removes finished jobs so a demonstration can start from a clean queue.
 * Running and reserved work is left untouched.
 */
orchestratorRouter.post("/clear-finished", async (_request, response) => {
  response.json(await orchestratorService.clearFinished());
});
