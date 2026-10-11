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
  // Cover-image uploads from the admin page (src/catalogue/uploads.ts). All three or none: without
  // them the catalogue works and the admin pastes an image URL instead. The secret signs uploads
  // and never leaves this service.
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  // Where in the Cloudinary account the covers go.
  CLOUDINARY_FOLDER: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
    .default("flash-sale/events"),
});

export type Config = z.infer<typeof envSchema>;

const CLOUDINARY = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
] as const;

/** Called once at startup (src/index.ts); throws with the missing/invalid variables named. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = loadEnv(envSchema, env);
  const missing = CLOUDINARY.filter((name) => !config[name]);
  if (missing.length > 0 && missing.length < CLOUDINARY.length) {
    throw new Error(
      `Cloudinary is half configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        "not set. Set all three, or none to leave image uploads off.",
    );
  }
  if (!config.REQUIRE_ADMISSION && config.NODE_ENV === "production") {
    throw new Error(
      "REQUIRE_ADMISSION=false is not allowed with NODE_ENV=production: " +
        "/redis/reserve would accept callers the waiting room never admitted",
    );
  }
  return config;
}
