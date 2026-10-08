import { baseEnvSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("payment-mock"),
  /** Prisma-style URL; its `?schema=` names the Postgres schema the payment tables live in. */
  DATABASE_URL: z.url(),
  /** Comma-separated host:port list. Redpanda locally; anything that speaks the Kafka protocol. */
  KAFKA_BROKERS: z.string().min(1),
  /** Probability a new mock charge fails; a stored charge is never re-rolled. */
  FAIL_RATE: z.coerce.number().min(0).max(1).default(0.2),
  /** Partitions of payments.commands handled at once; 1 means one charge in flight per process. */
  PAYMENT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(1),
});

export type Config = z.infer<typeof envSchema>;

/** Parsed once at startup; throws with the missing/invalid variables named. */
export const config: Config = loadEnv(envSchema);
