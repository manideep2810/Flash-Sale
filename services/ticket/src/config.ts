import { availableParallelism } from "node:os";
import { baseEnvSchema, hmacSecretSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const MIN_SECRET_BYTES = 32;

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("ticket"),
  // Optional until the Redis and Postgres clients are wired in; validated whenever set.
  REDIS_URL: z.url().optional(),
  DATABASE_URL: z.url().optional(),
  // node:cluster fan-out (src/index.ts): workers sharing PORT. Default is one per logical CPU.
  WORKERS: z.coerce.number().int().min(1).default(availableParallelism()),
  // The cluster primary serves prom-client metrics aggregated across all workers on this port.
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  // Verifies the caller's session on /redis/reserve. The same value order-api signs sessions with.
  SESSION_SECRET: hmacSecretSchema,
  // Verifies the admission token on /redis/reserve (src/admission.ts). It has to be the value
  // queue-svc signs with, and HS256 needs at least as many bytes as the hash is wide.
  ADMISSION_SECRET: z
    .string()
    .refine((secret) => Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES, {
      error: `must be at least ${MIN_SECRET_BYTES} bytes`,
    }),
  // false skips the admission check, for raw-capacity benchmarks only. Never in production.
  REQUIRE_ADMISSION: z.stringbool().default(true),
});

export type Config = z.infer<typeof envSchema>;

/** Called once at startup (src/index.ts); throws with the missing/invalid variables named. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = loadEnv(envSchema, env);
  if (!config.REQUIRE_ADMISSION && config.NODE_ENV === "production") {
    throw new Error(
      "REQUIRE_ADMISSION=false is not allowed with NODE_ENV=production: " +
        "/redis/reserve would accept callers the waiting room never admitted",
    );
  }
  return config;
}
