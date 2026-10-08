import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createLogger } from "@flash/observability";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Needs a Postgres schema with the payment-mock migrations applied, and it must be a dedicated test
// schema (its name ends in `_test`) because every test empties the Payment table:
//   make test-payment-db
// Skipped when DATABASE_URL is unset so plain `pnpm test` stays green.
const DATABASE_URL = process.env.DATABASE_URL;
const schema = DATABASE_URL ? new URL(DATABASE_URL).searchParams.get("schema") : null;
const enabled = Boolean(DATABASE_URL) && Boolean(schema?.endsWith("_test"));

if (DATABASE_URL && !enabled) {
  console.warn(
    `payment-requests tests skipped: DATABASE_URL schema "${schema}" is not a *_test schema`,
  );
}

const logger = createLogger({ service: "payment-mock", level: "silent" });

describe.skipIf(!enabled)("payment request handling, against Postgres", () => {
  // Loaded here, not at the top: src/config.ts reads the environment as soon as it is imported.
  let prisma: typeof import("../src/db.js").prisma;
  let store: import("../src/paymentStore.js").PaymentStore;
  let handler: typeof import("../src/handlers/paymentRequested.js");
  let chargesRoute: typeof import("../src/routes/charges.js");

  beforeAll(async () => {
    process.env.KAFKA_BROKERS ??= "localhost:19092";
    process.env.PORT ??= "3004";
    process.env.LOG_LEVEL ??= "error";
    ({ prisma } = await import("../src/db.js"));
    store = (await import("../src/paymentStore.js")).createPrismaStore();
    handler = await import("../src/handlers/paymentRequested.js");
    chargesRoute = await import("../src/routes/charges.js");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.payment.deleteMany();
  });

  /** Counts charges and records what is published; `outcome` decides each charge, `latencyMs` makes them overlap. */
  function fakes(
    options: { outcome?: "SUCCEEDED" | "FAILED"; latencyMs?: number; failPublishes?: number } = {},
  ) {
    const { outcome = "SUCCEEDED", latencyMs = 0, failPublishes = 0 } = options;
    const charges: string[] = [];
    const published: import("../src/handlers/paymentRequested.js").PaymentProcessedEvent[] = [];
    let publishFailuresLeft = failPublishes;
    return {
      charges,
      published,
      deps: {
        store,
        charge: async (orderId: string) => {
          charges.push(orderId);
          await new Promise((r) => setTimeout(r, latencyMs));
          return { status: outcome, chargeId: `ch_${charges.length}` };
        },
        publish: async (
          event: import("../src/handlers/paymentRequested.js").PaymentProcessedEvent,
        ) => {
          if (publishFailuresLeft > 0) {
            publishFailuresLeft--;
            throw new Error("broker away");
          }
          published.push(event);
        },
      },
    };
  }

  const request = { orderId: "o-1", amount: 999 };
  const rows = () => prisma.payment.findMany();
  const backdate = (seconds: number) =>
    prisma.payment.updateMany({ data: { updatedAt: new Date(Date.now() - seconds * 1000) } });

  it("a new request is charged once, stored and published", async () => {
    const f = fakes({ outcome: "FAILED" });
    expect(await handler.handlePaymentRequested(request, f.deps, logger)).toBe("charged");

    expect(f.charges).toEqual(["o-1"]);
    const [row] = await rows();
    expect(row).toMatchObject({
      orderId: "o-1",
      idempotencyKey: "o-1",
      amount: 999,
      status: "FAILED",
    });
    expect(row?.chargeId).toBe("ch_1");
    expect(f.published).toHaveLength(1);
    expect(f.published[0]).toMatchObject({
      type: "PaymentProcessed",
      eventId: "o-1-payment-v1",
      orderId: "o-1",
      status: "FAILED",
    });
  });

  it("10 concurrent copies of one request: one row, one charge", async () => {
    const f = fakes({ latencyMs: 50 });
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => handler.handlePaymentRequested(request, f.deps, logger)),
    );

    expect(f.charges).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect(outcomes.filter((o) => o === "charged")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "in_flight" || o === "replayed")).toHaveLength(9);
  });

  it("a repeat after the decision re-publishes the stored status and does not charge again", async () => {
    const f = fakes({ outcome: "SUCCEEDED" });
    await handler.handlePaymentRequested(request, f.deps, logger);
    // Even if the gateway would now say something else, the stored answer stands.
    const other = fakes({ outcome: "FAILED" });
    const result = await handler.handlePaymentRequested(request, { ...other.deps }, logger);

    expect(result).toBe("replayed");
    expect(other.charges).toEqual([]);
    expect(other.published.map((e) => e.status)).toEqual(["SUCCEEDED"]);
    expect(other.published[0]?.eventId).toBe("o-1-payment-v1");
    expect(await rows()).toHaveLength(1);
  });

  it("a lost PaymentProcessed: the redelivered request publishes the stored result, no second charge", async () => {
    const f = fakes({ failPublishes: 1 });
    await expect(handler.handlePaymentRequested(request, f.deps, logger)).rejects.toThrow(
      "broker away",
    );
    expect(f.published).toEqual([]);
    expect((await rows())[0]?.status).toBe("SUCCEEDED"); // charged and stored before the publish failed

    expect(await handler.handlePaymentRequested(request, f.deps, logger)).toBe("replayed");
    expect(f.charges).toHaveLength(1);
    expect(f.published.map((e) => e.status)).toEqual(["SUCCEEDED"]);
  });

  it("a fresh PROCESSING row belongs to another worker: skipped, nothing charged or published", async () => {
    await store.insertProcessing("o-1", 999);
    const f = fakes();
    expect(await handler.handlePaymentRequested(request, f.deps, logger)).toBe("in_flight");
    expect(f.charges).toEqual([]);
    expect(f.published).toEqual([]);
  });

  it("a PROCESSING row stuck for over 30s is charged again, by exactly one of several redeliveries", async () => {
    await store.insertProcessing("o-1", 999); // the "crash": inserted, never completed
    await backdate(31);

    const f = fakes({ latencyMs: 30 });
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => handler.handlePaymentRequested(request, f.deps, logger)),
    );

    expect(outcomes.filter((o) => o === "recharged")).toHaveLength(1);
    expect(f.charges).toHaveLength(1);
    expect((await rows())[0]?.status).toBe("SUCCEEDED");
    expect(f.published.filter((e) => e.orderId === "o-1").length).toBeGreaterThanOrEqual(1);
  });

  describe("GET /charges/:orderId", () => {
    it("returns the stored payment, and 404 for an unknown order", async () => {
      await handler.handlePaymentRequested(request, fakes().deps, logger);
      const app = express();
      app.use(chargesRoute.createChargesRouter(store));
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const found = await fetch(`${base}/charges/o-1`);
        expect(found.status).toBe(200);
        expect(await found.json()).toMatchObject({
          orderId: "o-1",
          amount: 999,
          status: "SUCCEEDED",
        });
        expect((await fetch(`${base}/charges/nope`)).status).toBe(404);
      } finally {
        server.close();
        await once(server, "close");
      }
    });
  });
});
