import pg from "pg";

/**
 * Connection pool for the baseline experiments. Sized from PG_POOL_MAX so the same variant can be
 * measured under different contention levels without touching code.
 *
 * `search_path` is pinned to the `baseline` schema (see infra/sql/baseline.sql), so the variant SQL
 * can name `inventory` and `holds` unqualified.
 */
export function createPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the baseline module");
  }

  const max = Number.parseInt(env.PG_POOL_MAX ?? "20", 10);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`PG_POOL_MAX must be a positive integer, got "${env.PG_POOL_MAX}"`);
  }

  return new pg.Pool({
    connectionString,
    max,
    options: "-c search_path=baseline,public",
  });
}

let shared: pg.Pool | undefined;

/** Process-wide pool built from the environment on first use, so importing this module is side-effect free. */
export function getPool(): pg.Pool {
  shared ??= createPool();
  return shared;
}

export type { Pool, PoolClient } from "pg";
