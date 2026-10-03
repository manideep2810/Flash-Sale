import { availableParallelism } from "node:os";
import { baseEnvSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("ticket"),
  // Optional until the Redis and Postgres clients are wired in; validated whenever set.
  REDIS_URL: z.url().optional(),
  DATABASE_URL: z.url().optional(),
  // node:cluster fan-out (src/index.ts): workers sharing PORT. Default is one per logical CPU.
  WORKERS: z.coerce.number().int().min(1).default(availableParallelism()),
  // The cluster primary serves prom-client metrics aggregated across all workers on this port.
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
});

export type Config = z.infer<typeof envSchema>;

/** Parsed once at startup; throws with the missing/invalid variables named. */
export const config: Config = loadEnv(envSchema);
