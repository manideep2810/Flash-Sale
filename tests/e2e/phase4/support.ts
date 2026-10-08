// Shared plumbing for the Phase 4 scenarios: the services as child processes (so a test can kill one
// and bring it back), HTTP helpers for the public API, direct reads of Postgres / Redis / Kafka to
// check results, and the quiet-system wait that every scenario ends with.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Redis } from "ioredis";
import pg from "pg";

const run = promisify(execFile);
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// ---- Environment -----------------------------------------------------------------------------

const BASE_URL = "postgresql://app:app@localhost:5434/flashsale";
/** Dedicated schemas: the scenarios truncate them, and `order` / `payment-mock` stay untouched. */
export const ORDER_DB = `${BASE_URL}?schema=order_e2e`;
export const PAYMENT_DB = `${BASE_URL}?schema=payment_e2e`;
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
export const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";

/** Short timers so scenarios finish in seconds; the production defaults are 600 / 5000 / 60 / 30000. */
export const TIMERS = {
  HOLD_TTL_SEC: 10,
  TIMEOUT_JOB_INTERVAL_MS: 1_000,
  PAYMENT_STALE_SEC: 5,
  SWEEPER_INTERVAL_MS: 2_000,
};

export const PORTS = {
  ticket: 3001,
  relay: 3002,
  orderApi: 3003,
  payment: 3004,
  orderWorker: 3006,
  orderWorker2: 3007,
  payment2: 3008,
  payment3: 3009,
  payment4: 3010,
};

const CONSUMER_GROUPS = [
  "order-service",
  "payment-result-consumer",
  "hold-settlement",
  "payment-service",
];

// ---- Child processes ---------------------------------------------------------------------------

export interface ProcSpec {
  name: string;
  /** Directory under services/. */
  service: string;
  entry: string;
  /** Port that answers /healthz/ready once the process is up. */
  port: number;
  env: Record<string, string>;
}

/** One service process. `kill()` is a SIGKILL: no drain, no offset commit, what a crash looks like. */
export class Proc {
  #child: ChildProcess | undefined;
  #output = "";
  /** True while the running process was started with a crash point armed. */
  armed = false;

  constructor(readonly spec: ProcSpec) {}

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  get output(): string {
    return this.#output;
  }

  async #ready(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.spec.port}/healthz/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  }

  /** `fault` becomes FAULT_POINT: the process exits 137 when it reaches that point. */
  async start(fault?: string): Promise<void> {
    if (this.running) {
      return;
    }
    if (await this.#ready()) {
      throw new Error(
        `port ${this.spec.port} is already serving: stop the ${this.spec.name} service (\`make dev\`) before running the e2e tests`,
      );
    }
    // `node --import tsx` rather than the tsx CLI: the CLI runs the program in a child of its own,
    // and killing the wrapper would leave the real process alive.
    const child = spawn(process.execPath, ["--import", "tsx", this.spec.entry], {
      cwd: `${ROOT}services/${this.spec.service}`,
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        ...this.spec.env,
        ...(fault ? { FAULT_POINT: fault } : { FAULT_POINT: "" }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#output = "";
    const keep = (chunk: Buffer) => {
      this.#output = (this.#output + chunk.toString()).slice(-6_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    this.#child = child;
    this.armed = Boolean(fault);

    await waitFor(`${this.spec.name} to become ready`, 60_000, async () => {
      if (child.exitCode !== null) {
        throw new Error(`${this.spec.name} exited during startup:\n${this.#output}`);
      }
      return this.#ready();
    });
  }

  async kill(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.kill("SIGKILL");
    await once(child, "exit");
    // The ticket service's cluster workers notice the primary is gone and exit a moment later.
    await waitFor(
      `${this.spec.name} to stop answering`,
      10_000,
      async () => !(await this.#ready()),
    );
  }

  /** Resolves when the process exits on its own (a fault point), with its exit code. */
  async exited(timeoutMs: number): Promise<number | null> {
    const child = this.#child;
    if (!child) {
      return null;
    }
    if (child.exitCode !== null) {
      return child.exitCode;
    }
    await Promise.race([once(child, "exit"), sleep(timeoutMs)]);
    return child.exitCode;
  }
}

export interface HarnessOptions {
  /** Partitions of payments.commands the payment service handles at once (default 1). */
  paymentConcurrency?: string;
  /** Hold lifetime; the scenarios use the short TIMERS value, the load runs 60. */
  holdTtlSec?: number;
  /** Ticket-service cluster workers (default 2, enough for the scenarios; the load runs use more). */
  ticketWorkers?: string;
  /** Order-worker processes sharing the consumer groups (default 1). */
  workerReplicas?: 1 | 2;
  /** Payment-service processes sharing the payment-service group (default 1); each takes a share of the partitions. */
  paymentReplicas?: 1 | 2 | 3 | 4;
  /** Partitions the order worker's result and settlement consumers handle at once (default 1). */
  resultConcurrency?: string;
}

function procs(extra: HarnessOptions = {}) {
  const timers = Object.fromEntries(Object.entries(TIMERS).map(([k, v]) => [k, String(v)]));
  const orderEnv = {
    DATABASE_URL: ORDER_DB,
    KAFKA_BROKERS,
    REDIS_URL,
    PORT: "3003",
    RESULT_CONSUMER_CONCURRENCY: extra.resultConcurrency ?? "1",
    ...timers,
  };
  const paymentProc = (name: string, port: number) =>
    new Proc({
      name,
      service: "payment-mock",
      entry: "src/index.ts",
      port,
      env: {
        PORT: String(port),
        DATABASE_URL: PAYMENT_DB,
        KAFKA_BROKERS,
        FAIL_RATE: "0.2",
        PAYMENT_CONCURRENCY: extra.paymentConcurrency ?? "1",
      },
    });
  return {
    ticket: new Proc({
      name: "ticket",
      service: "ticket",
      entry: "src/index.ts",
      port: PORTS.ticket,
      env: {
        PORT: String(PORTS.ticket),
        REDIS_URL,
        WORKERS: extra.ticketWorkers ?? "2",
        METRICS_PORT: "9464",
        HOLD_TTL_SEC: String(extra.holdTtlSec ?? TIMERS.HOLD_TTL_SEC),
      },
    }),
    relay: new Proc({
      name: "relay",
      service: "relay",
      entry: "src/index.ts",
      port: PORTS.relay,
      env: { PORT: String(PORTS.relay), REDIS_URL, KAFKA_BROKERS },
    }),
    orderApi: new Proc({
      name: "order-api",
      service: "order",
      entry: "src/api.ts",
      port: PORTS.orderApi,
      env: { ...orderEnv, PORT: String(PORTS.orderApi) },
    }),
    orderWorker: new Proc({
      name: "order-worker",
      service: "order",
      entry: "src/worker.ts",
      port: PORTS.orderWorker,
      env: { ...orderEnv, WORKER_PORT: String(PORTS.orderWorker) },
    }),
    orderWorker2: new Proc({
      name: "order-worker-2",
      service: "order",
      entry: "src/worker.ts",
      port: PORTS.orderWorker2,
      env: { ...orderEnv, WORKER_PORT: String(PORTS.orderWorker2) },
    }),
    payment: paymentProc("payment-svc", PORTS.payment),
    payment2: paymentProc("payment-svc-2", PORTS.payment2),
    payment3: paymentProc("payment-svc-3", PORTS.payment3),
    payment4: paymentProc("payment-svc-4", PORTS.payment4),
  };
}

export type Stack = ReturnType<typeof procs>;

// ---- Waiting -----------------------------------------------------------------------------------

export async function waitFor(
  what: string,
  timeoutMs: number,
  done: () => Promise<boolean>,
  pollMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(pollMs);
  }
}

// ---- The harness: stack + clients ----------------------------------------------------------------

const ORDER_TABLE = `"order_e2e"."Order"`;
const PROCESSED_TABLE = `"order_e2e"."ProcessedEvent"`;
const PAYMENT_TABLE = `"payment_e2e"."Payment"`;

function dbUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("schema");
  return u.href;
}

export interface OrderRow {
  id: string;
  eventId: string;
  qty: number;
  state: string;
  holdSettledAt: Date | null;
  expiresAt: Date;
}

export interface PaymentRow {
  orderId: string;
  status: string;
  chargeId: string | null;
}

export class Harness {
  readonly stack: Stack;
  readonly redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  readonly orders = new pg.Pool({ connectionString: dbUrl(ORDER_DB), max: 4 });
  readonly payments = new pg.Pool({ connectionString: dbUrl(PAYMENT_DB), max: 4 });
  #producer: ReturnType<KafkaJS.Kafka["producer"]> | undefined;
  /** Every sale this harness created, for cleanup at the end. */
  readonly events: string[] = [];
  /** The sales the running scenario created: what the invariant check looks at. */
  testSales: string[] = [];

  constructor(readonly options: HarnessOptions = {}) {
    this.stack = procs(options);
    this.redis.on("error", () => {});
  }

  // -- lifecycle --

  /** Migrates the dedicated schemas (idempotent), then starts every process. */
  async startAll(): Promise<void> {
    await migrate("order", ORDER_DB);
    await migrate("payment-mock", PAYMENT_DB);
    await this.redis.ping();
    // Order of dependence: ticket and relay feed the order worker; payment answers it.
    await Promise.all(this.active.map((p) => p.start()));
  }

  /** The processes this harness runs (the second worker only when asked for). */
  get active(): Proc[] {
    const { orderWorker2, payment2, payment3, payment4, ...rest } = this.stack;
    const list = Object.values(rest);
    if (this.options.workerReplicas === 2) {
      list.push(orderWorker2);
    }
    return [
      ...list,
      ...[payment2, payment3, payment4].slice(0, (this.options.paymentReplicas ?? 1) - 1),
    ];
  }

  /** Every payment-service process this harness runs. */
  get paymentProcs(): Proc[] {
    const { payment, payment2, payment3, payment4 } = this.stack;
    return [payment, payment2, payment3, payment4].slice(0, this.options.paymentReplicas ?? 1);
  }

  /**
   * Replaces any process that is still running with a crash point armed by a clean one. A scenario
   * whose process never reached its crash point must not leave it to blow up in the next scenario.
   */
  async disarm(): Promise<void> {
    for (const p of this.active) {
      if (p.armed) {
        await p.kill();
        p.armed = false;
        await p.start();
      }
    }
  }

  /** Starts whatever is not running (after a scenario that killed something). */
  async ensureUp(): Promise<void> {
    await Promise.all(this.active.map((p) => p.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(Object.values(this.stack).map((p) => p.kill()));
    for (const eventId of this.events) {
      await this.redis.del(
        `ev:${eventId}:avail`,
        `ev:${eventId}:holds`,
        `ev:${eventId}:stream`,
        `ev:${eventId}:total`,
        `ev:${eventId}:sold`,
      );
      await this.redis.srem("events:active", eventId);
    }
    await this.#producer?.disconnect();
    this.redis.disconnect();
    await this.orders.end();
    await this.payments.end();
  }

  /** Between scenarios: empty the tables. Callers wait for quiet first, so nothing is in flight. */
  async resetTables(): Promise<void> {
    await this.orders.query(`TRUNCATE ${ORDER_TABLE}, ${PROCESSED_TABLE}`);
    await this.payments.query(`TRUNCATE ${PAYMENT_TABLE}`);
  }

  // -- sale and API --

  /** Seeds a sale with known stock and marks it active for the relay. Returns its id. */
  async createSale(total: number, label = "sale"): Promise<string> {
    const eventId = `e2e-${label}-${randomUUID().slice(0, 8)}`;
    const res = await fetch(`http://localhost:${PORTS.ticket}/redis/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, total }),
    });
    if (!res.ok) {
      throw new Error(`reset answered ${res.status}`);
    }
    this.events.push(eventId);
    this.testSales.push(eventId);
    return eventId;
  }

  async reserve(eventId: string, userId: string, qty = 1): Promise<string | undefined> {
    const res = await fetch(`http://localhost:${PORTS.ticket}/redis/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, userId, qty }),
    });
    if (res.status === 409) {
      return undefined;
    }
    if (res.status !== 201) {
      throw new Error(`reserve answered ${res.status}`);
    }
    return ((await res.json()) as { holdId: string }).holdId;
  }

  /** Reserves and waits until the order exists in Postgres. */
  async reserveOrder(eventId: string, userId: string, qty = 1): Promise<string> {
    const id = await this.reserve(eventId, userId, qty);
    if (!id) {
      throw new Error("sold out");
    }
    await waitFor(
      `order ${id} to be created`,
      30_000,
      async () => (await this.order(id)) !== undefined,
    );
    return id;
  }

  pay(orderId: string): Promise<Response> {
    return fetch(`http://localhost:${PORTS.orderApi}/orders/${encodeURIComponent(orderId)}/pay`, {
      method: "POST",
    });
  }

  async apiOrder(orderId: string): Promise<{ state: string } | undefined> {
    const res = await fetch(
      `http://localhost:${PORTS.orderApi}/orders/${encodeURIComponent(orderId)}`,
    );
    return res.status === 200 ? ((await res.json()) as { state: string }) : undefined;
  }

  // -- reading results --

  async order(id: string): Promise<OrderRow | undefined> {
    const res = await this.orders.query<OrderRow>(
      // Timestamps are `timestamp` columns holding UTC; AT TIME ZONE makes pg parse them as the instants they are.
      `SELECT id, "eventId", qty, state, "holdSettledAt", "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt" FROM ${ORDER_TABLE} WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  }

  async paymentsFor(orderId: string): Promise<PaymentRow[]> {
    const res = await this.payments.query<PaymentRow>(
      `SELECT "orderId", status, "chargeId" FROM ${PAYMENT_TABLE} WHERE "orderId" = $1`,
      [orderId],
    );
    return res.rows;
  }

  async stateOf(id: string): Promise<string | undefined> {
    return (await this.order(id))?.state;
  }

  async waitForState(id: string, states: string[], timeoutMs = 60_000): Promise<string> {
    let last: string | undefined;
    await waitFor(
      `order ${id} to reach ${states.join("|")} (last: ${last})`,
      timeoutMs,
      async () => {
        last = await this.stateOf(id);
        return last !== undefined && states.includes(last);
      },
    );
    return last as string;
  }

  /** Redis inventory for a sale: avail, sold, and the members of the holds ZSET. */
  async inventory(eventId: string): Promise<{ avail: number; sold: number; holds: string[] }> {
    const [avail, sold, holds] = await Promise.all([
      this.redis.get(`ev:${eventId}:avail`),
      this.redis.get(`ev:${eventId}:sold`),
      this.redis.zrange(`ev:${eventId}:holds`, "0", "-1"),
    ]);
    return { avail: Number(avail ?? 0), sold: Number(sold ?? 0), holds };
  }

  /** Current value of an unlabelled counter on the order worker's /metrics. */
  async workerMetric(name: string, port = PORTS.orderWorker): Promise<number> {
    const text = await (await fetch(`http://localhost:${port}/metrics`)).text();
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name} `));
    return line ? Number(line.split(" ")[1]) : 0;
  }

  // -- Kafka --

  async produce(topic: string, key: string, value: unknown): Promise<void> {
    if (!this.#producer) {
      const kafka = new KafkaJS.Kafka({ "bootstrap.servers": KAFKA_BROKERS });
      this.#producer = kafka.producer({ acks: -1 });
      await this.#producer.connect();
    }
    await this.#producer.send({ topic, messages: [{ key, value: JSON.stringify(value) }] });
  }

  /** Total lag of a consumer group, from the broker; undefined when it cannot be read. */
  async groupLag(group: string): Promise<number | undefined> {
    try {
      const { stdout } = await run("docker", [
        "compose",
        "-p",
        process.env.COMPOSE_PROJECT_NAME ?? "flash-sale",
        "-f",
        `${ROOT}infra/docker/docker-compose.yml`,
        "exec",
        "-T",
        "redpanda",
        "rpk",
        "group",
        "describe",
        group,
      ]);
      const match = /TOTAL-LAG\s+(\d+)/.exec(stdout);
      return match ? Number(match[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves once the system has nothing left to do: no PAYMENT_PENDING order, no PAID / EXPIRED /
   * PAYMENT_FAILED order with an open hold, and no lag on any consumer group.
   */
  async waitQuiet(timeoutMs = 120_000, { untilNoHeld = false } = {}): Promise<void> {
    let why = "";
    await waitFor(
      `the system to go quiet (${why})`,
      timeoutMs,
      async () => {
        const open = await this.orders.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${ORDER_TABLE}
          WHERE state = 'PAYMENT_PENDING'
             ${untilNoHeld ? "OR state = 'HELD'" : ""}
             OR (state IN ('PAID', 'EXPIRED', 'PAYMENT_FAILED') AND "holdSettledAt" IS NULL)`,
        );
        if (Number(open.rows[0]?.n) > 0) {
          why = `${open.rows[0]?.n} orders still open`;
          return false;
        }
        for (const group of CONSUMER_GROUPS) {
          const lag = await this.groupLag(group);
          if (lag !== undefined && lag > 0) {
            why = `${group} lag ${lag}`;
            return false;
          }
        }
        return true;
      },
      500,
    );
  }
}

async function migrate(service: string, databaseUrl: string): Promise<void> {
  await run("pnpm", ["-C", `${ROOT}services/${service}`, "exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: true,
  });
}

/** An order's id is the hold id; the users the scenarios use pick the mock's result by prefix. */
export const users = { ok: "ok-user", fail: "fail-user", plain: "plain-user" };

export interface Report {
  pass: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
}

export function describeReport(report: Report): string {
  return report.checks
    .map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`)
    .join(String.fromCharCode(10));
}

const MEASUREMENTS = `${ROOT}docs/results/raw/phase4-measurements.json`;

/** Keeps a number a scenario measured (console output from tests is not reliably captured). */
export function record(key: string, value: number | string): void {
  mkdirSync(`${ROOT}docs/results/raw`, { recursive: true });
  const all = existsSync(MEASUREMENTS) ? JSON.parse(readFileSync(MEASUREMENTS, "utf8")) : {};
  all[key] = value;
  writeFileSync(MEASUREMENTS, JSON.stringify(all, null, 2));
}
