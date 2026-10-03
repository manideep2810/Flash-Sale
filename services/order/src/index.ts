import { createLogger } from "@flash/observability";
import { config } from "./config.js";
import { GROUP_ID, startConsumer, stopConsumer, TOPIC } from "./consumer.js";
import { prisma } from "./db.js";
import { startServer } from "./server.js";

const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

// The listener opens first so the probes and /metrics answer while the consumer is still connecting.
startServer({
  port: config.PORT,
  logger,
  closeClients: async () => {
    await stopConsumer();
    await prisma.$disconnect();
  },
});

// Does not resolve until a broker answers, however long that takes.
await startConsumer(logger);
logger.info("consumer running", { topic: TOPIC, groupId: GROUP_ID });
