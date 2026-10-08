import { baseEnvSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("order"),
  /** Prisma-style URL; its `?schema=` names the Postgres schema the order tables live in. */
  DATABASE_URL: z.url(),
  /** Comma-separated host:port list. Redpanda locally; anything that speaks the Kafka protocol. */
  KAFKA_BROKERS: z.string().min(1),
  /** What every order is charged, in the smallest currency unit (orders carry no price yet). */
  PAY_AMOUNT: z.coerce.number().int().positive().default(999),
  /** How often the timeout job looks for HELD orders past their hold. */
  TIMEOUT_JOB_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  /** A PAYMENT_PENDING order whose request is older than this is asked about again. */
  PAYMENT_STALE_SEC: z.coerce.number().int().positive().default(60),
  /** Period of the payment-request sweeper and the hold-settlement sweeper. */
  SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Port of the worker process's probes and /metrics (PORT is the API's). */
  WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3006),
  /** Partitions the payment-result and hold-settlement consumers handle at once; 1 means one message at a time. */
  RESULT_CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(1),
  /** Redis holding the holds and inventory; required by the worker, which settles holds. */
  REDIS_URL: z.url().optional(),
});

export type Config = z.infer<typeof envSchema>;

/** Parsed once at startup; throws with the missing/invalid variables named. */
export const config: Config = loadEnv(envSchema);
