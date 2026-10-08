import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Plain process.env (not prisma's env()) so `prisma generate` works without a database;
  // migrate commands still fail fast when DATABASE_URL is missing.
  datasource: { url: process.env.DATABASE_URL },
});
