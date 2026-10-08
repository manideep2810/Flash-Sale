import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@flash/observability";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Needs a Postgres schema with the order migrations applied, and it must be a dedicated test schema
// (its name ends in `_test`) because every test empties the Order and ProcessedEvent tables:
//   make test-order-db
// Skipped when DATABASE_URL is unset so plain `pnpm test` stays green.
const DATABASE_URL = process.env.DATABASE_URL;
const schema = DATABASE_URL ? new URL(DATABASE_URL).searchParams.get("schema") : null;
const enabled = Boolean(DATABASE_URL) && Boolean(schema?.endsWith("_test"));

if (DATABASE_URL && !enabled) {
  console.warn(
    `payment-flow tests skipped: DATABASE_URL schema "${schema}" is not a *_test schema`,
  );
}

const logger = createLogger({ service: "order", level: "silent" });

type Order = { id: string; userId: string };

describe.skipIf(!enabled)("pay, sweeper, timeout and result consumer, against Postgres", () => {
  // Loaded here, not at the top: src/config.ts reads the environment as soon as it is imported.
  let prisma: typeof import("../src/db.js").prisma;
  let orderTable: typeof import("../src/db.js").ORDER_TABLE;
  let orderState: typeof import("../src/db.js").ORDER_STATE_TYPE;
  let timeout: typeof import("../src/services/timeout-job.js");
  let sweeper: typeof import("../src/services/payment-sweeper.js");
  let payRoute: typeof import("../src/routes/pay.js");
  let results: typeof import("../src/consumers/payment-result.js");

  beforeAll(async () => {
    process.env.KAFKA_BROKERS ??= "localhost:19092";
    process.env.PORT ??= "3003";
    process.env.LOG_LEVEL ??= "error";
    ({
      prisma,
      ORDER_TABLE: orderTable,
      ORDER_STATE_TYPE: orderState,
    } = await import("../src/db.js"));
    timeout = await import("../src/services/timeout-job.js");
    sweeper = await import("../src/services/payment-sweeper.js");
    payRoute = await import("../src/routes/pay.js");
    results = await import("../src/consumers/payment-result.js");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.order.deleteMany();
    await prisma.processedEvent.deleteMany();
  });

  /** Inserts orders whose hold ends `expiresInMs` from the database's clock (negative: already over). */
  async function insertOrders(
    ids: string[],
    { state = "HELD", expiresInMs = 600_000 } = {},
  ): Promise<void> {
    for (const id of ids) {
      await prisma.$executeRaw`
        INSERT INTO ${orderTable} (id, "eventId", "userId", qty, state, "expiresAt", "updatedAt")
        VALUES (${id}, 'evt', ${`u-${id}`}, 1, ${state}::${orderState},
                (now() AT TIME ZONE 'UTC') + ${expiresInMs} * interval '1 millisecond',
                (now() AT TIME ZONE 'UTC'))`;
    }
  }

  const stateOf = async (id: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id } })).state;

  const backdate = (seconds: number) => prisma.$executeRaw`
    UPDATE ${orderTable}
       SET "paymentStartedAt" = (now() AT TIME ZONE 'UTC') - ${seconds} * interval '1 second'`;

  /** The pay router on a real listener, with a publisher that records (or fails) instead of using Kafka. */
  async function withPayServer(
    publish: (order: Order) => Promise<void>,
    run: (pay: (id: string) => Promise<Response>) => Promise<void>,
  ) {
    const app = express();
    app.use(payRoute.createPayRouter({ publish, logger }));
    const server: Server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await run((id) => fetch(`${base}/orders/${id}/pay`, { method: "POST" }));
    } finally {
      server.close();
      await once(server, "close");
    }
  }

  describe("POST /orders/:id/pay", () => {
    it("10 concurrent calls on one order: one request published, one 202, the rest 200", async () => {
      await insertOrders(["o-1"]);
      const published: Order[] = [];
      await withPayServer(
        async (order) => {
          published.push(order);
        },
        async (pay) => {
          const responses = await Promise.all(Array.from({ length: 10 }, () => pay("o-1")));
          const statuses = responses.map((r) => r.status).sort();
          expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
          for (const r of responses) {
            expect(await r.json()).toEqual({ state: "PAYMENT_PENDING" });
          }
        },
      );
      expect(published).toEqual([{ id: "o-1", userId: "u-o-1" }]);
      expect(await stateOf("o-1")).toBe("PAYMENT_PENDING");
    });

    it("after expiry: 409 HOLD_EXPIRED and nothing is published", async () => {
      await insertOrders(["o-1"], { expiresInMs: -1_000 });
      const published: Order[] = [];
      await withPayServer(
        async (order) => {
          published.push(order);
        },
        async (pay) => {
          const res = await pay("o-1");
          expect(res.status).toBe(409);
          expect(await res.json()).toMatchObject({ error: "HOLD_EXPIRED" });
        },
      );
      expect(published).toEqual([]);
      expect(await stateOf("o-1")).toBe("HELD");
    });

    it("answers 200 for PAID, 409 for a failed payment and 404 for an unknown order", async () => {
      await insertOrders(["paid"], { state: "PAID" });
      await insertOrders(["failed"], { state: "PAYMENT_FAILED" });
      await withPayServer(
        async () => {},
        async (pay) => {
          expect((await pay("paid")).status).toBe(200);
          const failed = await pay("failed");
          expect(failed.status).toBe(409);
          expect(await failed.json()).toMatchObject({ error: "NOT_PAYABLE" });
          expect((await pay("nope")).status).toBe(404);
        },
      );
    });
  });

  describe("stale sweeper", () => {
    it("a request lost after the UPDATE is re-published once the window passes, then left alone", async () => {
      await insertOrders(["o-1"]);
      let attempts = 0;
      // The "crash": the UPDATE committed, the publish never made it.
      await withPayServer(
        async () => {
          attempts++;
          throw new Error("broker away");
        },
        async (pay) => {
          expect((await pay("o-1")).status).toBe(202);
        },
      );
      expect(attempts).toBe(1);

      const published: Order[] = [];
      const publish = async (order: Order) => {
        published.push(order);
      };

      expect((await sweeper.sweepStalePayments(logger, publish)).republished).toBe(0); // too young
      await backdate(61);
      expect((await sweeper.sweepStalePayments(logger, publish)).republished).toBe(1);
      expect((await sweeper.sweepStalePayments(logger, publish)).republished).toBe(0); // clock refreshed
      expect(published).toEqual([{ id: "o-1", userId: "u-o-1" }]);
      expect(await stateOf("o-1")).toBe("PAYMENT_PENDING");
    });

    it("never touches HELD or already-resolved orders", async () => {
      await insertOrders(["held"]);
      await insertOrders(["paid"], { state: "PAID" });
      const published: Order[] = [];
      const result = await sweeper.sweepStalePayments(logger, async (o) => {
        published.push(o);
      });
      expect(result.republished).toBe(0);
      expect(published).toEqual([]);
    });
  });

  describe("timeout job", () => {
    it("does not expire a PAYMENT_PENDING order, even past its hold", async () => {
      await insertOrders(["o-1"], { state: "PAYMENT_PENDING", expiresInMs: -60_000 });
      const published: string[] = [];
      const result = await timeout.runTimeoutCycle(logger, async (event) => {
        published.push(event.orderId);
      });
      expect(result.expired).toBe(0);
      expect(published).toEqual([]);
      expect(await stateOf("o-1")).toBe("PAYMENT_PENDING");
    });

    it("expires a HELD order past its hold and publishes OrderExpired keyed by the order", async () => {
      await insertOrders(["o-1"], { expiresInMs: -1_000 });
      const published: { type: string; orderId: string; eventId: string }[] = [];
      await timeout.runTimeoutCycle(logger, async (event) => {
        published.push(event);
      });
      expect(published).toMatchObject([
        { type: "OrderExpired", orderId: "o-1", eventId: "o-1-expired-v1" },
      ]);
      expect(await stateOf("o-1")).toBe("EXPIRED");
    });

    it("an OrderExpired that fails to publish still leaves the order EXPIRED for the sweeper", async () => {
      await insertOrders(["o-1"], { expiresInMs: -1_000 });
      await timeout.runTimeoutCycle(logger, async () => {
        throw new Error("broker away");
      });
      expect(await stateOf("o-1")).toBe("EXPIRED");
    });
  });

  describe("payment result consumer", () => {
    const event = (orderId: string, status: "SUCCEEDED" | "FAILED", eventId = `${orderId}-e1`) => ({
      type: "PaymentProcessed" as const,
      orderId,
      eventId,
      status,
    });
    const capture = () => {
      const published: { type: string; orderId: string; eventId: string }[] = [];
      return {
        published,
        publish: async (e: { type: string; orderId: string; eventId: string }) => {
          published.push(e);
        },
      };
    };

    it("SUCCEEDED moves PAYMENT_PENDING to PAID, FAILED to PAYMENT_FAILED, each with its outcome event", async () => {
      await insertOrders(["ok", "bad"], { state: "PAYMENT_PENDING" });
      const out = capture();
      expect(await results.applyPaymentResult(event("ok", "SUCCEEDED"), logger, out.publish)).toBe(
        "paid",
      );
      expect(await results.applyPaymentResult(event("bad", "FAILED"), logger, out.publish)).toBe(
        "payment_failed",
      );
      expect(await stateOf("ok")).toBe("PAID");
      expect(await stateOf("bad")).toBe("PAYMENT_FAILED");
      expect(out.published).toMatchObject([
        { type: "OrderPaid", orderId: "ok" },
        { type: "OrderPaymentFailed", orderId: "bad" },
      ]);
    });

    it("the same event twice, or a repeat under a new event id, changes nothing and publishes nothing the second time", async () => {
      await insertOrders(["o-1"], { state: "PAYMENT_PENDING" });
      const out = capture();
      const apply = (id?: string) =>
        results.applyPaymentResult(event("o-1", "SUCCEEDED", id), logger, out.publish);
      expect(await apply()).toBe("paid");
      expect(await apply()).toBe("duplicate");
      expect(await apply("other")).toBe("duplicate");
      expect(await stateOf("o-1")).toBe("PAID");
      expect(out.published).toHaveLength(1);
    });

    it("a result for an order that is not PAYMENT_PENDING (EXPIRED) is a mismatch: state unchanged, nothing published", async () => {
      await insertOrders(["o-1"], { state: "EXPIRED" });
      const out = capture();
      expect(await results.applyPaymentResult(event("o-1", "SUCCEEDED"), logger, out.publish)).toBe(
        "mismatch",
      );
      expect(await stateOf("o-1")).toBe("EXPIRED");
      expect(out.published).toEqual([]);
    });

    it("a failed outcome publish does not undo or fail the update", async () => {
      await insertOrders(["o-1"], { state: "PAYMENT_PENDING" });
      const result = await results.applyPaymentResult(
        event("o-1", "SUCCEEDED"),
        logger,
        async () => {
          throw new Error("broker away");
        },
      );
      expect(result).toBe("paid");
      expect(await stateOf("o-1")).toBe("PAID");
    });
  });
});
