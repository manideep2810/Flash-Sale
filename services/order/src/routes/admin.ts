import type { Logger } from "@flash/observability";
import { type Request, type Response, Router } from "express";
import { ORDER_TABLE, prisma } from "../db.js";

/** One row per event and order state. */
export interface OrderMetricsRow {
  eventId: string;
  state: string;
  /** How many orders are in this state. */
  orders: number;
  /** The units those orders are for. */
  units: number;
  /** What they were charged in total, smallest currency unit (0 for orders never sent to payment). */
  amount: number;
}

/**
 * GET /admin/orders/metrics -> {rows: [{eventId, state, orders, units, amount}]}
 *
 * The admin page's order numbers: how many orders each event has in each state, the units they cover
 * and what they were charged. Mounted behind requireAdmin (src/api.ts). One GROUP BY over the Order
 * table; `amount` is what /pay stored, so the PAID rows add up to the revenue.
 */
export function createAdminOrdersRouter({ logger }: { logger: Logger }): Router {
  const router = Router();

  router.get("/admin/orders/metrics", async (_req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<OrderMetricsRow[]>`
        SELECT "eventId",
               state::text AS state,
               COUNT(*)::int AS orders,
               COALESCE(SUM(qty), 0)::int AS units,
               COALESCE(SUM(amount), 0)::int AS amount
          FROM ${ORDER_TABLE}
         GROUP BY "eventId", state
         ORDER BY "eventId", state`;
      res.json({ rows });
    } catch (error) {
      logger.error("order metrics failed", { error: String(error) });
      res.status(500).json({ code: "INTERNAL", message: "internal error" });
    }
  });

  return router;
}
