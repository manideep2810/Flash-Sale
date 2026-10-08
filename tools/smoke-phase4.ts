// End-to-end smoke test of the payment saga against the running stack.
//
//   pnpm -C tools run smoke-phase4
//
// reserve -> order appears (HELD) -> pay -> poll until the payment is decided -> the hold is settled
// -> invariant check. Prints the timeline and exits 0 or 1.
//
// Needs everything running: Redis/Postgres/Redpanda, the ticket service, the relay, order-api,
// order-worker and the payment service (`make dev`).

import { setTimeout as sleep } from "node:timers/promises";
import { checkInvariants, printReport } from "./check-invariants.js";

const TICKET_URL = process.env.TICKET_URL ?? "http://localhost:3001";
const ORDER_URL = process.env.ORDER_URL ?? "http://localhost:3003";
const EVENT_ID = process.env.EVENT_ID ?? `evt-smoke-${Date.now()}`;
const TOTAL = Number(process.env.TOTAL ?? 100);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);

const startedAt = Date.now();
const timeline: string[] = [];
const mark = (what: string) => {
  const line = `+${String(Date.now() - startedAt).padStart(6)}ms  ${what}`;
  timeline.push(line);
  console.log(line);
};

/** The few fields of the services' replies this script reads. */
interface Reply {
  holdId?: string;
  state?: string;
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: Reply }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Reply) : {} };
}

const post = (url: string, body?: unknown) =>
  json(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function poll<T>(what: string, done: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await done();
    if (value !== undefined) {
      return value;
    }
    await sleep(200);
  }
  throw new Error(`timed out after ${TIMEOUT_MS}ms waiting for ${what}`);
}

async function main(): Promise<boolean> {
  mark(`reset event ${EVENT_ID} to ${TOTAL} tickets`);
  const reset = await post(`${TICKET_URL}/redis/reset`, { eventId: EVENT_ID, total: TOTAL });
  if (reset.status >= 300) {
    throw new Error(`reset answered ${reset.status}`);
  }

  const reserve = await post(`${TICKET_URL}/redis/reserve`, {
    eventId: EVENT_ID,
    userId: "smoke-user",
    qty: 2,
  });
  if (reserve.status !== 201) {
    throw new Error(`reserve answered ${reserve.status} ${JSON.stringify(reserve.body)}`);
  }
  const orderId = reserve.body.holdId;
  if (!orderId) {
    throw new Error("reserve returned no holdId");
  }
  mark(`reserved: hold ${orderId}`);

  await poll("the order to appear", async () => {
    const o = await json(`${ORDER_URL}/orders/${encodeURIComponent(orderId)}`);
    return o.status === 200 ? o.body : undefined;
  });
  mark("order created in state HELD (relay -> Kafka -> order worker)");

  const pay = await post(`${ORDER_URL}/orders/${encodeURIComponent(orderId)}/pay`);
  mark(`pay answered ${pay.status} ${JSON.stringify(pay.body)}`);
  if (pay.status !== 202) {
    throw new Error("pay was not accepted");
  }

  // PAYMENT_FAILED is followed by RELEASED once the hold is settled, so either ends the wait.
  const decided = await poll("the payment to be decided", async () => {
    const o = await json(`${ORDER_URL}/orders/${encodeURIComponent(orderId)}`);
    const state = o.body.state;
    return state && ["PAID", "PAYMENT_FAILED", "RELEASED"].includes(state) ? state : undefined;
  });
  mark(`payment decided: order is ${decided}`);

  mark("checking the invariants");
  const report = await checkInvariants({ eventIds: [EVENT_ID] });
  printReport(report);
  return report.pass;
}

try {
  const ok = await main();
  console.log(`\n${ok ? "SMOKE PASS" : "SMOKE FAIL"}`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(`\nSMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  console.log("\ntimeline so far:");
  for (const line of timeline) {
    console.log(`  ${line}`);
  }
  process.exit(1);
}
