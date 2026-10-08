import { Router } from "express";
import type { PaymentStore } from "../paymentStore.js";

/** GET /charges/:orderId -> the stored payment for an order, for debugging; 404 when there is none. */
export function createChargesRouter(store: PaymentStore): Router {
  const router = Router();

  router.get("/charges/:orderId", async (req, res) => {
    try {
      const payment = await store.find(req.params.orderId);
      if (!payment) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      res.json({
        orderId: payment.orderId,
        amount: payment.amount,
        status: payment.status,
        chargeId: payment.chargeId,
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
      });
    } catch {
      res.status(500).json({ error: "INTERNAL" });
    }
  });

  return router;
}
