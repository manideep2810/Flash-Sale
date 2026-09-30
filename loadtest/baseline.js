// k6 load test for the baseline reserve variants.
//
//   VARIANT=atomic TARGET_RPS=2000 k6 run loadtest/baseline.js
//
// Env:
//   VARIANT     naive | pessimistic | atomic | optimistic   (required)
//   TARGET_RPS  peak arrival rate, requests/second          (required)
//   BASE_URL    ticket service origin (default http://localhost:3001)
//   EVENT_ID    inventory row to hammer (default baseline-load)
//
// Writes loadtest/results/<variant>-<rps>.json; run from the repo root.
//
// Live metrics in Grafana (http://localhost:3000, dashboard "k6 Baseline Reserve"):
//
//   make loadtest-baseline VARIANT=atomic TARGET_RPS=2000
//
// That adds `-o experimental-prometheus-rw`, which PUSHES to Prometheus' remote-write receiver
// (K6_PROMETHEUS_RW_SERVER_URL). Nothing in this script changes for it: the export is a k6 output,
// and the `variant` / `target_rps` tags in `options.tags` become Prometheus labels on every series.

import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";

const VARIANTS = ["naive", "pessimistic", "atomic", "optimistic"];

const VARIANT = __ENV.VARIANT;
const TARGET_RPS = Number(__ENV.TARGET_RPS);
const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const EVENT_ID = __ENV.EVENT_ID || "baseline-load";
const TOTAL = 1_000_000; // large enough that the run never sells out

if (!VARIANTS.includes(VARIANT)) {
  throw new Error(`VARIANT must be one of ${VARIANTS.join("|")}, got "${VARIANT}"`);
}
if (!Number.isInteger(TARGET_RPS) || TARGET_RPS < 1) {
  throw new Error(`TARGET_RPS must be a positive integer, got "${__ENV.TARGET_RPS}"`);
}

const reserveOk = new Counter("reserve_ok");
const reserveSoldOut = new Counter("reserve_sold_out");
const reserveError = new Counter("reserve_error");

const JSON_HEADERS = { "Content-Type": "application/json" };

export const options = {
  scenarios: {
    reserve: {
      executor: "ramping-arrival-rate",
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: Math.min(TARGET_RPS, 200),
      maxVUs: Math.max(TARGET_RPS * 2, 500),
      stages: [
        { target: TARGET_RPS, duration: "60s" }, // ramp 100 -> TARGET_RPS
        { target: TARGET_RPS, duration: "60s" }, // hold
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
  tags: { variant: VARIANT, target_rps: String(TARGET_RPS) },
};

export function setup() {
  const res = http.post(
    `${BASE_URL}/baseline/reset`,
    JSON.stringify({ eventId: EVENT_ID, total: TOTAL }),
    { headers: JSON_HEADERS, tags: { name: "reset" } },
  );
  if (res.status !== 200) {
    throw new Error(`reset failed: ${res.status} ${res.body}`);
  }
}

export default function () {
  const res = http.post(
    `${BASE_URL}/baseline/${VARIANT}/reserve`,
    JSON.stringify({ eventId: EVENT_ID, userId: `u-${__VU}-${__ITER}`, qty: 1 }),
    {
      headers: JSON_HEADERS,
      tags: { name: "reserve" },
      // 409 is a valid business outcome, not a transport failure.
      responseCallback: http.expectedStatuses(201, 409),
    },
  );

  if (res.status === 201) {
    reserveOk.add(1);
  } else if (res.status === 409) {
    reserveSoldOut.add(1);
  } else {
    reserveError.add(1);
  }

  check(res, { "reserve accepted": (r) => r.status === 201 });
}

export function handleSummary(data) {
  const path = `loadtest/results/${VARIANT}-${TARGET_RPS}.json`;
  return {
    stdout: textSummary(data),
    [path]: JSON.stringify(data, null, 2),
  };
}

// Compact console summary; the JSON file holds the full metric set.
function textSummary(data) {
  const m = data.metrics;
  const count = (name) => m[name]?.values?.count ?? 0;
  const p = (name, key) => m[name]?.values?.[key] ?? 0;
  const lines = [
    "",
    `baseline ${VARIANT} @ ${TARGET_RPS} rps`,
    `  reserve_ok        ${count("reserve_ok")}`,
    `  reserve_sold_out  ${count("reserve_sold_out")}`,
    `  reserve_error     ${count("reserve_error")}`,
    `  http_req_failed   ${(p("http_req_failed", "rate") * 100).toFixed(2)}%`,
    `  http_req_duration p50=${p("http_req_duration", "med").toFixed(1)}ms ` +
      `p95=${p("http_req_duration", "p(95)").toFixed(1)}ms ` +
      `p99=${p("http_req_duration", "p(99)").toFixed(1)}ms`,
    "",
  ];
  return lines.join("\n");
}
