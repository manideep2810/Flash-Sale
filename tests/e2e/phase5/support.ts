// Shared plumbing for the Phase 5 end-to-end tests: the waiting-room processes as children of the
// test, a JSON HTTP helper, and seeding and clearing a sale's waiting room in Redis.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Redis } from "ioredis";
import { bearer, TEST_ADMISSION_SECRET, TEST_SESSION_SECRET } from "../../../tools/tokens.js";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

/** The gateway: what a client talks to. */
export const GATEWAY = "http://localhost:8080";
export const ENVOY_ADMIN = "http://127.0.0.1:9901";
/** The services' own addresses, which the tests use to go around the gateway. */
export const TICKET = "http://localhost:3001";
export const ORDER_API = "http://localhost:3003";
export const QUEUE = "http://localhost:4100";
export const WEB = "http://localhost:3012";

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

// ---- docker compose ----------------------------------------------------------------------------------

const run = promisify(execFile);
const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "flash-sale";
const COMPOSE_FILE = `${ROOT}infra/docker/docker-compose.yml`;
const TEST_OVERRIDE = `${ROOT}infra/docker/docker-compose.test.yml`;
export const GATEWAY_CONTAINERS = ["envoy", "ratelimit", "redis-ratelimit"];

/**
 * `docker compose ...` on the local stack. With `testLimits` the gateway's test override is layered
 * on (infra/docker/docker-compose.test.yml) and the gateway is given the secrets the tests mint
 * with; without it compose reads them from infra/docker/.env, as `make up` does.
 */
export async function compose(args: string[], { testLimits = false } = {}): Promise<string> {
  const files = testLimits ? ["-f", COMPOSE_FILE, "-f", TEST_OVERRIDE] : ["-f", COMPOSE_FILE];
  const { stdout } = await run("docker", ["compose", "-p", PROJECT, ...files, ...args], {
    env: testLimits ? { ...process.env, ...SECRETS } : process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** True when Envoy's health checks have passed for every one of the named clusters. */
export async function clustersHealthy(names: string[]): Promise<boolean> {
  const text = await (await fetch(`${ENVOY_ADMIN}/clusters`)).text();
  return names.every((name) =>
    new RegExp(`^${name}::[^:]+:\\d+::health_flags::healthy$`, "m").test(text),
  );
}

// ---- child processes -----------------------------------------------------------------------------------

/** One service process, started the way tests/e2e/phase4/support.ts starts its own. */
export class Proc {
  #child: ChildProcess | undefined;
  #output = "";

  constructor(
    readonly name: string,
    /** Directory the process runs in, under the repo root. */
    private readonly dir: string,
    /** A TypeScript entrypoint (run under tsx), or the full argument list for node. */
    private readonly entry: string | string[],
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
    const args = Array.isArray(this.entry) ? this.entry : ["--import", "tsx", this.entry];
    const child = spawn(process.execPath, args, {
      cwd: `${ROOT}${this.dir}`,
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
    new Proc("queue-svc", "services/queue", "src/http/server.ts", `${QUEUE}/readyz`, env),
    new Proc(
      "queue-admitter",
      "services/queue",
      "src/admitter/main.ts",
      "http://localhost:3011/healthz",
      env,
    ),
  ];
}

/** The ticket service alone, for tests that need no orders (the Phase 4 harness has its own). */
export function ticketProc(): Proc {
  return new Proc("ticket", "services/ticket", "src/index.ts", `${TICKET}/healthz/ready`, {
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

/** The built web app (`next build` must have run), served the way `pnpm -C web start` serves it. */
export function webProc(): Proc {
  return new Proc(
    "web",
    "web",
    ["node_modules/next/dist/bin/next", "start", "-p", "3012"],
    `${WEB}/healthz`,
    {},
  );
}

/** Builds the web app. Slow (tens of seconds), so a suite does it once. */
export async function buildWeb(): Promise<void> {
  await run(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    cwd: `${ROOT}web`,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export interface WaitingRoomOptions {
  admitRatePerSec?: number;
  admitTtlSec?: number;
  /** What the event page shows. */
  name?: string;
  price?: number;
}

/** Opens a waiting room for a sale: lobby and sale open a minute ago. Stock is seeded separately. */
export async function openWaitingRoom(
  redis: Redis,
  eventId: string,
  { admitRatePerSec = 50, admitTtlSec = 120, name, price }: WaitingRoomOptions = {},
): Promise<void> {
  const openedAt = String(Date.now() - 60_000);
  await redis.hset(`ev:${eventId}:config`, {
    lobbyOpensAt: openedAt,
    saleOpensAt: openedAt,
    admitRatePerSec: String(admitRatePerSec),
    admitTtlSec: String(admitTtlSec),
    ...(name === undefined ? {} : { name }),
    ...(price === undefined ? {} : { price: String(price) }),
  });
  await redis.sadd("queue:events", eventId);
}

export interface EventOptions {
  id: string;
  name?: string;
  /** Per ticket, in the smallest currency unit. */
  price?: number;
  totalStock?: number;
  /** From now, in ms; negative is in the past. The default is a sale that opened a minute ago. */
  lobbyOpensInMs?: number;
  saleOpensInMs?: number;
  admitRatePerSec?: number;
  admitTtlSec?: number;
}

/**
 * Puts an event on sale the way the admin page does: POST /admin/events on the ticket service, with
 * an admin session minted here. It gets its row in the catalogue, its stock and its waiting room.
 */
export async function createEvent({
  id,
  name = "Test event",
  price = 1_999,
  totalStock = 10,
  lobbyOpensInMs = -60_000,
  saleOpensInMs = -60_000,
  admitRatePerSec = 50,
  admitTtlSec = 120,
}: EventOptions): Promise<void> {
  const now = Date.now();
  const res = await call(
    "POST",
    `${TICKET}/admin/events`,
    { authorization: await bearer("admin", "admin") },
    {
      id,
      name,
      price,
      totalStock,
      lobbyOpensAt: now + lobbyOpensInMs,
      saleOpensAt: now + saleOpensInMs,
      admitRatePerSec,
      admitTtlSec,
    },
  );
  if (res.status !== 201) {
    throw new Error(`creating the event "${id}" answered ${res.status} ${res.body.code ?? ""}`);
  }
}

/** Removes everything a test sale left in Redis: its waiting room and its inventory. */
export async function forgetSale(redis: Redis, eventId: string): Promise<void> {
  const names = ["config", "queue", "admitted", "state", "avail", "total", "holds", "stream"];
  await redis.del(...[...names, "held", "sold"].map((name) => `ev:${eventId}:${name}`));
  await redis.srem("queue:events", eventId);
  await redis.srem("events:active", eventId);
}
