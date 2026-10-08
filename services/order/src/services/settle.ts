import { faultPoint } from "@flash/config";
import type { Logger } from "@flash/observability";
import { prisma } from "../db.js";
import { holdMissingOnConfirm } from "../metrics.js";
import type { HoldStore } from "../redis/index.js";

/**
 * - `confirmed`   PAID: the hold became a sale
 * - `released`    EXPIRED or PAYMENT_FAILED: the hold went back to inventory, order is RELEASED
 * - `settled`     the work was already done (hold settled earlier, or Redis had nothing left to do)
 * - `skipped`     the order is in no state that has a hold to settle (or does not exist)
 */
export type SettleResult = "confirmed" | "released" | "settled" | "skipped";

/**
 * Settles an order's Redis hold exactly once, whoever asks and however often (the fast-path
 * consumer, the sweeper, a redelivered event).
 *
 *   PAID                    -> confirm: hold -> sold, then holdSettledAt
 *   EXPIRED, PAYMENT_FAILED -> release: hold -> avail, then state RELEASED + holdSettledAt
 *
 * Redis first, then Postgres. A crash between the two is safe: both scripts only act when ZREM
 * removes the hold, so the retry does nothing in Redis and finishes the Postgres update.
 */
export async function settle(
  orderId: string,
  holds: HoldStore,
  logger: Logger,
): Promise<SettleResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.warn("settle: no such order", { orderId });
    return "skipped";
  }
  if (order.holdSettledAt) {
    return "settled";
  }

  // The order id is the hold id (Phase 3 creates the order under the reservation's holdId).
  const hold = { eventId: order.eventId, holdId: order.id, qty: order.qty };

  if (order.state === "PAID") {
    const confirmed = await holds.confirm(hold);
    faultPoint("after_redis_settle_before_db_update");
    if (!confirmed) {
      // Not necessarily wrong (a repeat after a crash finds the hold already confirmed), but it is
      // also exactly what an oversell looks like, so it is loud. It is still marked settled, or the
      // sweeper would retry it forever.
      holdMissingOnConfirm.inc();
      logger.error("CRITICAL: hold missing when confirming a PAID order", {
        orderId,
        eventId: order.eventId,
        holdId: order.id,
        qty: order.qty,
      });
    }
    const marked = await prisma.order.updateMany({
      where: { id: orderId, state: "PAID", holdSettledAt: null },
      data: { holdSettledAt: new Date() },
    });
    logger.info("hold confirmed", { orderId, confirmedNow: confirmed, marked: marked.count === 1 });
    return confirmed ? "confirmed" : "settled";
  }

  if (order.state === "EXPIRED" || order.state === "PAYMENT_FAILED") {
    const released = await holds.release(hold);
    faultPoint("after_redis_settle_before_db_update");
    const marked = await prisma.order.updateMany({
      where: { id: orderId, state: { in: ["EXPIRED", "PAYMENT_FAILED"] } },
      data: { state: "RELEASED", holdSettledAt: new Date() },
    });
    if (marked.count === 0) {
      // Another settler got to the row first; the Redis side was idempotent, so nothing is lost.
      logger.info("hold release: order already settled by someone else", { orderId });
      return "settled";
    }
    logger.info("hold released", { orderId, releasedNow: released, from: order.state });
    return released ? "released" : "settled";
  }

  return "skipped";
}
