import { Router } from "express";
import { rejectWhileBenchmarking } from "../benchmarks/benchmark.guard.js";
import { updateAutoscalerSchema } from "./autoscaler.schemas.js";
import { autoscalerService } from "./autoscaler.service.js";
export const autoscalerRouter = Router();
/** Settings, the latest decision, and recent scaling events. */
autoscalerRouter.get("/", async (_request, response) => {
  response.json(await autoscalerService.status());
});
/** Changes runtime settings, such as turning autoscaling on or off. */
autoscalerRouter.patch("/", rejectWhileBenchmarking, async (request, response) => {
  const patch = updateAutoscalerSchema.parse(request.body ?? {});
  autoscalerService.updateConfig(patch);
  response.json(await autoscalerService.status());
});
/** Runs one evaluation now instead of waiting for the next timer pass. */
autoscalerRouter.post("/evaluate", async (_request, response) => {
  response.json(await autoscalerService.evaluate());
});
