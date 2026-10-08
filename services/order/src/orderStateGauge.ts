import { Gauge } from "prom-client";
import { prisma } from "./db.js";

/** Orders per state, counted from Postgres at scrape time so it is always current. */
export const ordersByState = new Gauge({
  name: "orders_by_state",
  help: "Orders currently in each state.",
  labelNames: ["state"],
  async collect() {
    this.reset();
    for (const row of await prisma.order.groupBy({ by: ["state"], _count: { _all: true } })) {
      this.set({ state: row.state }, row._count._all);
    }
  },
});
