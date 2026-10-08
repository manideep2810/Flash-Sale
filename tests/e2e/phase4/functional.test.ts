import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkInvariants } from "../../../tools/check-invariants.js";
import { describeReport, Harness, record, TIMERS, waitFor } from "./support.js";

// Phase 4 functional scenarios A-H and O, as a black box over HTTP with direct reads of Postgres and
// Redis to check the results. Every scenario ends the same way: wait for the system to go quiet, then
// run the invariant checker. A failing assertion is a finding, not something to loosen.
//
//   pnpm run test:e2e        (needs `make up`, and nothing else listening on 3001-3004 / 3006)

const h = new Harness();
const SLACK_MS = 5_000;
const intervals = TIMERS.TIMEOUT_JOB_INTERVAL_MS + TIMERS.SWEEPER_INTERVAL_MS;

let mismatchBaseline = 0;
/** What a scenario that provokes mismatches adds to the baseline (scenario N, in the other file). */
let extraMismatches = 0;

beforeAll(async () => {
  await h.startAll();
  // Whatever an earlier run left in flight (stale commands, open holds) finishes first, then the tables
  // are emptied, so a leftover message cannot show up as a payment for an order that is gone.
  await h.waitQuiet(240_000).catch(() => {});
  await h.resetTables();
});

afterAll(async () => {
  await h.stopAll();
});

beforeEach(async () => {
  await h.ensureUp();
  h.testSales = [];
  extraMismatches = 0;
  mismatchBaseline = await h.workerMetric("payment_state_mismatch_total");
});

afterEach(async () => {
  await h.ensureUp();
  await h.waitQuiet();
  const report = await checkInvariants({
    eventIds: h.testSales,
    expectedMismatches: mismatchBaseline + extraMismatches,
  });
  expect(report.pass, `invariants violated:\n${describeReport(report)}`).toBe(true);
  await h.resetTables();
});

describe("Phase 4 functional scenarios", () => {
  it("A. happy path: reserve -> pay (ok-) -> PAID; sold += qty, held -= qty", async () => {
    const sale = await h.createSale(10, "A");
    const orderId = await h.reserveOrder(sale, "ok-A", 2);
    expect(await h.inventory(sale)).toMatchObject({ avail: 8, sold: 0, holds: [orderId] });

    const paidAt = Date.now();
    expect((await h.pay(orderId)).status).toBe(202);
    await waitFor("GET /orders/:id to say PAID", 30_000, async () => {
      return (await h.apiOrder(orderId))?.state === "PAID";
    });
    const payToPaidMs = Date.now() - paidAt;
    record("A_pay_to_paid_ms", payToPaidMs);

    await h.waitQuiet();
    expect(await h.inventory(sale)).toEqual({ avail: 8, sold: 2, holds: [] });
    expect((await h.order(orderId))?.holdSettledAt).not.toBeNull();
    expect(await h.paymentsFor(orderId)).toMatchObject([{ status: "SUCCEEDED" }]);
  });

  it("B. payment failure (fail-): PAYMENT_FAILED -> RELEASED, avail restored by exactly qty", async () => {
    const sale = await h.createSale(10, "B");
    const orderId = await h.reserveOrder(sale, "fail-B", 3);
    expect((await h.inventory(sale)).avail).toBe(7);

    expect((await h.pay(orderId)).status).toBe(202);
    await h.waitForState(orderId, ["RELEASED"]);

    expect(await h.inventory(sale)).toEqual({ avail: 10, sold: 0, holds: [] });
    expect((await h.order(orderId))?.holdSettledAt).not.toBeNull();
    expect(await h.paymentsFor(orderId)).toMatchObject([{ status: "FAILED" }]);
  });

  it("C. no payment: reserve, never pay -> EXPIRED -> RELEASED within HOLD_TTL + 2 x intervals", async () => {
    const sale = await h.createSale(10, "C");
    const reservedAt = Date.now();
    const orderId = await h.reserveOrder(sale, "plain-C", 2);
    expect((await h.inventory(sale)).avail).toBe(8);

    await h.waitForState(orderId, ["RELEASED"], 60_000);
    const elapsed = Date.now() - reservedAt;
    record("C_reserve_to_released_ms", elapsed);
    record("C_budget_ms", TIMERS.HOLD_TTL_SEC * 1000 + 2 * intervals + SLACK_MS);
    expect(elapsed).toBeLessThanOrEqual(TIMERS.HOLD_TTL_SEC * 1000 + 2 * intervals + SLACK_MS);

    expect(await h.inventory(sale)).toEqual({ avail: 10, sold: 0, holds: [] });
    expect(await h.paymentsFor(orderId)).toEqual([]);
  });

  it("D. double click: 20 concurrent /pay on one order -> one 202, the rest 200; one payments row", async () => {
    const sale = await h.createSale(10, "D");
    const orderId = await h.reserveOrder(sale, "ok-D");

    const responses = await Promise.all(Array.from({ length: 20 }, () => h.pay(orderId)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(19);

    await h.waitForState(orderId, ["PAID"]);
    await h.waitQuiet();
    const rows = await h.paymentsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chargeId).toBeTruthy(); // charged exactly once
    expect(await h.inventory(sale)).toMatchObject({ avail: 9, sold: 1 });
  });

  it("E. pay after expiry -> 409 HOLD_EXPIRED; no payments row; order RELEASED", async () => {
    const sale = await h.createSale(10, "E");
    const orderId = await h.reserveOrder(sale, "ok-E");
    await h.waitForState(orderId, ["RELEASED"], 60_000);

    const res = await h.pay(orderId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "HOLD_EXPIRED" });
    expect(await h.paymentsFor(orderId)).toEqual([]);
    expect(await h.stateOf(orderId)).toBe("RELEASED");
  });

  it("E2. pay the moment the hold ends (before the timeout job has run) -> 409 HOLD_EXPIRED", async () => {
    const sale = await h.createSale(10, "E2");
    const orderId = await h.reserveOrder(sale, "ok-E2");
    const expiresAt = (await h.order(orderId))?.expiresAt.getTime() ?? 0;
    const wait = expiresAt - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(wait, 0) + 30));

    const res = await h.pay(orderId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "HOLD_EXPIRED" });
    expect(await h.paymentsFor(orderId)).toEqual([]);
  });

  it("F. boundary race: 100 orders paid at their expiry instant while the timeout job runs -> exactly one path each", async () => {
    const sale = await h.createSale(200, "F");
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      ids.push(
        ...(await Promise.all(
          Array.from({ length: 10 }, (_, i) => h.reserveOrder(sale, `ok-F-${batch}-${i}`)),
        )),
      );
    }

    // Each /pay fires within +-40ms of that order's own expiry.
    const outcomes = await Promise.all(
      ids.map(async (id) => {
        const expiresAt = (await h.order(id))?.expiresAt.getTime() ?? 0;
        const jitter = Math.round(Math.random() * 80) - 40;
        await new Promise((r) => setTimeout(r, Math.max(expiresAt - Date.now() + jitter, 0)));
        return { id, status: (await h.pay(id)).status };
      }),
    );
    for (const o of outcomes) {
      expect([200, 202, 409], `pay answered ${o.status} for ${o.id}`).toContain(o.status);
    }

    await h.waitQuiet(180_000);
    let paid = 0;
    let released = 0;
    for (const { id, status } of outcomes) {
      const state = await h.stateOf(id);
      const rows = await h.paymentsFor(id);
      expect(rows.length, `${id} has ${rows.length} payment rows`).toBeLessThanOrEqual(1);
      if (rows[0]?.status === "SUCCEEDED") {
        expect(state, `${id} was charged (SUCCEEDED) but is ${state}`).toBe("PAID");
        paid++;
      } else if (rows.length === 0) {
        // Never charged: it must have gone the expiry way, and /pay must not have been accepted.
        expect(state, `${id} has no payment but is ${state}`).toBe("RELEASED");
        expect(status, `${id} was accepted (202) yet never charged`).not.toBe(202);
        released++;
      } else {
        expect(state).toBe("RELEASED"); // payment failed, hold released
        released++;
      }
    }
    record("F_paid", paid);
    record("F_released", released);
    expect(paid + released).toBe(ids.length);
  });

  it("G. duplicate PaymentProcessed: the same event 3 times -> one state change", async () => {
    const sale = await h.createSale(10, "G");
    const orderId = await h.reserveOrder(sale, "ok-G");
    // No real answer can arrive while the payment service is down, so the order stays PAYMENT_PENDING.
    await h.stack.payment.kill();
    expect((await h.pay(orderId)).status).toBe(202);

    const event = { type: "PaymentProcessed", eventId: "manual-G-1", orderId, status: "SUCCEEDED" };
    for (let i = 0; i < 3; i++) {
      await h.produce("payments.events", orderId, event);
    }
    await h.waitForState(orderId, ["PAID"]);
    await h.waitQuiet(60_000).catch(() => {}); // the stale request keeps the payment service's lag up

    const processed = await h.orders.query(
      `SELECT 1 FROM "order_e2e"."ProcessedEvent" WHERE "eventId" = 'manual-G-1'`,
    );
    expect(processed.rowCount).toBe(1);
    expect(await h.inventory(sale)).toMatchObject({ avail: 9, sold: 1 });
    expect(await h.workerMetric("payment_state_mismatch_total")).toBe(mismatchBaseline);

    // Bring the payment service back: the real answer (SUCCEEDED, same target) is a harmless repeat.
    await h.stack.payment.start();
  });

  it("H. duplicate PaymentRequested: 3 more copies -> one payments row, no second charge, result replayed", async () => {
    const sale = await h.createSale(10, "H");
    const orderId = await h.reserveOrder(sale, "ok-H");
    expect((await h.pay(orderId)).status).toBe(202);
    await h.waitForState(orderId, ["PAID"]);
    const [before] = await h.paymentsFor(orderId);

    for (let i = 0; i < 3; i++) {
      await h.produce("payments.commands", orderId, {
        type: "PaymentRequested",
        eventId: `manual-H-${i}`,
        orderId,
        userId: "ok-H",
        amount: 999,
        timestamp: new Date().toISOString(),
      });
    }
    await h.waitQuiet();

    const rows = await h.paymentsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chargeId).toBe(before?.chargeId); // same charge: nothing was charged again
    expect(await h.stateOf(orderId)).toBe("PAID");
    expect(await h.inventory(sale)).toMatchObject({ avail: 9, sold: 1 });
  });

  it("O. a PAYMENT_PENDING order past expires_at is not expired by the timeout job", async () => {
    const sale = await h.createSale(10, "O");
    const orderId = await h.reserveOrder(sale, "ok-O");
    await h.stack.payment.kill(); // keeps it PAYMENT_PENDING
    expect((await h.pay(orderId)).status).toBe(202);

    const expiresAt = (await h.order(orderId))?.expiresAt.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, Math.max(expiresAt - Date.now(), 0) + 4_000));
    expect(await h.stateOf(orderId)).toBe("PAYMENT_PENDING");

    // Once the payment service is back it is decided like any other (claimed inside its hold).
    await h.stack.payment.start();
    const final = await h.waitForState(orderId, ["PAID", "PAYMENT_FAILED", "RELEASED"], 120_000);
    expect(["PAID", "RELEASED"]).toContain(final);
  });
});
