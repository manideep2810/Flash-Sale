import { Counter, Gauge } from "prom-client";
import { prisma } from "./db.js";

/** Charges decided by this service (a repeat of a decided charge is not counted again). */
export const paymentsDecided = new Counter({
  name: "payments_decided_total",
  help: "Mock charges decided, by outcome.",
  labelNames: ["status"],
});

/** Orders with more than one payments row. The unique key makes this 0; the gauge watches it. */
export const paymentDoubleCharges = new Gauge({
  name: "payment_double_charges",
  help: "Orders that have more than one payments row. Must stay 0.",
  async collect() {
    const doubled = await prisma.payment.groupBy({
      by: ["orderId"],
      having: { orderId: { _count: { gt: 1 } } },
    });
    this.set(doubled.length);
  },
});
