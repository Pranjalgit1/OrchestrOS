import { resolve } from "node:path";

import { config } from "dotenv";
import { z } from "zod";

config({
  path: resolve(process.cwd(), "../.env"),
  quiet: true,
});

/**
 * Docker Desktop exposes the daemon as a named pipe on Windows and as a unix
 * socket everywhere else, including inside the backend container.
 */
const defaultDockerSocketPath =
  process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.union([z.literal("127.0.0.1"), z.literal("0.0.0.0")]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://orchestr_os:orchestr_os@localhost:5432/orchestr_os?schema=public"),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  DOCKER_SOCKET_PATH: z.string().min(1).default(defaultDockerSocketPath),
  /** Wall-clock ceiling for one workload container, independent of its estimate. */
  EXECUTION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3_600).default(300),
  /** Per-stream cap on captured container output. */
  EXECUTION_LOG_LIMIT_BYTES: z.coerce.number().int().min(256).max(65_536).default(8_192),
  /** Utilization sampling period. Zero disables periodic sampling entirely. */
  MONITORING_SAMPLE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3_600).default(15),
  /** How long sampled history is kept. Zero keeps it forever. */
  MONITORING_SAMPLE_RETENTION_HOURS: z.coerce.number().int().min(0).max(8_760).default(24),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  console.error("Invalid environment configuration", parsedEnvironment.error.flatten().fieldErrors);
  throw new Error("Environment validation failed");
}

export const env = parsedEnvironment.data;
