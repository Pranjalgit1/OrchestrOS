import { Router } from "express";

import {
  listAllocationsQuerySchema,
  releaseResourcesSchema,
  reserveResourcesSchema,
} from "./resource.schemas.js";
import { resourceService } from "./resource.service.js";

export const resourceRouter = Router();

resourceRouter.post("/reserve", async (request, response) => {
  const input = reserveResourcesSchema.parse(request.body ?? {});
  const result = await resourceService.reserve(input);
  response.status(201).json(result);
});

resourceRouter.post("/release", async (request, response) => {
  const input = releaseResourcesSchema.parse(request.body ?? {});
  response.json(await resourceService.release(input));
});

resourceRouter.get("/allocations", async (request, response) => {
  const query = listAllocationsQuerySchema.parse(request.query);
  response.json(await resourceService.listAllocations(query));
});
