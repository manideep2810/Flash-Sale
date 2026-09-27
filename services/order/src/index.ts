import { createLogger } from "@flash/observability";
import { config } from "./config.js";
import { startServer } from "./server.js";

const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

// Pass `closeClients` here once Redis/Kafka/Prisma clients exist so SIGTERM disconnects them.
startServer({ port: config.PORT, logger });
