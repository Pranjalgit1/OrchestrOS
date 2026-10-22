import { Router } from "express";
import { rejectWhileBenchmarking } from "../benchmarks/benchmark.guard.js";
import {
  createJobSchema,
  jobIdParamsSchema,
  listJobsQuerySchema,
} from "./job.schemas.js";
import { jobService } from "./job.service.js";
export const jobRouter = Router();
jobRouter.post("/", rejectWhileBenchmarking, async (request, response) => {
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
/** Cancels a job at any unfinished stage, stopping its container if it runs. */
jobRouter.post("/:id/cancel", rejectWhileBenchmarking, async (request, response) => {
  const { id } = jobIdParamsSchema.parse(request.params);
  const job = await jobService.cancel(id);
  response.json(job);
});
/** Returns a failed or interrupted job to the queue for another attempt. */
jobRouter.post("/:id/requeue", rejectWhileBenchmarking, async (request, response) => {
  const { id } = jobIdParamsSchema.parse(request.params);
  const job = await jobService.requeue(id);
  response.json(job);
});
