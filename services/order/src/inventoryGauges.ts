import type { Redis } from "ioredis";
import { Gauge } from "prom-client";
import { prisma } from "./db.js";
import { availKey, heldKey, soldKey } from "./redis/index.js";

// Key names owned by the ticket service (totalKey(), ACTIVE_EVENTS); kept in step by hand.
const ACTIVE_EVENTS = "events:active";
const totalKey = (eventId: string): string => `ev:${eventId}:total`;

/** Orders whose hold has not been settled yet: their quantity is still "held" in Redis. */
const OPEN_HOLD_STATES = ["HELD", "PAYMENT_PENDING", "PAID", "EXPIRED", "PAYMENT_FAILED"] as const;

/**
 * Registers the inventory gauges, read at scrape time so they are always current:
 *
 *   inventory_units{event,kind}  kind = avail | held | sold | total, all read from Redis. `held` is a
 *                                real counter: reserve.lua adds to it in the same atomic step that
 *                                takes the units from avail, and confirm.lua / release.lua take them out
 *                                again when they remove the hold. So avail + held + sold = total at
 *                                every instant, whatever the relay and the order worker are doing.
 *                                kind = held_db is the other side of the cross-check: the quantity of
 *                                orders whose hold is still open, from Postgres. It lags the counter
 *                                while orders are still being created, and has to catch up with it.
 *   oversell_units               PAID quantity above the stock, summed over events. Must stay 0.
 */
export function registerInventoryMetrics(redis: Redis): void {
  const state: { inventory: Gauge<"event" | "kind">; oversell: Gauge } = {
    inventory: new Gauge({
      name: "inventory_units",
      help: "Units per sale by kind: avail, held (open holds, from Postgres), sold, and the total stock.",
      labelNames: ["event", "kind"],
      async collect() {
        this.reset();
        const { perEvent } = await snapshot(redis);
        for (const [event, v] of perEvent) {
          for (const kind of ["avail", "held", "sold", "total", "held_db"] as const) {
            this.set({ event, kind }, v[kind]);
          }
        }
      },
    }),
    oversell: new Gauge({
      name: "oversell_units",
      help: "Units sold (PAID orders) above the stock, summed over sales. Must stay 0.",
      async collect() {
        const { perEvent } = await snapshot(redis);
        let over = 0;
        for (const v of perEvent.values()) {
          over += Math.max(v.paid - v.total, 0);
        }
        this.set(over);
      },
    }),
  };
  void state;
}

interface Units {
  avail: number;
  /** The Redis counter. */
  held: number;
  /** Orders with an open hold, from Postgres. */
  held_db: number;
  sold: number;
  total: number;
  paid: number;
}

async function snapshot(redis: Redis): Promise<{ perEvent: Map<string, Units> }> {
  const perEvent = new Map<string, Units>();
  for (const event of await redis.smembers(ACTIVE_EVENTS)) {
    const [total, avail, sold, held] = await Promise.all([
      redis.get(totalKey(event)),
      redis.get(availKey(event)),
      redis.get(soldKey(event)),
      redis.get(heldKey(event)),
    ]);
    if (total === null) {
      continue; // an event id left in the active set after its keys were deleted
    }
    perEvent.set(event, {
      total: Number(total),
      avail: Number(avail ?? 0),
      sold: Number(sold ?? 0),
      held: Number(held ?? 0),
      held_db: 0,
      paid: 0,
    });
  }
  if (perEvent.size === 0) {
    return { perEvent };
  }

  const ids = [...perEvent.keys()];
  const open = await prisma.order.groupBy({
    by: ["eventId"],
    where: { eventId: { in: ids }, holdSettledAt: null, state: { in: [...OPEN_HOLD_STATES] } },
    _sum: { qty: true },
  });
  for (const row of open) {
    const v = perEvent.get(row.eventId);
    if (v) {
      v.held_db = row._sum.qty ?? 0;
    }
  }
  const paid = await prisma.order.groupBy({
    by: ["eventId"],
    where: { eventId: { in: ids }, state: "PAID" },
    _sum: { qty: true },
  });
  for (const row of paid) {
    const v = perEvent.get(row.eventId);
    if (v) {
      v.paid = row._sum.qty ?? 0;
    }
  }
  return { perEvent };
}
