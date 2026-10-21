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
  process.platform === "win32"
    ? "//./pipe/docker_engine"
    : "/var/run/docker.sock";
const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z
    .union([z.literal("127.0.0.1"), z.literal("0.0.0.0")])
    .default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z
    .string()
    .startsWith("mysql://")
    .default("mysql://orchestr_os:orchestr_os@localhost:3306/orchestr_os"),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  DOCKER_SOCKET_PATH: z.string().min(1).default(defaultDockerSocketPath),
  /** Wall-clock ceiling for one workload container, independent of its estimate. */
  EXECUTION_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(3_600)
    .default(300),
  /**
   * How many times one job may be evicted by Round Robin quantum expiry. After
   * that it runs to completion, so a long job cannot be restarted forever.
   * Zero disables preemption.
   */
  ROUND_ROBIN_MAX_PREEMPTIONS: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(3),
  /** Automatic requeues allowed for executions lost to infrastructure faults. */
  EXECUTION_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  /** Starting state of reactive autoscaling; it can be toggled at runtime. */
  AUTOSCALE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** How often the autoscaler evaluates the cluster. Zero disables the loop. */
  AUTOSCALE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3_600).default(5),
  /** Most autoscaled workers that may be in service at once. */
  AUTOSCALE_MAX_WORKERS: z.coerce.number().int().min(0).max(20).default(3),
  /** Capacity given to each autoscaled worker. */
  AUTOSCALE_WORKER_CPU_MILLICORES: z.coerce.number().int().min(100).max(64_000).default(1_000),
  AUTOSCALE_WORKER_MEMORY_MIB: z.coerce.number().int().min(128).max(131_072).default(512),
  /** Per-stream cap on captured container output. */
  EXECUTION_LOG_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(256)
    .max(65_536)
    .default(8_192),
  /** Utilization sampling period. Zero disables periodic sampling entirely. */
  MONITORING_SAMPLE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600)
    .default(15),
  /** How long sampled history is kept. Zero keeps it forever. */
  MONITORING_SAMPLE_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(0)
    .max(8_760)
    .default(24),
});
const parsedEnvironment = environmentSchema.safeParse(process.env);
if (!parsedEnvironment.success) {
  console.error(
    "Invalid environment configuration",
    parsedEnvironment.error.flatten().fieldErrors,
  );
  throw new Error("Environment validation failed");
}
export const env = parsedEnvironment.data;
