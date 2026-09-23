import { Router } from "express";

import {
  assignPlacementSchema,
  previewPlacementQuerySchema,
} from "./placement.schemas.js";
import { placementService } from "./placement.service.js";

export const placementRouter = Router();

placementRouter.get("/capacity", async (_request, response) => {
  response.json(await placementService.capacity());
});

placementRouter.get("/preview", async (request, response) => {
  const query = previewPlacementQuerySchema.parse(request.query);
  response.json(await placementService.preview(query));
});

placementRouter.post("/assign", async (request, response) => {
  const input = assignPlacementSchema.parse(request.body ?? {});
  response.json(await placementService.assign(input));
});
