import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import express, { type Express, type Router } from "express";
import { register } from "prom-client";

export interface AppState {
  /** Set on SIGTERM so /healthz/ready returns 503 and upstreams stop routing new traffic here. */
  shuttingDown: boolean;
}

export function createApp(
  logger: Logger,
  state: AppState = { shuttingDown: false },
  routes?: Router,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Probes are registered before the request logger so orchestrator polling doesn't flood the logs.
  app.get("/healthz/live", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/healthz/ready", (_req, res) => {
    res.status(state.shuttingDown ? 503 : 200).json({ ok: !state.shuttingDown });
  });

  // prom-client's default registry; src/lag.ts is what puts the consumer lag gauge on it.
  app.get("/metrics", async (_req, res) => {
    try {
      res.set("content-type", register.contentType).send(await register.metrics());
    } catch (error) {
      logger.error("metrics collection failed", error);
      res.status(500).end();
    }
  });

  app.use((req, res, next) => {
    const startedAt = performance.now();
    res.on("finish", () => {
      logger.info("request", {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    next();
  });

  if (routes) {
    app.use(routes);
  }

  return app;
}

export interface StartOptions {
  port: number;
  logger: Logger;
  /** Business routes, mounted after the probes and the request logger. */
  routes?: Router;
  /** Closes Redis/Kafka/Prisma clients after HTTP traffic has drained. */
  closeClients?: () => Promise<void>;
  /** How long readiness reports 503 before the listener closes, so load balancers catch up. */
  drainDelayMs?: number;
  /** Upper bound on waiting for in-flight requests before remaining sockets are destroyed. */
  shutdownTimeoutMs?: number;
}

export function startServer({
  port,
  logger,
  routes,
  closeClients = async () => {},
  drainDelayMs = 5_000,
  shutdownTimeoutMs = 10_000,
}: StartOptions): Server {
  const state: AppState = { shuttingDown: false };

  const server = createApp(logger, state, routes).listen(port, "0.0.0.0", (error) => {
    if (error) {
      logger.error("server failed to start", error);
      process.exit(1);
    }
    logger.info("server started", { port });
  });

  // A second SIGTERM falls through to Node's default handler and kills the process immediately.
  process.once("SIGTERM", async (signal) => {
    state.shuttingDown = true;
    logger.info("shutdown signal received, draining", { signal, drainDelayMs });
    await sleep(drainDelayMs);

    const forceClose = setTimeout(() => {
      logger.warn("drain timed out, destroying open connections", { shutdownTimeoutMs });
      server.closeAllConnections();
    }, shutdownTimeoutMs).unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      clearTimeout(forceClose);
      await closeClients();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", error);
      process.exit(1);
    }
  });

  return server;
}
