import { z } from "zod";

/** Variables every service reads; extend with `baseEnvSchema.extend({ ... })` per service. */
export const baseEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"]).default("info"),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Validates the environment against `schema`, failing fast at boot with a readable report. */
export function loadEnv<Schema extends z.ZodType>(
  schema: Schema,
  env: NodeJS.ProcessEnv = process.env,
): z.output<Schema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
