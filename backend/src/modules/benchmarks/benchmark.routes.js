import { Router } from "express";
import {
  benchmarkIdParamsSchema,
  listBenchmarksQuerySchema,
  startBenchmarkSchema,
} from "./benchmark.schemas.js";
import { benchmarkService } from "./benchmark.service.js";

export const benchmarkRouter = Router();

/** Recent suites, newest first, each with its comparison. */
benchmarkRouter.get("/", async (request, response) => {
  const query = listBenchmarksQuerySchema.parse(request.query);
  response.json(await benchmarkService.list(query.limit));
});

/** Starts a suite and returns at once; poll GET /:id for progress. */
benchmarkRouter.post("/", async (request, response) => {
  const input = startBenchmarkSchema.parse(request.body ?? {});
  const suite = await benchmarkService.start(input);
  response.location(`/api/benchmarks/${suite.id}`).status(202).json(suite);
});

benchmarkRouter.get("/:id", async (request, response) => {
  const { id } = benchmarkIdParamsSchema.parse(request.params);
  response.json(await benchmarkService.get(id));
});

/** Stops a running suite; the current run's jobs are cancelled and recorded. */
benchmarkRouter.post("/:id/abort", async (request, response) => {
  const { id } = benchmarkIdParamsSchema.parse(request.params);
  response.status(202).json(benchmarkService.abort(id));
});
