import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@flash/observability";
import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/baseline/db.js";
import { createBaselineRouter } from "../src/baseline/routes.js";
import { VARIANTS, type Variant } from "../src/baseline/types.js";

// Needs a live Postgres with infra/sql/baseline.sql applied: `make up && make baseline-db`, then
// `make test-baseline`. Skipped (not failed) when DATABASE_URL is unset so plain `pnpm test` stays green.
const DATABASE_URL = process.env.DATABASE_URL;

const EVENT_ID = "baseline-concurrency";
const TOTAL = 100;
const CONCURRENCY = 1_000;

// All CONCURRENCY reserve calls are in flight at once, but they share this many keep-alive sockets.
// Windows clamps a listener's accept backlog to ~200 no matter what `listen()` asks for, so opening
// one socket per request gets the overflow refused (ECONNREFUSED) instead of queued. Contention is
// still real: the pg pool (PG_POOL_MAX, default 20) is narrower than this.
const MAX_SOCKETS = 100;

describe.skipIf(!DATABASE_URL)("baseline reserve under concurrency", () => {
  let pool: Pool;
  let server: Server;
  let port: number;
  const agent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });

  beforeAll(async () => {
    pool = createPool({ ...process.env, DATABASE_URL });
    const app = express();
    app.use(express.json());
    app.use(
      createBaselineRouter({ pool, logger: createLogger({ service: "ticket", level: "error" }) }),
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    agent.destroy();
    server?.closeAllConnections();
    server?.close();
    await pool?.end();
  });

  function post(path: string, payload: unknown): Promise<{ status: number; body: string }> {
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          agent,
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }

  async function reset(): Promise<void> {
    const res = await post("/baseline/reset", { eventId: EVENT_ID, total: TOTAL });
    expect(res.status, `reset failed: ${res.status} ${res.body}`).toBe(200);
  }

  async function reserve(variant: Variant): Promise<{ status: number; retries: number }> {
    const res = await post(`/baseline/${variant}/reserve`, {
      eventId: EVENT_ID,
      userId: randomUUID(),
      qty: 1,
    });
    let retries = 0;
    try {
      const parsed = JSON.parse(res.body) as { retries?: unknown };
      if (typeof parsed.retries === "number") retries = parsed.retries;
    } catch {
      // Non-JSON body (e.g. a 500 from Express's default handler): no retry info.
    }
    return { status: res.status, retries };
  }

  async function dbState(): Promise<{ available: number; holdsQty: number }> {
    const { rows } = await pool.query<{ available: number; holds_qty: number }>(
      `SELECT i.available,
              COALESCE((SELECT SUM(h.qty) FROM holds h WHERE h.event_id = i.event_id), 0)::int
                AS holds_qty
       FROM inventory i
       WHERE i.event_id = $1`,
      [EVENT_ID],
    );
    const row = rows[0];
    if (!row) throw new Error(`inventory row for ${EVENT_ID} missing`);
    return { available: row.available, holdsQty: row.holds_qty };
  }

  async function hammer(variant: Variant) {
    await reset();
    const outcomes = await Promise.all(Array.from({ length: CONCURRENCY }, () => reserve(variant)));
    const successes = outcomes.filter((o) => o.status === 201).length;
    const soldOut = outcomes.filter((o) => o.status === 409).length;
    const errors = outcomes.length - successes - soldOut;
    const retries = outcomes.reduce((sum, o) => sum + o.retries, 0);
    const state = await dbState();
    return { variant, successes, soldOut, errors, retries, ...state };
  }

  type Run = Awaited<ReturnType<typeof hammer>>;

  // Vitest only replays console.* from failing tests; write straight to stdout so every variant's
  // numbers (especially naive's oversell count) show up in the run output.
  function report(r: Run) {
    const oversold = Math.max(0, r.holdsQty - TOTAL);
    const ok = oversold === 0 && r.errors === 0 && r.available >= 0;
    const notes: string[] = [];
    if (oversold > 0) notes.push(`OVERSOLD by ${oversold}`);
    if (r.errors > 0) notes.push(`${r.errors.toLocaleString("en-US")} errors`);
    if (r.variant === "optimistic") {
      notes.push(`retried ${r.retries.toLocaleString("en-US")} times total`);
    }
    const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    process.stdout.write(
      `${ok ? "✓" : "✗"} ${r.variant}: sold ${r.holdsQty}, available ${r.available}${suffix}\n`,
    );
  }

  function assertNoOversell(r: Run) {
    expect(r.errors, "unexpected non-201/409 responses").toBe(0);
    expect(r.successes).toBeLessThanOrEqual(TOTAL);
    expect(r.available).toBeGreaterThanOrEqual(0);
    expect(r.available + r.holdsQty).toBe(TOTAL);
  }

  // The control: expected to oversell. `it.fails` inverts the outcome, so the suite goes red the day
  // naive stops overselling (which would mean the harness no longer exercises real contention).
  it.fails("naive oversells (documented failure)", async () => {
    const r = await hammer("naive");
    report(r);
    assertNoOversell(r);
  });

  for (const variant of VARIANTS.filter((v): v is Exclude<Variant, "naive"> => v !== "naive")) {
    it(`${variant} never oversells`, async () => {
      const r = await hammer(variant);
      report(r);
      assertNoOversell(r);
    }, 120_000);
  }
});
