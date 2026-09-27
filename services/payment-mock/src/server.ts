import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import express, { type Express } from "express";

export const SERVICE_NAME = "payment-mock";

export interface HealthState {
  /** Flipped to false on SIGTERM so /healthz/ready fails and upstreams stop routing here. */
  ready: boolean;
}

export function createApp(health: HealthState): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/healthz/ready", (_req, res) => {
    res.status(health.ready ? 200 : 503).json({ status: health.ready ? "ready" : "draining" });
  });

  return app;
}

export interface StartOptions {
  port: number;
  logger: Logger;
  /** How long readiness reports 503 before the listener closes, so load balancers catch up. */
  drainDelayMs?: number;
  /** Upper bound on waiting for in-flight requests before remaining sockets are destroyed. */
  shutdownTimeoutMs?: number;
}

export function startServer({
  port,
  logger,
  drainDelayMs = 5_000,
  shutdownTimeoutMs = 10_000,
}: StartOptions): Server {
  const health: HealthState = { ready: true };

  const server = createApp(health).listen(port, (error) => {
    if (error) {
      logger.error("server failed to start", error);
      process.exit(1);
    }
    logger.info("server listening", { port });
  });

  // A second SIGTERM falls through to Node's default handler and kills the process immediately.
  process.once("SIGTERM", async (signal) => {
    logger.info("shutdown signal received, draining", { signal, drainDelayMs });
    health.ready = false;
    await sleep(drainDelayMs);

    const forceClose = setTimeout(() => {
      logger.warn("drain timed out, destroying open connections", { shutdownTimeoutMs });
      server.closeAllConnections();
    }, shutdownTimeoutMs).unref();

    server.close((error) => {
      clearTimeout(forceClose);
      if (error) {
        logger.error("server close failed", error);
      }
      logger.info("shutdown complete");
      process.exit(error ? 1 : 0);
    });
  });

  return server;
}
