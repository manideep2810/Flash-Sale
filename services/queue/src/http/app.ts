import type { Logger } from "@flash/observability";
import express, { type Express, type Router } from "express";
import { register } from "prom-client";
import { errorHandler, notFound } from "./routes.js";

export interface AppState {
  /** Set on SIGTERM so /readyz returns 503 and upstreams stop routing new traffic here. */
  shuttingDown: boolean;
}

export interface AppOptions {
  logger: Logger;
  state?: AppState;
  routes?: Router;
  /** For /readyz: true when Redis answered a ping. Must not reject. */
  redisReachable?: () => Promise<boolean>;
}

export function createApp({
  logger,
  state = { shuttingDown: false },
  routes,
  redisReachable = async () => true,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // Probes and /metrics are registered before the request logger so polling doesn't flood the logs.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", async (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ ok: false });
      return;
    }
    const redis = await redisReachable();
    res.status(redis ? 200 : 503).json({ ok: redis, redis });
  });

  // prom-client's default registry; src/metrics.ts is what puts the queue metrics on it.
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
  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
