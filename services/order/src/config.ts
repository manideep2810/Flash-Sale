import { baseEnvSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("order"),
  // Optional until the Postgres and Kafka clients are wired in; validated whenever set.
  DATABASE_URL: z.url().optional(),
  /** Comma-separated host:port list. */
  KAFKA_BROKERS: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

/** Parsed once at startup; throws with the missing/invalid variables named. */
export const config: Config = loadEnv(envSchema);
