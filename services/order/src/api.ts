// order-api: the logins (POST /auth/dev-login, POST /auth/admin-login), POST /orders/:id/pay,
// GET /orders/:id, the admin's order metrics, the probes and /metrics. Takes requests only; every
// background job lives in worker.ts, so the two scale and restart separately.

import { requireAdmin, requireSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { Router } from "express";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { SHUTDOWN_TIMEOUT_MS, stopAll } from "./lifecycle.js";
import { createPriceReader, createRedis } from "./redis/index.js";
import { createAdminOrdersRouter } from "./routes/admin.js";
import { createAdminAuthRouter, createAuthRouter } from "./routes/auth.js";
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
routes.use(createAdminAuthRouter({ secret: sessionSecret, password: config.ADMIN_PASSWORD }));
if (!config.ADMIN_PASSWORD) {
  logger.info("admin login is off: ADMIN_PASSWORD is not set");
}

// An order is charged its event's price x quantity. The price is read from the event's config hash
// in Redis (the catalogue's hot copy); without Redis every order is charged the flat PAY_AMOUNT.
const redis = config.REDIS_URL ? createRedis(config.REDIS_URL) : undefined;
redis?.on("error", (error) => logger.warn("redis connection error", { error: error.message }));
if (!redis) {
  logger.warn("REDIS_URL is not set: orders are charged the flat PAY_AMOUNT, not the event price");
}

// Everything about an order needs a caller. Whose order it is is not checked.
routes.use("/orders", requireSession(sessionSecret));
routes.use(
  createPayRouter({
    publish: publishPaymentRequested,
    logger,
    unitPrice: redis ? createPriceReader(redis) : undefined,
  }),
);
routes.use(createOrdersRouter());

// The admin's numbers need an admin session.
routes.use("/admin", requireAdmin(sessionSecret));
routes.use(createAdminOrdersRouter({ logger }));

startServer({
  port: config.PORT,
  logger,
  routes,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  closeClients: () =>
    stopAll(logger, [
      ["payment producer", async () => paymentProducer.disconnect()],
      ["redis", async () => void redis?.disconnect()],
      ["prisma", () => prisma.$disconnect()],
    ]),
});
