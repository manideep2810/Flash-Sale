// k6 flash-sale rush for the Phase 4 saga: reserve -> (wait) -> pay -> poll until the payment is decided.
//
//   k6 run loadtest/phase4.js           (normally started by tests/e2e/phase4/run-load.ts, which also
//                                        starts the stack, applies the chaos schedule and checks invariants)
//
// Env:
//   LABEL        name for the results file (default "run")
//   TICKET_URL   reserve API (default http://localhost:3001)
//   ORDER_URL    order API (default http://localhost:3003)
//   EVENT_ID     sale to hammer (default phase4-load); reset to TOTAL in setup()
//   TOTAL        units on sale (default 5000)
//   RATE         reserve attempts per second (default 5000)
//   DURATION     how long the rush lasts (default 60s)
//   PRE_VUS / MAX_VUS   VU pool; winners sleep inside their iteration, so MAX_VUS bounds in-flight journeys
//
// Every reserve that wins a hold follows one journey, chosen up front by the user id prefix the mock
// payment service keys on (NODE_ENV=test): 70% ok- (pays, succeeds), 10% fail- (pays, fails), 20% never pay.
// Writes loadtest/results/phase4-<LABEL>.json; run from the repo root.

import http from "k6/http";
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const TICKET_URL = __ENV.TICKET_URL || "http://localhost:3001";
const ORDER_URL = __ENV.ORDER_URL || "http://localhost:3003";
const EVENT_ID = __ENV.EVENT_ID || "phase4-load";
const TOTAL = Number(__ENV.TOTAL || 5000);
const RATE = Number(__ENV.RATE || 5000);
const DURATION = __ENV.DURATION || "60s";
const LABEL = __ENV.LABEL || "run";
const TERMINAL_TIMEOUT_S = Number(__ENV.TERMINAL_TIMEOUT_S || 240);

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 404, 409));

const reserveAttempts = new Counter("p4_reserve_attempts");
const winners = new Counter("p4_winners");
const soldOut = new Counter("p4_sold_out");
const paysAccepted = new Counter("p4_pays_accepted"); // 202
const paysRepeat = new Counter("p4_pays_repeat"); // 200
const paysRefused = new Counter("p4_pays_refused"); // 409 or gave up
const reachedTerminal = new Counter("p4_terminal");
const neverTerminal = new Counter("p4_never_terminal");
const reserveMs = new Trend("p4_reserve_ms", true);
const payMs = new Trend("p4_pay_ms", true);
const payToTerminalMs = new Trend("p4_pay_to_terminal_ms", true);

export const options = {
  tags: { run: LABEL },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    rush: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Number(__ENV.PRE_VUS || 1000),
      maxVUs: Number(__ENV.MAX_VUS || 6500),
      gracefulStop: "300s", // let the journeys that are mid-poll finish
    },
  },
};

export function setup() {
  const res = http.post(
    `${TICKET_URL}/redis/reset`,
    JSON.stringify({ eventId: EVENT_ID, total: TOTAL }),
    { headers: { "content-type": "application/json" } },
  );
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new Error(`reset answered ${res.status}`);
  }
}

const TERMINAL = ["PAID", "PAYMENT_FAILED", "RELEASED", "EXPIRED"];

export default function () {
  const roll = Math.random();
  const prefix = roll < 0.7 ? "ok" : roll < 0.8 ? "fail" : "plain";
  const userId = `${prefix}-${__VU}-${__ITER}`;

  reserveAttempts.add(1);
  const reserve = http.post(
    `${TICKET_URL}/redis/reserve`,
    JSON.stringify({ eventId: EVENT_ID, userId, qty: 1 }),
    { headers: { "content-type": "application/json" }, tags: { name: "reserve" } },
  );
  reserveMs.add(reserve.timings.duration);
  if (reserve.status === 409) {
    soldOut.add(1);
    return;
  }
  if (reserve.status !== 201) {
    return;
  }
  winners.add(1);
  if (prefix === "plain") {
    return; // never pays: its hold must expire
  }

  const orderId = JSON.parse(reserve.body).holdId;
  sleep(1 + Math.random() * 19);

  // The order is created asynchronously (relay -> Kafka -> order worker), so an early /pay can see 404.
  let pay;
  for (let attempt = 0; attempt < 10; attempt++) {
    pay = http.post(`${ORDER_URL}/orders/${encodeURIComponent(orderId)}/pay`, null, {
      tags: { name: "pay" },
    });
    if (pay.status !== 404) {
      break;
    }
    sleep(1);
  }
  payMs.add(pay.timings.duration);
  const paidAt = Date.now();
  if (pay.status === 202) {
    paysAccepted.add(1);
  } else if (pay.status === 200) {
    paysRepeat.add(1);
  } else {
    paysRefused.add(1);
    return;
  }

  for (let waited = 0; waited < TERMINAL_TIMEOUT_S; waited++) {
    const order = http.get(`${ORDER_URL}/orders/${encodeURIComponent(orderId)}`, {
      tags: { name: "poll" },
    });
    if (order.status === 200 && TERMINAL.indexOf(JSON.parse(order.body).state) !== -1) {
      payToTerminalMs.add(Date.now() - paidAt);
      reachedTerminal.add(1);
      return;
    }
    sleep(1);
  }
  neverTerminal.add(1);
}

export function handleSummary(data) {
  return { [`loadtest/results/phase4-${LABEL}.json`]: JSON.stringify(data, null, 2) };
}
