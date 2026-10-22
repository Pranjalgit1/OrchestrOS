import { Router } from "express";
import { rejectWhileBenchmarking } from "../benchmarks/benchmark.guard.js";
import { dispatchSchema, previewQuerySchema } from "./scheduler.schemas.js";
import { schedulerService } from "./scheduler.service.js";
export const schedulerRouter = Router();
schedulerRouter.get("/preview", async (request, response) => {
  const query = previewQuerySchema.parse(request.query);
  response.json(await schedulerService.preview(query));
});
schedulerRouter.post("/dispatch", rejectWhileBenchmarking, async (request, response) => {
  const input = dispatchSchema.parse(request.body ?? {});
  response.json(await schedulerService.dispatch(input));
});
