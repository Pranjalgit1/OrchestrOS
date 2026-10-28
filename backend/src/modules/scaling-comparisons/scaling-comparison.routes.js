import { Router } from "express";
import {
  listScalingComparisonsQuerySchema,
  scalingComparisonIdParamsSchema,
  startScalingComparisonSchema,
} from "./scaling-comparison.schemas.js";
import { scalingComparisonService } from "./scaling-comparison.service.js";

export const scalingComparisonRouter = Router();

/** Recent comparisons, newest first, each with its result but no timeline. */
scalingComparisonRouter.get("/", async (request, response) => {
  const query = listScalingComparisonsQuerySchema.parse(request.query);
  response.json(await scalingComparisonService.list(query.limit));
});

/** Starts a Reactive-then-ML comparison and returns at once; poll GET /:id for progress. */
scalingComparisonRouter.post("/", async (request, response) => {
  const input = startScalingComparisonSchema.parse(request.body ?? {});
  const comparison = await scalingComparisonService.start(input);
  response.location(`/api/scaling-comparisons/${comparison.id}`).status(202).json(comparison);
});

/** One comparison with both runs' timelines. */
scalingComparisonRouter.get("/:id", async (request, response) => {
  const { id } = scalingComparisonIdParamsSchema.parse(request.params);
  response.json(await scalingComparisonService.get(id));
});

/** Stops a running comparison; the current run's jobs are cancelled and recorded. */
scalingComparisonRouter.post("/:id/abort", async (request, response) => {
  const { id } = scalingComparisonIdParamsSchema.parse(request.params);
  response.status(202).json(scalingComparisonService.abort(id));
});
