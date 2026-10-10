// order-api: POST /auth/dev-login, POST /orders/:id/pay, GET /orders/:id, the probes and /metrics. Takes
// requests only; every background job lives in worker.ts, so the two scale and restart separately.

import { requireSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { Router } from "express";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { SHUTDOWN_TIMEOUT_MS, stopAll } from "./lifecycle.js";
import { createAuthRouter } from "./routes/auth.js";
import { createOrdersRouter } from "./routes/orders.js";
import { createPayRouter } from "./routes/pay.js";
import { startServer } from "./server.js";
import { paymentProducer, publishPaymentRequested } from "./services/payment-requests.js";

const logger = createLogger({ service: `${config.SERVICE_NAME}-api`, level: config.LOG_LEVEL });

if (!config.SESSION_SECRET) {
  // Issuing and checking sessions is this process's job, so a missing secret is a boot failure.
  throw new Error("SESSION_SECRET is required by the order API (it signs and verifies sessions)");
}
const sessionSecret = config.SESSION_SECRET;

// /pay publishes PaymentRequested itself, so the API owns a producer. Connecting before the listener
// opens would keep the probes down while a broker is away; a failed publish is already tolerated (the
// sweeper re-sends), so the connection is made in the background.
const producerReady = paymentProducer.connect();
producerReady.catch((error) => logger.error("payment producer failed to connect", { error }));

const routes = Router();
if (config.NODE_ENV === "production") {
  logger.info("dev login is not mounted in production");
} else {
  logger.warn(
    "dev login is ENABLED: POST /auth/dev-login issues a session for any userId, with no password",
  );
  routes.use(createAuthRouter({ secret: sessionSecret }));
}
// Everything about an order needs a caller. Whose order it is is not checked.
routes.use("/orders", requireSession(sessionSecret));
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
