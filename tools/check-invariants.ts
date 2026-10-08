// Checks the saga's invariants against the running stack.
//
//   pnpm -C tools run check-invariants [eventId ...]
//
// With no event ids it checks every event in Redis's `events:active` set. Prints PASS or FAIL per check
// and exits 0 or 1. Everything here is read-only: both Postgres connections are opened with
// default_transaction_read_only, and the payments schema is read by this check only.
//
//   I1   per event: avail + held + sold = total
//   I2   no order PAYMENT_PENDING longer than PAYMENT_STALE_SEC + 2 x SWEEPER_INTERVAL
//   I3   no PAID / EXPIRED / PAYMENT_FAILED order with an unsettled hold for longer than 2 x SWEEPER_INTERVAL
//   I4   every SUCCEEDED payment <-> a PAID order
//   I5   no oversell: PAID orders per event never exceed its total stock
//   I6   no double charge: at most one payments row per order
//   I7   every order is in a valid state, and RELEASED orders have their hold settled
//   I8   hold_missing_on_confirm_total is 0 and payment_state_mismatch_total is what the caller expects

import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";

// Local-stack defaults (infra/docker/docker-compose.yml); override through the environment.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5434/flashsale?schema=order";
const PAYMENTS_DATABASE_URL =
  process.env.PAYMENTS_DATABASE_URL ??
  "postgresql://app:app@localhost:5434/flashsale?schema=payment-mock";
const PAYMENT_STALE_SEC = Number(process.env.PAYMENT_STALE_SEC ?? 60);
const SWEEPER_INTERVAL_MS = Number(process.env.SWEEPER_INTERVAL_MS ?? 30_000);

// Key names owned by the ticket service (reserveKeys(), totalKey(), soldKey(), heldKey()); kept in step by hand.
const availKey = (e: string) => `ev:${e}:avail`;
const holdsKey = (e: string) => `ev:${e}:holds`;
const totalKey = (e: string) => `ev:${e}:total`;
const soldKey = (e: string) => `ev:${e}:sold`;
const heldKey = (e: string) => `ev:${e}:held`;
const ACTIVE_EVENTS = "events:active";

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface InvariantReport {
  pass: boolean;
  checks: CheckResult[];
}

function schemaOf(url: string): string {
  const schema = new URL(url).searchParams.get("schema") ?? "public";
  if (!/^[A-Za-z0-9_-]+$/.test(schema)) {
    throw new Error(`schema "${schema}" is not a plain identifier`);
  }
  return schema;
}

/** A connection that cannot write, whatever this script does. */
async function readOnlyClient(url: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  return client;
}

/** Order-worker /metrics endpoints to read the saga counters from; each worker keeps its own. */
const WORKER_METRICS_URLS = (
  process.env.ORDER_WORKER_METRICS_URLS ?? "http://localhost:3006/metrics"
)
  .split(",")
  .filter(Boolean);

const VALID_STATES = [
  "HELD",
  "PAYMENT_PENDING",
  "PAID",
  "CONFIRMED",
  "EXPIRED",
  "PAYMENT_FAILED",
  "REFUNDED",
  "RELEASED",
];

/** Sum of a counter across every scraped worker; a worker that is down contributes nothing. */
async function sumCounter(urls: string[], name: string): Promise<number> {
  let total = 0;
  for (const url of urls) {
    try {
      const text = await (await fetch(url, { signal: AbortSignal.timeout(2_000) })).text();
      const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name} `));
      total += line ? Number(line.split(" ")[1]) : 0;
    } catch {
      // This worker is not running; its counter is gone with it.
    }
  }
  return total;
}

export interface InvariantOptions {
  /** payment_state_mismatch_total the caller expects (0 unless a scenario provokes one). */
  expectedMismatches?: number;
  /** Skip I8, for runs where the workers' in-memory counters are meaningless (restarted workers). */
  skipMetrics?: boolean;
  metricsUrls?: string[];
  eventIds?: string[];
  /** How long I1 may keep failing for the pipeline to settle (holds still waiting for their order). */
  settleTimeoutMs?: number;
}

export async function checkInvariants({
  eventIds,
  settleTimeoutMs = 20_000,
  expectedMismatches = 0,
  skipMetrics = false,
  metricsUrls = WORKER_METRICS_URLS,
}: InvariantOptions = {}): Promise<InvariantReport> {
  const redis = new Redis(REDIS_URL);
  const orders = await readOnlyClient(DATABASE_URL);
  const payments = await readOnlyClient(PAYMENTS_DATABASE_URL);
  const orderTable = `"${schemaOf(DATABASE_URL)}"."Order"`;
  const paymentTable = `"${schemaOf(PAYMENTS_DATABASE_URL)}"."Payment"`;
  const checks: CheckResult[] = [];

  try {
    const events = eventIds?.length ? eventIds : await redis.smembers(ACTIVE_EVENTS);

    // ---- I1 ---------------------------------------------------------------------------------
    for (const eventId of events) {
      const deadline = Date.now() + settleTimeoutMs;
      let result: CheckResult;
      for (;;) {
        result = await checkI1(eventId);
        if (result.pass || Date.now() >= deadline) {
          break;
        }
        await sleep(500);
      }
      checks.push(result);
    }
    if (events.length === 0) {
      checks.push({ name: "I1 inventory", pass: true, detail: "no active events" });
    }

    // ---- I2 / I3 ----------------------------------------------------------------------------
    const sweepSec = (2 * SWEEPER_INTERVAL_MS) / 1000;
    const pendingLimit = PAYMENT_STALE_SEC + sweepSec;
    const pending = await orders.query<{ id: string }>(
      `SELECT id FROM ${orderTable}
        WHERE state = 'PAYMENT_PENDING'
          AND "paymentStartedAt" < (now() AT TIME ZONE 'UTC') - $1 * interval '1 second'`,
      [pendingLimit],
    );
    checks.push({
      name: "I2 no stuck PAYMENT_PENDING",
      pass: pending.rowCount === 0,
      detail:
        pending.rowCount === 0
          ? `none older than ${pendingLimit}s`
          : `${pending.rowCount} older than ${pendingLimit}s, e.g. ${pending.rows
              .slice(0, 3)
              .map((r) => r.id)
              .join(", ")}`,
    });

    const unsettled = await orders.query<{ id: string; state: string }>(
      `SELECT id, state FROM ${orderTable}
        WHERE "holdSettledAt" IS NULL AND state IN ('PAID', 'EXPIRED', 'PAYMENT_FAILED')
          AND "updatedAt" < (now() AT TIME ZONE 'UTC') - $1 * interval '1 second'`,
      [sweepSec],
    );
    checks.push({
      name: "I3 no unsettled terminal order",
      pass: unsettled.rowCount === 0,
      detail:
        unsettled.rowCount === 0
          ? `none unsettled for more than ${sweepSec}s`
          : `${unsettled.rowCount} unsettled for more than ${sweepSec}s, e.g. ${unsettled.rows
              .slice(0, 3)
              .map((r) => `${r.id} (${r.state})`)
              .join(", ")}`,
    });

    // ---- I4 ---------------------------------------------------------------------------------
    // A payment can be SUCCEEDED a moment before the result consumer has marked the order PAID, so
    // a PAYMENT_PENDING order younger than the I2 limit is not a violation yet.
    const succeeded = (
      await payments.query<{ orderId: string }>(
        `SELECT "orderId" FROM ${paymentTable} WHERE status = 'SUCCEEDED'`,
      )
    ).rows.map((r) => r.orderId);
    const succeededSet = new Set(succeeded);
    const states = new Map<string, { state: string; stale: boolean }>();
    if (succeeded.length > 0) {
      const res = await orders.query<{ id: string; state: string; stale: boolean }>(
        `SELECT id, state,
                ("paymentStartedAt" IS NULL OR "paymentStartedAt" < (now() AT TIME ZONE 'UTC') - $2 * interval '1 second') AS stale
           FROM ${orderTable} WHERE id = ANY($1)`,
        [succeeded, pendingLimit],
      );
      for (const r of res.rows) {
        states.set(r.id, { state: r.state, stale: r.stale });
      }
    }
    const paymentsWithoutPaid = succeeded.filter((id) => {
      const o = states.get(id);
      return !o || (o.state !== "PAID" && !(o.state === "PAYMENT_PENDING" && !o.stale));
    });
    const paid = await orders.query<{ id: string }>(
      `SELECT id FROM ${orderTable} WHERE state = 'PAID'`,
    );
    const paidWithoutPayment = paid.rows.map((r) => r.id).filter((id) => !succeededSet.has(id));
    checks.push({
      name: "I4 SUCCEEDED payment <-> PAID order",
      pass: paymentsWithoutPaid.length === 0 && paidWithoutPayment.length === 0,
      detail:
        paymentsWithoutPaid.length === 0 && paidWithoutPayment.length === 0
          ? `${succeeded.length} succeeded payments, ${paid.rowCount} paid orders, matching`
          : `${paymentsWithoutPaid.length} SUCCEEDED payments without a PAID order (${paymentsWithoutPaid.slice(0, 3).join(", ")}), ${paidWithoutPayment.length} PAID orders without a SUCCEEDED payment (${paidWithoutPayment.slice(0, 3).join(", ")})`,
    });

    // ---- I5: no oversell ----------------------------------------------------------------------
    const oversold: string[] = [];
    for (const eventId of events) {
      const total = Number(await redis.get(totalKey(eventId)));
      const paidCount = await orders.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${orderTable} WHERE "eventId" = $1 AND state = 'PAID'`,
        [eventId],
      );
      const n = Number(paidCount.rows[0]?.n ?? 0);
      if (n > total) {
        oversold.push(`${eventId}: ${n} PAID > ${total} stock`);
      }
    }
    checks.push({
      name: "I5 no oversell",
      pass: oversold.length === 0,
      detail: oversold.length === 0 ? "PAID orders never exceed stock" : oversold.join("; "),
    });

    // ---- I6: no double charge -----------------------------------------------------------------
    const doubled = await payments.query<{ orderId: string; n: string }>(
      `SELECT "orderId", count(*) AS n FROM ${paymentTable} GROUP BY "orderId" HAVING count(*) > 1`,
    );
    checks.push({
      name: "I6 one payment row per order",
      pass: doubled.rowCount === 0,
      detail:
        doubled.rowCount === 0
          ? "no order has more than one payments row"
          : `${doubled.rowCount} orders have several, e.g. ${doubled.rows
              .slice(0, 3)
              .map((r) => r.orderId)
              .join(", ")}`,
    });

    // ---- I7: valid states ---------------------------------------------------------------------
    const invalid = await orders.query<{ id: string; state: string }>(
      `SELECT id, state FROM ${orderTable}
        WHERE state::text <> ALL($1) OR (state = 'RELEASED' AND "holdSettledAt" IS NULL)`,
      [VALID_STATES],
    );
    checks.push({
      name: "I7 valid states, RELEASED => settled",
      pass: invalid.rowCount === 0,
      detail:
        invalid.rowCount === 0
          ? "every order is in a valid state"
          : `${invalid.rowCount} bad, e.g. ${invalid.rows
              .slice(0, 3)
              .map((r) => `${r.id} (${r.state})`)
              .join(", ")}`,
    });

    // ---- I8: metrics --------------------------------------------------------------------------
    if (!skipMetrics) {
      const missing = await sumCounter(metricsUrls, "hold_missing_on_confirm_total");
      const mismatches = await sumCounter(metricsUrls, "payment_state_mismatch_total");
      checks.push({
        name: "I8 saga counters",
        pass: missing === 0 && mismatches === expectedMismatches,
        detail: `hold_missing_on_confirm_total ${missing} (want 0), payment_state_mismatch_total ${mismatches} (want ${expectedMismatches})`,
      });
    }

    return { pass: checks.every((c) => c.pass), checks };
  } finally {
    redis.disconnect();
    await orders.end();
    await payments.end();
  }

  async function checkI1(eventId: string): Promise<CheckResult> {
    const name = `I1 inventory [${eventId}]`;
    const [avail, total, sold, heldCounter, members] = await Promise.all([
      redis.get(availKey(eventId)),
      redis.get(totalKey(eventId)),
      redis.get(soldKey(eventId)),
      redis.get(heldKey(eventId)),
      redis.zrange(holdsKey(eventId), "0", "-1"),
    ]);
    if (total === null || avail === null) {
      return { name, pass: false, detail: "avail or total key is missing" };
    }
    // The holds ZSET stores no quantity; it comes from the order row, whose id is the hold id.
    const qty = new Map<string, number>();
    if (members.length > 0) {
      const res = await orders.query<{ id: string; qty: number }>(
        `SELECT id, qty FROM ${orderTable} WHERE id = ANY($1)`,
        [members],
      );
      for (const r of res.rows) {
        qty.set(r.id, r.qty);
      }
    }
    const unmatched = members.filter((m) => !qty.has(m));
    // The quantity on the orders whose hold is open: the ground truth the Redis `held` counter,
    // maintained by the Lua scripts, has to agree with.
    const heldFromOrders = [...qty.values()].reduce((a, b) => a + b, 0);
    const held = Number(heldCounter ?? 0);
    const sum = Number(avail) + held + Number(sold ?? 0);
    const detail = `avail ${avail} + held ${held} + sold ${sold ?? 0} = ${sum}, total ${total}; held counter ${held} vs open-hold orders ${heldFromOrders}${unmatched.length > 0 ? `; ${unmatched.length} holds have no order yet` : ""}`;
    return {
      name,
      pass: unmatched.length === 0 && sum === Number(total) && held === heldFromOrders,
      detail,
    };
  }
}

function print(report: InvariantReport): void {
  for (const c of report.checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  }
  console.log(report.pass ? "PASS  all invariants hold" : "FAIL  invariants violated");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await checkInvariants({ eventIds: process.argv.slice(2) });
  print(report);
  process.exit(report.pass ? 0 : 1);
}

export { print as printReport };
