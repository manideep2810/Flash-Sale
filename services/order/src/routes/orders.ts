import { Router } from "express";
import { prisma } from "../db.js";

/** GET /orders/:id -> {id, state, expiresAt, updatedAt}; the UI polls this after /pay. */
export function createOrdersRouter(): Router {
  const router = Router();

  router.get("/orders/:id", async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: { id: true, state: true, expiresAt: true, updatedAt: true },
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
