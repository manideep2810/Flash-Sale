import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.js";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";

// Prisma reaches Postgres through node-postgres, which does not act on the `?schema=` parameter of
// Prisma's URL format, so the schema is read out of the URL and handed to the adapter instead.
const schema = new URL(config.DATABASE_URL).searchParams.get("schema") ?? undefined;

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }, { schema }),
});

/**
 * The Order table for hand-written SQL. Prisma's own queries qualify the table with the schema, but
 * `$queryRaw` runs on a connection with no search_path set, so raw SQL has to name it. The schema
 * comes from our own config, and is checked so it can only ever be an identifier.
 */
const SCHEMA_NAME = /^[A-Za-z0-9_-]+$/;
if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
  throw new Error(`DATABASE_URL schema "${schema}" is not a plain identifier`);
}
export const ORDER_TABLE = Prisma.raw(`"${schema ?? "public"}"."Order"`);
export const ORDER_STATE_TYPE = Prisma.raw(`"${schema ?? "public"}"."OrderState"`);
