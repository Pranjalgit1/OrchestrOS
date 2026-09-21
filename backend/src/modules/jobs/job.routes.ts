import { Router } from "express";

import {
  createJobSchema,
  jobIdParamsSchema,
  listJobsQuerySchema,
} from "./job.schemas.js";
import { jobService } from "./job.service.js";

export const jobRouter = Router();

jobRouter.post("/", async (request, response) => {
  const input = createJobSchema.parse(request.body);
  const job = await jobService.create(input);

  response.location(`/api/jobs/${job.id}`).status(201).json(job);
});

jobRouter.get("/", async (request, response) => {
  const query = listJobsQuerySchema.parse(request.query);
  const jobs = await jobService.list(query);

  response.json(jobs);
});

jobRouter.get("/:id", async (request, response) => {
  const { id } = jobIdParamsSchema.parse(request.params);
  const job = await jobService.getById(id);

  response.json(job);
});

jobRouter.post("/:id/cancel", async (request, response) => {
  const { id } = jobIdParamsSchema.parse(request.params);
  const job = await jobService.cancel(id);

  response.json(job);
});
