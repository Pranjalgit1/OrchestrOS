import { Router } from "express";
import { comparisonSimulateSchema } from "./comparison.schemas.js";
import { compareAlgorithms } from "./comparison.service.js";

export const comparisonRouter = Router();

/**
 * Simulate multiple scheduling policies against the same deterministic workload.
 * Returns per-policy metrics and per-job breakdowns. No DB writes.
 *
 * Body: { seed, count, pattern, policies, timeQuantumSeconds? }
 */
comparisonRouter.post("/simulate", (request, response) => {
  const input = comparisonSimulateSchema.parse(request.body ?? {});
  const comparison = compareAlgorithms(input);
  response.json(comparison);
});
