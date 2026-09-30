import type { Logger } from "@flash/observability";
import { type Request, type Response, Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import * as atomic from "./atomic.js";
import * as naive from "./naive.js";
import * as optimistic from "./optimistic.js";
import * as pessimistic from "./pessimistic.js";
import { isVariant, type Reserve, VARIANTS, type Variant } from "./types.js";

const reserveByVariant: Record<Variant, Reserve> = {
  naive: naive.reserve,
  pessimistic: pessimistic.reserve,
  atomic: atomic.reserve,
  optimistic: optimistic.reserve,
};

const reserveBody = z.object({
  eventId: z.string().min(1),
  userId: z.string().min(1),
  qty: z.number().int().min(1),
});

const resetBody = z.object({
  eventId: z.string().min(1),
  total: z.number().int().min(0),
});

export interface BaselineRouterOptions {
  pool: Pool;
  logger: Logger;
}

export function createBaselineRouter({ pool, logger }: BaselineRouterOptions): Router {
  const router = Router();

  // POST /baseline/:variant/reserve  {eventId, userId, qty} -> 201 {holdId} | 409 {error: "SOLD_OUT"}
  router.post("/baseline/:variant/reserve", async (req: Request, res: Response) => {
    const variant = String(req.params.variant);
    if (!isVariant(variant)) {
      res.status(404).json({ error: "UNKNOWN_VARIANT", variants: VARIANTS });
      return;
    }

    const parsed = reserveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BAD_REQUEST", issues: z.prettifyError(parsed.error) });
      return;
    }
    const { eventId, userId, qty } = parsed.data;

    const startedAt = performance.now();
    let result: "ok" | "sold_out" | "error" = "error";
    let retries: number | undefined;
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      const outcome = await reserveByVariant[variant](client, eventId, userId, qty);
      retries = outcome.retries;
      // `retries` is only present for variants that retry, so it is omitted from the JSON otherwise.
      if (outcome.ok) {
        result = "ok";
        res.status(201).json({ holdId: outcome.holdId, retries });
      } else {
        result = "sold_out";
        res.status(409).json({ error: outcome.reason, retries });
      }
    } catch (error) {
      logger.error("baseline reserve failed", { variant, error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    } finally {
      client?.release();
      logger.info("baseline reserve", {
        variant,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        result,
        retries,
      });
    }
  });

  // POST /baseline/reset  {eventId, total} -> truncate holds, upsert the inventory row
  router.post("/baseline/reset", async (req: Request, res: Response) => {
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BAD_REQUEST", issues: z.prettifyError(parsed.error) });
      return;
    }
    const { eventId, total } = parsed.data;

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("TRUNCATE TABLE holds");
      await client.query(
        `INSERT INTO inventory (event_id, total, available, version)
         VALUES ($1, $2, $2, 0)
         ON CONFLICT (event_id) DO UPDATE
           SET total = EXCLUDED.total, available = EXCLUDED.available, version = 0`,
        [eventId, total],
      );
      await client.query("COMMIT");
      res.json({ eventId, total, available: total, holdsQty: 0 });
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => {});
      logger.error("baseline reset failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    } finally {
      client?.release();
    }
  });

  // GET /baseline/state/:eventId -> {total, available, holdsQty}
  router.get("/baseline/state/:eventId", async (req: Request, res: Response) => {
    const eventId = String(req.params.eventId);
    try {
      const { rows } = await pool.query<{ total: number; available: number; holds_qty: number }>(
        `SELECT i.total,
                i.available,
                COALESCE((SELECT SUM(h.qty) FROM holds h WHERE h.event_id = i.event_id), 0)::int
                  AS holds_qty
         FROM inventory i
         WHERE i.event_id = $1`,
        [eventId],
      );
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      res.json({ total: row.total, available: row.available, holdsQty: row.holds_qty });
    } catch (error) {
      logger.error("baseline state failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    }
  });

  return router;
}

/** `code` is pg's SQLSTATE (e.g. 42P01 undefined_table) or a Node errno (ECONNREFUSED). */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
