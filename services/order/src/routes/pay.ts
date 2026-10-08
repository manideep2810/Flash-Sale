import { faultPoint } from "@flash/config";
import type { Logger } from "@flash/observability";
import { type Request, type Response, Router } from "express";
import { ORDER_TABLE, prisma } from "../db.js";
import { payDuration } from "../metrics.js";
import type { PublishPaymentRequested } from "../services/payment-requests.js";

export interface PayRouterOptions {
  publish: PublishPaymentRequested;
  logger: Logger;
}

// Timestamps are `timestamp(3)` holding UTC, so "now" is taken as UTC whatever the session time zone.

export function createPayRouter({ publish, logger }: PayRouterOptions): Router {
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
   *
   * The charge itself is not awaited: the payment service answers over Kafka. The one guarded UPDATE
   * is the decision; the timeout job's `state = 'HELD' AND expiresAt < now` is its mirror image, so
   * for any order exactly one of "paid" and "expired" can win.
   */
  router.post("/orders/:id/pay", async (req: Request<{ id: string }>, res: Response) => {
    const orderId = req.params.id;
    try {
      const claimed = await prisma.$queryRaw<{ id: string; userId: string }[]>`
        UPDATE ${ORDER_TABLE}
           SET state = 'PAYMENT_PENDING',
               "paymentStartedAt" = (now() AT TIME ZONE 'UTC'),
               "updatedAt" = (now() AT TIME ZONE 'UTC')
         WHERE id = ${orderId} AND state = 'HELD' AND "expiresAt" > (now() AT TIME ZONE 'UTC')
        RETURNING id, "userId"`;

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
