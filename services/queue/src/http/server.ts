// queue-svc: POST /queue/:eventId/join, GET /queue/:eventId/status, the probes and /metrics. Takes
// requests only and mints the admission token; letting people through is the admitter's job
// (src/admitter/main.ts), a separate process.

import { setTimeout as sleep } from "node:timers/promises";
import { requireSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { loadServerEnv } from "../config/env.js";
import { createEventConfigs } from "../config/events.js";
import { createQueueService } from "../queue/service.js";
import { createTokenMinter } from "../queue/token.js";
import { createRedis, logConnection, onReady, redisReachable } from "../redis/client.js";
import { createScripts } from "../redis/scripts.js";
import { type AppState, createApp } from "./app.js";
import { createQueueRouter } from "./routes.js";

/** How long /readyz reports 503 before the listener closes, so load balancers catch up. */
const DRAIN_DELAY_MS = 5_000;
/** Upper bound on waiting for in-flight requests before remaining sockets are destroyed. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadServerEnv();
const logger = createLogger({ service: `${env.SERVICE_NAME}-svc`, level: env.LOG_LEVEL });

const redis = createRedis(env.REDIS_URL);
logConnection(redis, logger);

const scripts = createScripts(redis, logger);
// SCRIPT LOAD on every (re)connect. Not fatal: with Redis away at boot the probes still answer
// (/readyz with 503), and a call that reaches Redis before a script does gets NOSCRIPT and loads it.
onReady(redis, () => {
  scripts.load().catch((error) => {
    logger.warn("could not load the lua scripts, will load on first use", { error: String(error) });
  });
});

const service = createQueueService({
  events: createEventConfigs(redis),
  scripts,
  mintToken: createTokenMinter(env.ADMISSION_SECRET),
  redis,
});

const state: AppState = { shuttingDown: false };
const app = createApp({
  logger,
  state,
  routes: createQueueRouter({ service, authenticate: requireSession(env.SESSION_SECRET) }),
  redisReachable: () => redisReachable(redis),
});

const server = app.listen(env.PORT, "0.0.0.0", (error) => {
  if (error) {
    logger.error("server failed to start", error);
    process.exit(1);
  }
  logger.info("server started", { port: env.PORT });
});

// A second SIGTERM falls through to Node's default handler and kills the process immediately.
process.once("SIGTERM", async (signal) => {
  state.shuttingDown = true;
  logger.info("shutdown signal received, draining", { signal, drainDelayMs: DRAIN_DELAY_MS });
  await sleep(DRAIN_DELAY_MS);

  const forceClose = setTimeout(() => {
    logger.warn("drain timed out, destroying open connections", {
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    server.closeAllConnections();
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    clearTimeout(forceClose);
    // quit() rejects when the connection is already down; there is nothing left to close then.
    await redis.quit().catch(() => redis.disconnect());
    logger.info("shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("shutdown failed", error);
    process.exit(1);
  }
});
