import type { Logger } from "@flash/observability";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { type RedisPool, type ReserveScript, resetEvent } from "./redis/index.js";

// Same shape the Postgres variants accept, so one k6 script can point at either path.
const reserveBody = z.object({
  eventId: z.string().min(1),
  userId: z.string().min(1),
  qty: z.number().int().min(1),
});

const resetBody = z.object({
  eventId: z.string().min(1),
  total: z.number().int().min(0),
});

export interface RedisRouterOptions {
  script: ReserveScript;
  pool: RedisPool;
  logger: Logger;
}

export function createRedisRouter({ script, pool, logger }: RedisRouterOptions): Router {
  const router = Router();

  // POST /redis/reserve  {eventId, userId, qty} -> 201 {holdId} | 409 {error: "SOLD_OUT"}
  router.post("/redis/reserve", async (req: Request, res: Response) => {
    const parsed = reserveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BAD_REQUEST", issues: z.prettifyError(parsed.error) });
      return;
    }
    const { eventId, userId, qty } = parsed.data;

    const startedAt = performance.now();
    let result: "ok" | "sold_out" | "error" = "error";
    try {
      const outcome = await script.reserve(eventId, userId, qty);
      if (outcome.ok) {
        result = "ok";
        res.status(201).json({ holdId: outcome.holdId });
      } else {
        result = "sold_out";
        res.status(409).json({ error: outcome.reason });
      }
    } catch (error) {
      logger.error("redis reserve failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    } finally {
      logger.info("redis reserve", {
        variant: "redis",
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        result,
      });
    }
  });

  // POST /redis/reset  {eventId, total} -> inventory back to total, holds and stream emptied.
  // Body and response mirror /baseline/reset so one k6 setup() can reset either backend.
  router.post("/redis/reset", async (req: Request, res: Response) => {
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BAD_REQUEST", issues: z.prettifyError(parsed.error) });
      return;
    }
    const { eventId, total } = parsed.data;

    try {
      await resetEvent(pool, eventId, total);
      res.json({ status: "reset", eventId, total, available: total, holdsQty: 0 });
    } catch (error) {
      logger.error("redis reset failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    }
  });

  return router;
}

/** Mirrors the helper in src/baseline/routes.ts; `code` is a Redis reply prefix or a Node errno. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
