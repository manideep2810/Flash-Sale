import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import express, { type Express } from "express";
import { register } from "prom-client";

export interface AppState {
  /** Set on SIGTERM so /healthz/ready returns 503 and upstreams stop routing new traffic here. */
  shuttingDown: boolean;
}

export interface AppOptions {
  /**
   * Probes the service's dependencies for /healthz/ready, one entry per dependency, true when it
   * answered. Any false makes the probe 503. Must not reject.
   */
  checkDependencies?: () => Promise<Record<string, boolean>>;
}

export function createApp(
  logger: Logger,
  state: AppState = { shuttingDown: false },
  { checkDependencies = async () => ({}) }: AppOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Probes and /metrics are registered before the request logger so polling doesn't flood the logs.
  app.get("/healthz/live", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/healthz/ready", async (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ ok: false });
      return;
    }
    const dependencies = await checkDependencies();
    const ok = Object.values(dependencies).every(Boolean);
    res.status(ok ? 200 : 503).json({ ok, ...dependencies });
  });

  // prom-client's default registry; src/metrics.ts is what puts the relay's metrics on it.
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

  return app;
}

export interface StartOptions extends AppOptions {
  port: number;
  logger: Logger;
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
  closeClients = async () => {},
  drainDelayMs = 5_000,
  shutdownTimeoutMs = 10_000,
  checkDependencies,
}: StartOptions): Server {
  const state: AppState = { shuttingDown: false };

  const server = createApp(logger, state, { checkDependencies }).listen(
    port,
    "0.0.0.0",
    (error) => {
      if (error) {
        logger.error("server failed to start", error);
        process.exit(1);
      }
      logger.info("server started", { port });
    },
  );

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
