// Runs one Phase 4 load run: starts the stack, runs the k6 rush, optionally applies the chaos
// schedule, waits for the system to go quiet, checks the invariants and writes the numbers.
//
//   pnpm -C tests/e2e exec tsx phase4/run-load.ts run1
//   pnpm -C tests/e2e exec tsx phase4/run-load.ts run2          (chaos: payment-svc down 20s-40s, one worker killed at 30s)
//
// Env: PAYMENT_REPLICAS (default 4) and PAYMENT_CONCURRENCY (default 20) set the payment layout;
// RESULT_CONSUMER_CONCURRENCY (default 12); TICKET_WORKERS (default 8); RATE, TOTAL, DURATION are passed to k6.
// Output: loadtest/results/phase4-<run>.json (k6 summary) and docs/results/raw/phase4-<run>.json (everything).

import "./load-env.js";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { checkInvariants } from "../../../tools/check-invariants.js";
import { describeReport, Harness, ROOT } from "./support.js";

const run = process.argv[2] ?? "run1";
const chaos = run === "run2";
const TOTAL = Number(process.env.TOTAL ?? 5000);
const EVENT_ID = `phase4-${run}`;
const PROM = process.env.PROMETHEUS_URL ?? "http://localhost:9090";

// 4 payment processes x 20 concurrent = 80, matching the 80 partitions of payments.commands.
const PAYMENT_CONCURRENCY = process.env.PAYMENT_CONCURRENCY ?? "20";
const PAYMENT_REPLICAS = Number(process.env.PAYMENT_REPLICAS ?? 4) as 1 | 2 | 3 | 4;
const RESULT_CONCURRENCY = process.env.RESULT_CONSUMER_CONCURRENCY ?? "12";

// The scenarios run the ticket service with 2 workers; at 5,000 requests a second that is far too few.
// Leave CPU for k6, the order and payment services and Docker, which share this machine.
const TICKET_WORKERS = process.env.TICKET_WORKERS ?? "8";

const h = new Harness({
  ticketWorkers: TICKET_WORKERS,
  holdTtlSec: 60,
  paymentConcurrency: PAYMENT_CONCURRENCY,
  paymentReplicas: PAYMENT_REPLICAS,
  resultConcurrency: RESULT_CONCURRENCY,
  workerReplicas: chaos ? 2 : 1,
});

const timeline: { atMs: number; what: string }[] = [];
let t0 = Date.now();
const mark = (what: string) => {
  const atMs = Date.now() - t0;
  timeline.push({ atMs, what });
  console.log(`+${String(Math.round(atMs / 1000)).padStart(4)}s  ${what}`);
};

async function prom(
  query: string,
  start: number,
  end: number,
  step = 5,
): Promise<[number, number][]> {
  const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start / 1000}&end=${end / 1000}&step=${step}`;
  const body = (await (await fetch(url)).json()) as {
    data: { result: { values: [number, string][] }[] };
  };
  const first = body.data.result[0];
  return first ? first.values.map(([t, v]) => [t, Number(v)]) : [];
}

const maxOf = (series: [number, number][]) => series.reduce((m, [, v]) => Math.max(m, v), 0);

async function main() {
  await h.startAll();
  // Whatever an earlier run left in the topics (stale payment requests, open holds) finishes first, then
  // the tables are emptied, so a leftover message cannot show up as a payment for an order that is gone.
  mark("draining anything left from an earlier run");
  await h.waitQuiet(300_000).catch(() => {});
  await h.resetTables();
  const sale = EVENT_ID;

  // k6 resets the sale itself (setup()); the harness only needs the id for cleanup and checks.
  h.events.push(sale);
  h.testSales = [sale];

  const startedAtWall = Date.now();
  t0 = Date.now();
  mark(
    `starting k6 (rush for ${process.env.DURATION ?? "60s"}), ${PAYMENT_REPLICAS} payment processes x concurrency ${PAYMENT_CONCURRENCY}`,
  );
  // Streamed to Prometheus the way the baseline run is, so the dashboard's /reserve panels have data.
  const k6 = spawn("k6", ["run", "-o", "experimental-prometheus-rw", "loadtest/phase4.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LABEL: run,
      EVENT_ID: sale,
      TOTAL: String(TOTAL),
      K6_PROMETHEUS_RW_SERVER_URL:
        process.env.PROMETHEUS_RW_URL ?? "http://localhost:9090/api/v1/write",
      K6_PROMETHEUS_RW_TREND_STATS: "p(50),p(95),p(99),avg,max",
      K6_PROMETHEUS_RW_STALE_MARKERS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  let k6Out = "";
  k6.stdout.on("data", (c: Buffer) => {
    k6Out += c.toString();
  });
  k6.stderr.on("data", (c: Buffer) => {
    k6Out += c.toString();
  });
  const k6Done = new Promise<number>((resolve) => k6.on("exit", (code) => resolve(code ?? 1)));

  const chaosState: { paymentBackAt?: number } = {};
  if (chaos) {
    // Times are from the start of the rush; k6's setup() takes a moment, so they are approximate.
    void (async () => {
      await sleep(20_000);
      mark("CHAOS: payment-svc killed");
      await Promise.all(h.paymentProcs.map((p) => p.kill()));
      await sleep(10_000);
      mark("CHAOS: order-worker-2 killed and restarted");
      await h.stack.orderWorker2.kill();
      await h.stack.orderWorker2.start();
      mark("CHAOS: order-worker-2 is back");
      await sleep(Math.max(0, 40_000 - (Date.now() - t0)));
      mark("CHAOS: payment-svc started");
      await Promise.all(h.paymentProcs.map((p) => p.start()));
      chaosState.paymentBackAt = Date.now();
      mark("CHAOS: payment-svc is ready");
    })();
  }

  const k6Code = await k6Done;
  mark(`k6 finished (exit ${k6Code})`);
  const rushEndedAt = Date.now();

  let quiet = true;
  try {
    // 20% of the winners never pay, so quiet also means every hold has run out and been released.
    await h.waitQuiet(240_000, { untilNoHeld: true });
    mark("system quiet (nothing pending, unsettled or still held)");
  } catch (error) {
    quiet = false;
    mark(`NOT QUIET after 180s: ${(error as Error).message}`);
  }
  const quietAt = Date.now();
  await sleep(6_000); // one more scrape so Prometheus has the final values

  // ---- invariants -----------------------------------------------------------------------------
  const report = await checkInvariants({
    eventIds: [sale],
    // Restarted workers lose their in-memory counters, so run 2 reads them from Prometheus instead.
    skipMetrics: chaos,
    metricsUrls: chaos ? [] : ["http://localhost:3006/metrics"],
    settleTimeoutMs: 60_000,
  });
  console.log(describeReport(report));

  // ---- counts ---------------------------------------------------------------------------------
  const states = await h.orders.query<{ state: string; n: string }>(
    `SELECT state, count(*) AS n FROM "order_e2e"."Order" GROUP BY state ORDER BY state`,
  );
  const releasedSplit = await h.orders.query<{ via: string; n: string }>(
    `SELECT CASE WHEN p.status IS NULL THEN 'expired (no payment)' ELSE 'payment ' || p.status END AS via, count(*) AS n
       FROM "order_e2e"."Order" o
       LEFT JOIN "payment_e2e"."Payment" p ON p."orderId" = o.id
      WHERE o.state = 'RELEASED' GROUP BY 1`,
  );
  const paidCount = Number(states.rows.find((r) => r.state === "PAID")?.n ?? 0);
  const inv = await h.inventory(sale);
  const doubled = await h.payments.query(
    `SELECT "orderId" FROM "payment_e2e"."Payment" GROUP BY "orderId" HAVING count(*) > 1`,
  );
  const succeededPayments = await h.payments.query<{ n: string }>(
    `SELECT count(*) AS n FROM "payment_e2e"."Payment" WHERE status = 'SUCCEEDED'`,
  );

  // ---- Prometheus -------------------------------------------------------------------------------
  const from = startedAtWall - 5_000;
  const to = Date.now();
  const lag = await prom("max(kafka_consumer_lag)", from, to);
  const lagByGroup: Record<string, number> = {};
  for (const group of [
    "order-service",
    "payment-result-consumer",
    "hold-settlement",
    "payment-service",
  ]) {
    lagByGroup[group] = maxOf(await prom(`sum(kafka_consumer_lag{group="${group}"})`, from, to));
  }
  const oldest = await prom("max(oldest_payment_pending_age_seconds)", from, to, 1);
  const counter = async (name: string) => {
    const series = await prom(
      `sum(increase(${name}[${Math.ceil((to - from) / 1000)}s]))`,
      to,
      to,
      1,
    );
    return series[0]?.[1] ?? 0;
  };

  // Recovery (run 2): first moment after the payment service is back that the oldest pending age is
  // under 10s and stays there.
  let recoverySec: number | undefined;
  const paymentBackAt = chaosState.paymentBackAt;
  if (paymentBackAt !== undefined) {
    const after = oldest.filter(([t]) => t * 1000 >= paymentBackAt);
    for (let i = 0; i < after.length; i++) {
      if (after.slice(i).every(([, v]) => v < 10)) {
        recoverySec = ((after[i]?.[0] ?? 0) * 1000 - paymentBackAt) / 1000;
        break;
      }
    }
  }

  const k6Summary = JSON.parse(readFileSync(`${ROOT}loadtest/results/phase4-${run}.json`, "utf8"));
  const result = {
    run,
    window: {
      startedAt: new Date(startedAtWall).toISOString(),
      rushEndedAt: new Date(rushEndedAt).toISOString(),
      quietAt: new Date(quietAt).toISOString(),
      endedAt: new Date(to).toISOString(),
    },
    config: {
      total: TOTAL,
      holdTtlSec: 60,
      ticketWorkers: TICKET_WORKERS,
      paymentConcurrency: PAYMENT_CONCURRENCY,
      paymentReplicas: PAYMENT_REPLICAS,
      resultConsumerConcurrency: RESULT_CONCURRENCY,
      workerReplicas: chaos ? 2 : 1,
      rate: process.env.RATE ?? "5000",
      duration: process.env.DURATION ?? "60s",
    },
    timeline,
    quiet,
    invariants: report,
    counts: {
      states: Object.fromEntries(states.rows.map((r) => [r.state, Number(r.n)])),
      released: Object.fromEntries(releasedSplit.rows.map((r) => [r.via, Number(r.n)])),
      paid: paidCount,
      succeededPayments: Number(succeededPayments.rows[0]?.n ?? 0),
      redis: inv,
      oversell: Math.max(paidCount - TOTAL, 0),
      doubleCharges: doubled.rowCount,
    },
    prometheus: {
      maxConsumerLag: maxOf(lag),
      maxLagByGroup: lagByGroup,
      maxOldestPendingAgeSec: maxOf(oldest),
      republished: await counter("payment_request_republished_total"),
      backstopSettled: await counter("hold_settlement_backstop_total"),
      mismatches: await counter("payment_state_mismatch_total"),
      holdMissingOnConfirm: await counter("hold_missing_on_confirm_total"),
      recoverySec,
    },
    k6: {
      exitCode: k6Code,
      metrics: Object.fromEntries(
        Object.entries(k6Summary.metrics as Record<string, { values: Record<string, number> }>)
          .filter(
            ([name]) =>
              name.startsWith("p4_") ||
              ["http_reqs", "dropped_iterations", "iterations", "vus_max"].includes(name),
          )
          .map(([name, m]) => [name, m.values]),
      ),
      reserve: (k6Summary.metrics["http_req_duration{name:reserve}"] ?? {}).values,
      pay: (k6Summary.metrics["http_req_duration{name:pay}"] ?? {}).values,
      poll: (k6Summary.metrics["http_req_duration{name:poll}"] ?? {}).values,
    },
  };
  mkdirSync(`${ROOT}docs/results/raw`, { recursive: true });
  writeFileSync(`${ROOT}docs/results/raw/phase4-${run}.json`, JSON.stringify(result, null, 2));
  console.log(`\nwrote docs/results/raw/phase4-${run}.json`);
  console.log(k6Out.split(/\r?\n/).slice(-45).join("\n"));
  return report.pass && quiet;
}

try {
  const ok = await main();
  console.log(ok ? "\nLOAD RUN OK" : "\nLOAD RUN: INVARIANTS OR QUIET WAIT FAILED");
  await h.stopAll();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(error);
  await h.stopAll();
  process.exit(1);
}
