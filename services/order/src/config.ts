import { baseEnvSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("order"),
  /** Prisma-style URL; its `?schema=` names the Postgres schema the order tables live in. */
  DATABASE_URL: z.url(),
  /** Comma-separated host:port list. Redpanda locally; anything that speaks the Kafka protocol. */
  KAFKA_BROKERS: z.string().min(1),
});

export type Config = z.infer<typeof envSchema>;

/** Parsed once at startup; throws with the missing/invalid variables named. */
export const config: Config = loadEnv(envSchema);
