// queue-admitter: the one background process that moves users from the queue to admitted, at each
// event's configured rate. It serves /healthz and /metrics on ADMITTER_PORT and nothing else; users
// talk to queue-svc (src/http/server.ts). Run exactly one of these (see the note in loop.ts).

import { createServer } from "node:http";
import { createLogger } from "@flash/observability";
import { register } from "prom-client";
import { loadAdmitterEnv } from "../config/env.js";
import { createEventConfigs } from "../config/events.js";
import { createRedis, logConnection, onReady } from "../redis/client.js";
import { createScripts } from "../redis/scripts.js";
import { createAdmitter } from "./loop.js";

const env = loadAdmitterEnv();
const logger = createLogger({ service: `${env.SERVICE_NAME}-admitter`, level: env.LOG_LEVEL });

const redis = createRedis(env.REDIS_URL);
logConnection(redis, logger);

const scripts = createScripts(redis, logger);
// SCRIPT LOAD on every (re)connect. Not fatal: a tick that reaches Redis before admit.lua does gets
// NOSCRIPT and loads it then.
onReady(redis, () => {
  scripts.load().catch((error) => {
    logger.warn("could not load the lua scripts, will load on first use", { error: String(error) });
  });
});

const admitter = createAdmitter({ redis, scripts, events: createEventConfigs(redis), logger });

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url === "/metrics") {
    try {
      const body = await register.metrics();
      res.writeHead(200, { "content-type": register.contentType }).end(body);
    } catch (error) {
      logger.error("metrics collection failed", error);
      res.writeHead(500).end();
    }
    return;
  }
  res
    .writeHead(404, { "content-type": "application/json" })
    .end(JSON.stringify({ code: "NOT_FOUND", message: "no such route" }));
});

server.on("error", (error) => {
  logger.error("server failed to start", error);
  process.exit(1);
});
server.listen(env.ADMITTER_PORT, "0.0.0.0", () => {
  logger.info("server started", { port: env.ADMITTER_PORT });
});

admitter.start();
logger.info("admitter started");

// A second SIGTERM falls through to Node's default handler and kills the process immediately.
process.once("SIGTERM", async (signal) => {
  logger.info("shutdown signal received", { signal });
  // Stops the timers, then gives the tick in flight up to two seconds to finish.
  await admitter.stop();
  server.close();
  server.closeAllConnections();
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
  logger.info("shutdown complete");
  process.exit(0);
});
