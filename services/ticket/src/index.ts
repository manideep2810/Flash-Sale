import { createLogger } from "@flash/observability";
import { getPool } from "./baseline/db.js";
import { config } from "./config.js";
import { startServer } from "./server.js";

const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

// The baseline experiments need Postgres; without DATABASE_URL the service still boots (probes only).
const baselinePool = config.DATABASE_URL ? getPool() : undefined;

startServer({
  port: config.PORT,
  logger,
  baselinePool,
  closeClients: async () => {
    await baselinePool?.end();
  },
});
