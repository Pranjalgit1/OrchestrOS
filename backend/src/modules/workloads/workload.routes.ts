import { Router } from "express";

import {
  generateWorkloadSchema,
  reuseWorkloadSchema,
  workloadBatchIdParamsSchema,
} from "./workload.schemas.js";
import { workloadService } from "./workload.service.js";

export const workloadRouter = Router();

workloadRouter.post("/generate", async (request, response) => {
  const input = generateWorkloadSchema.parse(request.body);
  const batch = await workloadService.generate(input);
  response.location(`/api/workloads/${batch.id}`).status(201).json(batch);
});

workloadRouter.get("/:id", async (request, response) => {
  const { id } = workloadBatchIdParamsSchema.parse(request.params);
  const batch = await workloadService.getById(id);
  response.json(batch);
});

workloadRouter.post("/:id/reuse", async (request, response) => {
  const { id } = workloadBatchIdParamsSchema.parse(request.params);
  const input = reuseWorkloadSchema.parse(request.body ?? {});
  const batch = await workloadService.reuse(id, input);
  response.location(`/api/workloads/${batch.id}`).status(201).json(batch);
});
