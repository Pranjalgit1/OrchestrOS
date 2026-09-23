import { Router } from "express";

import {
  executionIdParamsSchema,
  listExecutionsQuerySchema,
  startExecutionSchema,
} from "./execution.schemas.js";
import { executionService } from "./execution.service.js";

export const executionRouter = Router();

/** Reports what the container runtime looks like from the backend's side. */
executionRouter.get("/runtime", async (_request, response) => {
  response.json(await executionService.describeRuntime());
});

executionRouter.get("/", async (request, response) => {
  const query = listExecutionsQuerySchema.parse(request.query);
  response.json(await executionService.list(query));
});

/**
 * Starts a container for a reserved job and returns before it finishes. The run
 * settles on its own; poll the execution to observe the outcome.
 */
executionRouter.post("/start", async (request, response) => {
  const input = startExecutionSchema.parse(request.body ?? {});
  const result = await executionService.start(input.jobId);
  response.status(202).json(result);
});

/** Recovery path: record an already-exited container that was never settled. */
executionRouter.post("/:executionId/settle", async (request, response) => {
  const params = executionIdParamsSchema.parse(request.params);
  response.json(await executionService.settle(params.executionId));
});

executionRouter.get("/:executionId", async (request, response) => {
  const params = executionIdParamsSchema.parse(request.params);
  response.json(await executionService.get(params.executionId));
});
