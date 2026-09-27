import { z } from "zod";

/** Variables every service requires; extend with `baseEnvSchema.extend({ ... })` per service. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65_535),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"]),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Validates the environment against `schema`, failing fast at boot. Missing required variables are
 * listed by name; anything else invalid gets Zod's per-field report.
 */
export function loadEnv<Schema extends z.ZodObject>(
  schema: Schema,
  env: NodeJS.ProcessEnv = process.env,
): z.output<Schema> {
  // A field is required exactly when it rejects `undefined` (no .optional() or .default()).
  const missing = Object.entries(schema.shape)
    .filter(([key, field]) => env[key] === undefined && !z.safeParse(field, undefined).success)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "For local runs, copy .env.example to .env in the service directory.",
    );
  }

  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
