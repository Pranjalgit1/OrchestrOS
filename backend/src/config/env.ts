import { resolve } from "node:path";

import { config } from "dotenv";
import { z } from "zod";

config({
  path: resolve(process.cwd(), "../.env"),
  quiet: true,
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.union([z.literal("127.0.0.1"), z.literal("0.0.0.0")]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://orchestr_os:orchestr_os@localhost:5432/orchestr_os?schema=public"),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  console.error("Invalid environment configuration", parsedEnvironment.error.flatten().fieldErrors);
  throw new Error("Environment validation failed");
}

export const env = parsedEnvironment.data;
