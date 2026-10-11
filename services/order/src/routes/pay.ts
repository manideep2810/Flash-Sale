import { faultPoint } from "@flash/config";
import type { Logger } from "@flash/observability";
import { type Request, type Response, Router } from "express";
import { ORDER_TABLE, prisma } from "../db.js";
import { payDuration } from "../metrics.js";
import type { PublishPaymentRequested } from "../services/payment-requests.js";

export interface PayRouterOptions {
  publish: PublishPaymentRequested;
  logger: Logger;
  /**
   * The event's price per unit, in the smallest currency unit, or null when it has none. Without
   * this (or with null) the order is charged the flat PAY_AMOUNT, as before prices existed.
   */
  unitPrice?: (eventId: string) => Promise<number | null>;
}

// Timestamps are `timestamp(3)` holding UTC, so "now" is taken as UTC whatever the session time zone.

export function createPayRouter({ publish, logger, unitPrice }: PayRouterOptions): Router {
  const router = Router();

  router.use("/orders/:id/pay", (_req, res, next) => {
    const startedAt = performance.now();
    res.on("finish", () => {
      payDuration.observe({ status: String(res.statusCode) }, performance.now() - startedAt);
    });
    next();
  });

  /**
   * POST /orders/:id/pay
   *   202 {state: "PAYMENT_PENDING"}  this call moved the order and asked for the charge
   *   200 {state}                     already PAYMENT_PENDING or PAID: a repeat click, nothing happens
   *   409 {error, state}              the hold is over, or the order can no longer be paid
   *   404                             no such order
   *   503 {error: "PRICE_UNAVAILABLE"} the event's price could not be read; nothing changed, retry
   *
   * The charge itself is not awaited: the payment service answers over Kafka. The one guarded UPDATE
   * is the decision; the timeout job's `state = 'HELD' AND expiresAt < now` is its mirror image, so
   * for any order exactly one of "paid" and "expired" can win.
   */
  router.post("/orders/:id/pay", async (req: Request<{ id: string }>, res: Response) => {
    const orderId = req.params.id;
    try {
      // What to charge: price x quantity. Worked out before the claim and written by it, so the
      // amount is on the order from the instant it is PAYMENT_PENDING and a re-publish by the
      // sweeper asks for the same sum. Null (no such order, or an event without a price) leaves
      // the column empty and the flat PAY_AMOUNT applies.
      let amount: number | null = null;
      if (unitPrice) {
        const priced = await prisma.order.findUnique({
          where: { id: orderId },
          select: { eventId: true, qty: true },
        });
        let price: number | null = null;
        if (priced) {
          try {
            price = await unitPrice(priced.eventId);
          } catch (error) {
            // Not knowing the price is not the same as the event having none: charging the flat
            // amount here could charge the wrong sum. The order is left as it is, still HELD.
            logger.error("pay refused: the event's price could not be read", {
              orderId,
              error: String(error),
            });
            res.status(503).json({ error: "PRICE_UNAVAILABLE" });
            return;
          }
        }
        amount = priced && price !== null ? price * priced.qty : null;
      }

      const claimed = await prisma.$queryRaw<
        { id: string; userId: string; amount: number | null }[]
      >`
        UPDATE ${ORDER_TABLE}
           SET state = 'PAYMENT_PENDING',
               amount = ${amount}::int,
               "paymentStartedAt" = (now() AT TIME ZONE 'UTC'),
               "updatedAt" = (now() AT TIME ZONE 'UTC')
         WHERE id = ${orderId} AND state = 'HELD' AND "expiresAt" > (now() AT TIME ZONE 'UTC')
        RETURNING id, "userId", amount`;

      const [moved] = claimed;
      if (moved) {
        faultPoint("after_pay_update_before_publish");
        try {
          await publish(moved);
        } catch (error) {
          // The order is already PAYMENT_PENDING, so the sweeper re-publishes it; the caller's
          // request did succeed.
          logger.error("PaymentRequested publish failed, the sweeper will retry", {
            orderId,
            error: String(error),
          });
        }
        logger.info("payment requested", { orderId });
        res.status(202).json({ state: "PAYMENT_PENDING" });
        return;
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { state: true },
      });
      if (!order) {
        res.status(404).json({ error: "NOT_FOUND" });
      } else if (order.state === "PAYMENT_PENDING" || order.state === "PAID") {
        res.status(200).json({ state: order.state });
      } else {
        const expired = order.state === "HELD" || order.state === "EXPIRED";
        res
          .status(409)
          .json({ error: expired ? "HOLD_EXPIRED" : "NOT_PAYABLE", state: order.state });
      }
    } catch (error) {
      logger.error("pay failed", { orderId, error: String(error) });
      res.status(500).json({ error: "INTERNAL" });
    }
  });

  return router;
}
