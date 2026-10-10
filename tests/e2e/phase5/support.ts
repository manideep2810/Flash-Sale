// Shared plumbing for the Phase 5 end-to-end tests: the waiting-room processes as children of the
// test, a JSON HTTP helper, and seeding and clearing a sale's waiting room in Redis.

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { TEST_ADMISSION_SECRET, TEST_SESSION_SECRET } from "../../../tools/tokens.js";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

/** The services' own addresses, which the tests use to go around the gateway. */
export const TICKET = "http://localhost:3001";
export const ORDER_API = "http://localhost:3003";
export const QUEUE = "http://localhost:4100";

/** What every process that verifies a token is started with: the secrets tools/tokens.ts mints with. */
export const SECRETS = {
  SESSION_SECRET: TEST_SESSION_SECRET,
  ADMISSION_SECRET: TEST_ADMISSION_SECRET,
};

export async function waitFor(
  what: string,
  timeoutMs: number,
  done: () => Promise<boolean>,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(pollMs);
  }
}

/** One service process, started the way tests/e2e/phase4/support.ts starts its own. */
export class Proc {
  #child: ChildProcess | undefined;
  #output = "";

  constructor(
    readonly name: string,
    private readonly service: string,
    private readonly entry: string,
    /** Answers 200 once the process is up. */
    private readonly readyUrl: string,
    private readonly env: Record<string, string>,
  ) {}

  async #ready(): Promise<boolean> {
    try {
      const res = await fetch(this.readyUrl, { signal: AbortSignal.timeout(1_000) });
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (await this.#ready()) {
      throw new Error(
        `${this.readyUrl} is already serving: stop the ${this.name} service (\`make dev\`) before running the e2e tests`,
      );
    }
    // `node --import tsx` rather than the tsx CLI: the CLI runs the program in a child of its own,
    // and killing the wrapper would leave the real process alive.
    const child = spawn(process.execPath, ["--import", "tsx", this.entry], {
      cwd: `${ROOT}services/${this.service}`,
      env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "warn", ...this.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      this.#output = (this.#output + chunk.toString()).slice(-4_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    this.#child = child;

    await waitFor(`${this.name} to become ready`, 30_000, async () => {
      if (child.exitCode !== null) {
        throw new Error(`${this.name} exited during startup:\n${this.#output}`);
      }
      return this.#ready();
    }).catch((error) => {
      throw new Error(`${(error as Error).message}\n${this.#output}`);
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
    await waitFor(`${this.name} to stop answering`, 10_000, async () => !(await this.#ready()));
  }
}

/** queue-svc and the one admitter, on their usual ports. */
export function queueProcs(): Proc[] {
  const env = { REDIS_URL, ...SECRETS, PORT: "4100", ADMITTER_PORT: "3011" };
  return [
    new Proc("queue-svc", "queue", "src/http/server.ts", `${QUEUE}/readyz`, env),
    new Proc(
      "queue-admitter",
      "queue",
      "src/admitter/main.ts",
      "http://localhost:3011/healthz",
      env,
    ),
  ];
}

/** The ticket service alone, for tests that need no orders (the Phase 4 harness has its own). */
export function ticketProc(): Proc {
  return new Proc("ticket", "ticket", "src/index.ts", `${TICKET}/healthz/ready`, {
    REDIS_URL,
    ...SECRETS,
    PORT: "3001",
    METRICS_PORT: "9464",
    WORKERS: "1",
  });
}

/** The fields of the services' and the gateway's replies the tests read. */
export interface Reply {
  status?: string;
  state?: string;
  code?: string;
  message?: string;
  token?: string;
  expiresAt?: string;
  holdId?: string;
  error?: string;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Reply;
}

/** One JSON request. A reply that is not JSON comes back with an empty body. */
export async function call(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Reply = {};
  try {
    parsed = text ? (JSON.parse(text) as Reply) : {};
  } catch {
    // Not JSON: the status and headers are what the caller is after.
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** Opens a waiting room for a sale whose stock is already seeded: lobby and sale open a minute ago. */
export async function openWaitingRoom(redis: Redis, eventId: string): Promise<void> {
  const openedAt = String(Date.now() - 60_000);
  await redis.hset(`ev:${eventId}:config`, {
    lobbyOpensAt: openedAt,
    saleOpensAt: openedAt,
    admitRatePerSec: "50",
    admitTtlSec: "120",
  });
  await redis.sadd("queue:events", eventId);
}

/** Removes everything a test sale left in Redis: its waiting room and its inventory. */
export async function forgetSale(redis: Redis, eventId: string): Promise<void> {
  const names = ["config", "queue", "admitted", "state", "avail", "total", "holds", "stream"];
  await redis.del(...[...names, "held", "sold"].map((name) => `ev:${eventId}:${name}`));
  await redis.srem("queue:events", eventId);
  await redis.srem("events:active", eventId);
}
