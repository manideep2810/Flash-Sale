// order-api: POST /orders/:id/pay, GET /orders/:id, the probes and /metrics. Takes requests only; every
// background job lives in worker.ts, so the two scale and restart separately.

import { createLogger } from "@flash/observability";
import { Router } from "express";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { SHUTDOWN_TIMEOUT_MS, stopAll } from "./lifecycle.js";
import { createOrdersRouter } from "./routes/orders.js";
import { createPayRouter } from "./routes/pay.js";
import { startServer } from "./server.js";
import { paymentProducer, publishPaymentRequested } from "./services/payment-requests.js";

const logger = createLogger({ service: `${config.SERVICE_NAME}-api`, level: config.LOG_LEVEL });

// /pay publishes PaymentRequested itself, so the API owns a producer. Connecting before the listener
// opens would keep the probes down while a broker is away; a failed publish is already tolerated (the
// sweeper re-sends), so the connection is made in the background.
const producerReady = paymentProducer.connect();
producerReady.catch((error) => logger.error("payment producer failed to connect", { error }));

const routes = Router();
routes.use(createPayRouter({ publish: publishPaymentRequested, logger }));
routes.use(createOrdersRouter());

startServer({
  port: config.PORT,
  logger,
  routes,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  closeClients: () =>
    stopAll(logger, [
      ["payment producer", async () => paymentProducer.disconnect()],
      ["prisma", () => prisma.$disconnect()],
    ]),
});
