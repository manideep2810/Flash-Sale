import { createLogger } from "@flash/observability";
import { config } from "./config.js";
import { startPaymentRequestConsumer } from "./consumers/payment-requests.js";
import { prisma } from "./db.js";
import "./metrics.js";
import { createPrismaStore } from "./paymentStore.js";
import { createChargesRouter } from "./routes/charges.js";
import { startServer } from "./server.js";

const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });
const store = createPrismaStore();

// The listener opens first so the probes answer while the consumer is still connecting.
let stopConsumer: () => Promise<void> = async () => {};

startServer({
  port: config.PORT,
  logger,
  routes: createChargesRouter(store),
  closeClients: async () => {
    await stopConsumer();
    await prisma.$disconnect();
  },
});

// Does not resolve until a broker answers, however long that takes.
stopConsumer = await startPaymentRequestConsumer(logger, store);
