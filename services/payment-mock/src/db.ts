import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

// Prisma reaches Postgres through node-postgres, which does not act on the `?schema=` parameter of
// Prisma's URL format, so the schema is read out of the URL and handed to the adapter instead.
const schema = new URL(config.DATABASE_URL).searchParams.get("schema") ?? undefined;

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }, { schema }),
});
