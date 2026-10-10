import { baseEnvSchema, loadEnv } from "@flash/config";
import { z } from "zod";

const MIN_SECRET_BYTES = 32;

const sharedSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().min(1).default("queue"),
  /** Must be the Redis the ticket service uses: admit.lua reads its avail and holds keys. */
  REDIS_URL: z.url(),
});

const serverSchema = sharedSchema.extend({
  /** Signs the admission JWT (HS256), so it needs at least as many bytes as the hash is wide. */
  ADMISSION_SECRET: z
    .string()
    .refine((secret) => Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES, {
      error: `must be at least ${MIN_SECRET_BYTES} bytes`,
    }),
});

const admitterSchema = sharedSchema.extend({
  /** The admitter serves /healthz and /metrics here. PORT in the shared .env belongs to queue-svc. */
  ADMITTER_PORT: z.coerce.number().int().min(1).max(65_535).default(3011),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type AdmitterEnv = z.infer<typeof admitterSchema>;

// Two processes share this codebase and one .env. Each validates only what it uses, so the admitter
// never needs the signing secret. Both throw at boot with the missing/invalid variables named.

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  return loadEnv(serverSchema, env);
}

export function loadAdmitterEnv(env: NodeJS.ProcessEnv = process.env): AdmitterEnv {
  return loadEnv(admitterSchema, env);
}
