import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkInvariants } from "../../../tools/check-invariants.js";
import { describeReport, Harness, waitFor } from "./support.js";

// Phase 4 failure scenarios I-N: a service is stopped, or crashes at a named point (FAULT_POINT, which
// exits 137 only under NODE_ENV=test), and the system has to recover on its own. As in the functional
// file, every scenario ends with a quiet-system wait and the invariant checker, and a failing
// assertion is a finding to report, not something to loosen.

const h = new Harness();
// A hard-killed consumer stays in its group until the 45s session timeout, so a restarted process
// may not receive anything for that long, and it then has its own recovery windows on top.
const RECOVERY_MS = 240_000;
const CRASH_MS = 180_000;

let mismatchBaseline = 0;
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
  await h.disarm();
  await h.ensureUp();
  await h.waitQuiet(RECOVERY_MS);
  const report = await checkInvariants({
    eventIds: h.testSales,
    expectedMismatches: mismatchBaseline + extraMismatches,
  });
  expect(report.pass, `invariants violated:\n${describeReport(report)}`).toBe(true);
  await h.resetTables();
});

/** Stops a service and starts it again with a crash point armed. */
async function arm(
  proc: { kill(): Promise<void>; start(fault?: string): Promise<void> },
  point: string,
) {
  await proc.kill();
  await proc.start(point);
}

/** Replaces the crashed process with a clean one (no fault point). */
async function recover(proc: { kill(): Promise<void>; start(fault?: string): Promise<void> }) {
  await proc.kill();
  await proc.start();
}

describe("Phase 4 failure scenarios", () => {
  it("I. payment service down: /pay still answers 202, and the order resolves once it is back", async () => {
    const sale = await h.createSale(10, "I");
    const orderId = await h.reserveOrder(sale, "ok-I");
    await h.stack.payment.kill();

    expect((await h.pay(orderId)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 6_000)); // several sweeps with nobody to answer
    expect(await h.stateOf(orderId)).toBe("PAYMENT_PENDING");

    await h.stack.payment.start();
    const final = await h.waitForState(orderId, ["PAID"], RECOVERY_MS);
    expect(final).toBe("PAID");
    expect(await h.paymentsFor(orderId)).toHaveLength(1);
  });

  it("J. lost PaymentRequested (crash after the UPDATE, before the publish): the sweeper re-publishes, one charge", async () => {
    const sale = await h.createSale(10, "J");
    const orderId = await h.reserveOrder(sale, "ok-J");
    await arm(h.stack.orderApi, "after_pay_update_before_publish");

    // The API dies mid-request, so the caller sees a dropped connection, not a status.
    await h.pay(orderId).then(
      (res) => res.arrayBuffer(),
      () => undefined,
    );
    expect(await h.stack.orderApi.exited(10_000)).toBe(137);
    expect(await h.stateOf(orderId)).toBe("PAYMENT_PENDING");
    expect(await h.paymentsFor(orderId)).toEqual([]); // nothing was ever requested

    await recover(h.stack.orderApi);
    await h.waitForState(orderId, ["PAID"], RECOVERY_MS);
    expect(await h.paymentsFor(orderId)).toHaveLength(1);
  });

  it("K. lost PaymentProcessed (crash after storing the result, before publishing): replayed, still one charge", async () => {
    const sale = await h.createSale(10, "K");
    const orderId = await h.reserveOrder(sale, "ok-K");
    await arm(h.stack.payment, "after_payment_store_before_publish");

    expect((await h.pay(orderId)).status).toBe(202);
    expect(await h.stack.payment.exited(CRASH_MS)).toBe(137);
    const [stored] = await h.paymentsFor(orderId);
    expect(stored).toMatchObject({ status: "SUCCEEDED" }); // decided and stored, never announced
    expect(await h.stateOf(orderId)).toBe("PAYMENT_PENDING");

    await recover(h.stack.payment);
    await h.waitForState(orderId, ["PAID"], RECOVERY_MS);
    const rows = await h.paymentsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chargeId).toBe(stored?.chargeId); // the stored result was replayed, not recomputed
  });

  it("L. crash before the charge (row inserted PROCESSING): recovered, exactly one charge", async () => {
    const sale = await h.createSale(10, "L");
    const orderId = await h.reserveOrder(sale, "ok-L");
    await arm(h.stack.payment, "after_payment_insert_before_charge");

    expect((await h.pay(orderId)).status).toBe(202);
    expect(await h.stack.payment.exited(CRASH_MS)).toBe(137);
    expect(await h.paymentsFor(orderId)).toMatchObject([{ status: "PROCESSING", chargeId: null }]);

    await recover(h.stack.payment);
    await h.waitForState(orderId, ["PAID"], RECOVERY_MS);
    const rows = await h.paymentsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(rows[0]?.chargeId).toBeTruthy();
  });

  it("M1. settlement crash after confirming a PAID order's hold: the backstop completes it, sold changes once", async () => {
    const sale = await h.createSale(10, "M1");
    const orderId = await h.reserveOrder(sale, "ok-M1", 2);
    await arm(h.stack.orderWorker, "after_redis_settle_before_db_update");

    expect((await h.pay(orderId)).status).toBe(202);
    expect(await h.stack.orderWorker.exited(CRASH_MS)).toBe(137);
    // Redis moved (hold -> sold) before the crash; Postgres did not.
    expect(await h.inventory(sale)).toEqual({ avail: 8, sold: 2, holds: [] });
    expect((await h.order(orderId))?.holdSettledAt).toBeNull();

    await recover(h.stack.orderWorker);
    await waitFor("the hold to be marked settled", RECOVERY_MS, async () => {
      return (await h.order(orderId))?.holdSettledAt != null;
    });
    expect(await h.inventory(sale)).toEqual({ avail: 8, sold: 2, holds: [] }); // changed exactly once
    expect(await h.stateOf(orderId)).toBe("PAID");
  });

  it("M2. settlement crash after releasing an expired order's hold: the backstop completes it, avail restored once", async () => {
    const sale = await h.createSale(10, "M2");
    const orderId = await h.reserveOrder(sale, "plain-M2", 2);
    await arm(h.stack.orderWorker, "after_redis_settle_before_db_update");

    expect(await h.stack.orderWorker.exited(CRASH_MS)).toBe(137); // dies when the hold expires and is released
    expect(await h.inventory(sale)).toEqual({ avail: 10, sold: 0, holds: [] });
    expect(await h.stateOf(orderId)).toBe("EXPIRED");

    await recover(h.stack.orderWorker);
    await h.waitForState(orderId, ["RELEASED"], RECOVERY_MS);
    expect(await h.inventory(sale)).toEqual({ avail: 10, sold: 0, holds: [] }); // not 12
  });

  it("N. late result: PaymentProcessed SUCCEEDED for an EXPIRED order leaves it alone and counts a mismatch", async () => {
    const sale = await h.createSale(10, "N");
    const orderId = await h.reserveOrder(sale, "ok-N");
    // Force the order to EXPIRED behind the timeout job's back, then deliver a late success.
    await h.orders.query(
      `UPDATE "order_e2e"."Order" SET state = 'EXPIRED', "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE id = $1`,
      [orderId],
    );
    extraMismatches = 1;
    await h.produce("payments.events", orderId, {
      type: "PaymentProcessed",
      eventId: "manual-N-1",
      orderId,
      status: "SUCCEEDED",
    });

    await waitFor("payment_state_mismatch_total to rise by 1", 60_000, async () => {
      return (await h.workerMetric("payment_state_mismatch_total")) === mismatchBaseline + 1;
    });
    const state = await h.stateOf(orderId);
    expect(["EXPIRED", "RELEASED"]).toContain(state); // never PAID
    expect(await h.paymentsFor(orderId)).toEqual([]);
    // The known gap: nothing refunds a late success in this phase.
  });
});
