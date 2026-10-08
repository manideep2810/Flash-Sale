// order-worker: everything that runs in the background. Phase 3 order creation, the payment-result
// and hold-settlement consumers, the timeout job and the two sweepers. It serves only the probes and
// /metrics (on WORKER_PORT); requests go to the API.
import { createLogger } from "@flash/observability";
import { config } from "./config.js";
import { GROUP_ID, startConsumer, stopConsumer, TOPIC } from "./consumer.js";
import { startHoldSettlementConsumer } from "./consumers/hold-settlement.js";
import { startPaymentResultConsumer } from "./consumers/payment-result.js";
import { prisma } from "./db.js";
import { SHUTDOWN_TIMEOUT_MS, stopAll } from "./lifecycle.js";
import { disconnectOrdersProducer } from "./orderEvents.js";
import "./orderStateGauge.js";
import { registerInventoryMetrics } from "./inventoryGauges.js";
import { createHoldStore, createRedis } from "./redis/index.js";
import { startServer } from "./server.js";
import { startPaymentSweeper } from "./services/payment-sweeper.js";
import { startSettlementSweeper } from "./services/settlement-sweeper.js";
import { startTimeoutJob } from "./services/timeout-job.js";

const logger = createLogger({ service: `${config.SERVICE_NAME}-worker`, level: config.LOG_LEVEL });

if (!config.REDIS_URL) {
  // Settling holds is this process's job, so a missing Redis is a boot failure, not a runtime one.
  throw new Error("REDIS_URL is required by the order worker (it settles holds in Redis)");
}
const redis = createRedis(config.REDIS_URL);
const holds = createHoldStore(redis);
registerInventoryMetrics(redis);

// Stoppers, in the order shutdown runs them: stop taking work first, disconnect clients last.
const stoppers: [string, () => Promise<void>][] = [];

startServer({
  port: config.WORKER_PORT,
  logger,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  closeClients: () =>
    stopAll(logger, [
      ...stoppers,
      ["orders producer", disconnectOrdersProducer],
      ["redis", async () => void redis.disconnect()],
      ["prisma", () => prisma.$disconnect()],
    ]),
});

// The jobs first: they need only Postgres and a producer. The consumers can wait for a broker for as
// long as it takes, so they come last and do not hold anything else up.
stoppers.push(["timeout job", await startTimeoutJob(logger)]);
stoppers.push(["payment sweeper", await startPaymentSweeper(logger)]);
stoppers.push(["settlement sweeper", await startSettlementSweeper(logger, holds)]);
stoppers.push(["payment result consumer", await startPaymentResultConsumer(logger)]);
stoppers.push(["hold settlement consumer", await startHoldSettlementConsumer(logger, holds)]);

stoppers.push(["order creation consumer", stopConsumer]);
await startConsumer(logger);
logger.info("consumer running", { topic: TOPIC, groupId: GROUP_ID });
