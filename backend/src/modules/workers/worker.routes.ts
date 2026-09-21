import { Router } from "express";

import { createWorkerSchema, workerIdParamsSchema } from "./worker.schemas.js";
import { workerService } from "./worker.service.js";

export const workerRouter = Router();

workerRouter.post("/", async (request, response) => {
  const input = createWorkerSchema.parse(request.body);
  const worker = await workerService.create(input);

  response.location(`/api/workers/${worker.id}`).status(201).json(worker);
});

workerRouter.get("/", async (_request, response) => {
  const workers = await workerService.list();
  response.json(workers);
});

workerRouter.get("/:id", async (request, response) => {
  const { id } = workerIdParamsSchema.parse(request.params);
  const worker = await workerService.getById(id);

  response.json(worker);
});
