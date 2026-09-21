import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { env } from "./config/env.js";
import { AppError } from "./errors/app-error.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { jobRouter } from "./modules/jobs/job.routes.js";
import { schedulerRouter } from "./modules/scheduler/scheduler.routes.js";
import { workloadRouter } from "./modules/workloads/workload.routes.js";
import { workerRouter } from "./modules/workers/worker.routes.js";

export const app = express();

app.disable("x-powered-by");
app.use(
  cors({
    origin: env.CORS_ORIGIN,
  }),
);
app.use(express.json({ limit: "16kb" }));

app.get("/api", (_request, response) => {
  response.json({
    name: "OrchestrOS API",
    phase: 3,
    status: "scheduling-ready",
  });
});
app.use("/api/health", healthRouter);
app.use("/api/jobs", jobRouter);
app.use("/api/workloads", workloadRouter);
app.use("/api/scheduler", schedulerRouter);
app.use("/api/workers", workerRouter);

app.use((_request, response) => {
  response.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "Route not found",
    },
  });
});

interface RequestBodyError extends Error {
  status?: number;
  type?: string;
}

function isRequestBodyError(error: unknown): error is RequestBodyError {
  return error instanceof Error && "type" in error;
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (isRequestBodyError(error) && error.type === "entity.too.large") {
    response.status(413).json({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the 16 KB limit",
      },
    });
    return;
  }

  if (isRequestBodyError(error) && error.type === "entity.parse.failed") {
    response.status(400).json({
      error: {
        code: "MALFORMED_JSON",
        message: "Request body contains invalid JSON",
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  console.error(error);
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
};

app.use(errorHandler);
