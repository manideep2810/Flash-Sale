import { Router } from "express";
import { prisma } from "../db.js";

/**
 * GET /orders/:id -> {id, eventId, qty, amount, state, expiresAt, updatedAt}; the UI polls this after
 * /pay. `amount` is what was charged (smallest currency unit), null until payment has been asked for.
 */
export function createOrdersRouter(): Router {
  const router = Router();

  router.get("/orders/:id", async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          eventId: true,
          qty: true,
          amount: true,
          state: true,
          expiresAt: true,
          updatedAt: true,
        },
      });
      if (!order) {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      res.json(order);
    } catch {
      res.status(500).json({ error: "INTERNAL" });
    }
  });

  return router;
}
