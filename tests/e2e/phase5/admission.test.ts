// The waiting room end to end, service to service: join -> admitted by the admitter -> status hands
// out the token -> that token opens POST /redis/reserve on the ticket service. Each call carries the
// user's session. (gateway.test.ts covers the same path through Envoy.)
//
//   pnpm -C tests/e2e run test:phase5
//
// Starts the ticket service, queue-svc and queue-admitter as child processes on their usual ports
// (stop `make dev` first), all given one SESSION_SECRET and one ADMISSION_SECRET. Needs only Redis
// from the local stack.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, TEST_ADMISSION_SECRET, TEST_SESSION_SECRET } from "../../../tools/tokens.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const TICKET = "http://localhost:3001";
const QUEUE = "http://localhost:4100";

async function waitFor(what: string, timeoutMs: number, done: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(100);
  }
}

/** One service process, started the way tests/e2e/phase4/support.ts starts its own. */
class Proc {
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

interface Reply {
  status?: string;
  code?: string;
  token?: string;
  expiresAt?: string;
  holdId?: string;
}

async function call(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Reply }> {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

describe("admission token, from the waiting room to /redis/reserve", () => {
  const shared = {
    REDIS_URL,
    SESSION_SECRET: TEST_SESSION_SECRET,
    ADMISSION_SECRET: TEST_ADMISSION_SECRET,
  };
  const procs = [
    new Proc("ticket", "ticket", "src/index.ts", `${TICKET}/healthz/ready`, {
      ...shared,
      PORT: "3001",
      METRICS_PORT: "9464",
      WORKERS: "1",
    }),
    new Proc("queue-svc", "queue", "src/http/server.ts", `${QUEUE}/readyz`, {
      ...shared,
      PORT: "4100",
    }),
    new Proc("queue-admitter", "queue", "src/admitter/main.ts", "http://localhost:3011/healthz", {
      ...shared,
      PORT: "4100",
      ADMITTER_PORT: "3011",
    }),
  ];

  const eventId = `e2e-admission-${randomUUID().slice(0, 8)}`;
  let redis: Redis;

  const avail = async () => Number(await redis.get(`ev:${eventId}:avail`));

  /** Joins, then polls status the way a client would until the admitter has let the user in. */
  async function admit(userId: string): Promise<string> {
    const session = { authorization: await bearer(userId) };
    const joined = await call("POST", `${QUEUE}/queue/${eventId}/join`, session);
    expect(joined.status).toBe(200);
    expect(["QUEUED", "ADMITTED"]).toContain(joined.body.status);

    let token: string | undefined;
    await waitFor(`${userId} to be admitted`, 15_000, async () => {
      const { body } = await call("GET", `${QUEUE}/queue/${eventId}/status`, session);
      token = body.token;
      return body.status === "ADMITTED";
    });
    return String(token);
  }

  /** As `userId`, logged in, unless `userId` is null. The body does not say who is reserving. */
  const reserve = async (userId: string | null, token?: string) =>
    call(
      "POST",
      `${TICKET}/redis/reserve`,
      {
        ...(userId === null ? {} : { authorization: await bearer(userId) }),
        ...(token === undefined ? {} : { "x-admission-token": token }),
      },
      { eventId, qty: 1 },
    );

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    try {
      await redis.ping();
    } catch (error) {
      redis.disconnect();
      throw new Error(
        `redis is not reachable (${(error as Error).message}): run \`make up\` first`,
      );
    }
    try {
      await Promise.all(procs.map((proc) => proc.start()));
    } catch (error) {
      await Promise.all(procs.map((proc) => proc.kill()));
      redis.disconnect();
      throw error;
    }

    // Stock through the ticket service, as in every other run; then the waiting room, already open.
    const reset = await call("POST", `${TICKET}/redis/reset`, {}, { eventId, total: 3 });
    expect(reset.status).toBe(200);
    const openedAt = String(Date.now() - 60_000);
    await redis.hset(`ev:${eventId}:config`, {
      lobbyOpensAt: openedAt,
      saleOpensAt: openedAt,
      admitRatePerSec: "50",
      admitTtlSec: "120",
    });
    await redis.sadd("queue:events", eventId);
  });

  afterAll(async () => {
    await Promise.all(procs.map((proc) => proc.kill()));
    if (!redis) {
      return;
    }
    const names = ["config", "queue", "admitted", "state"];
    const inventory = ["avail", "total", "holds", "stream", "held", "sold"];
    await redis.del(...[...names, ...inventory].map((name) => `ev:${eventId}:${name}`));
    await redis.srem("queue:events", eventId);
    await redis.srem("events:active", eventId);
    redis.disconnect();
  });

  it("2. reserves with the token queue-svc hands an admitted user", async () => {
    const token = await admit("alice");

    const reserved = await reserve("alice", token);
    expect(reserved.status).toBe(201);
    expect(reserved.body.holdId).toContain(`${eventId}:alice:`);
    expect(await avail()).toBe(2);
    expect(await redis.zcard(`ev:${eventId}:holds`)).toBe(1);
  });

  it("refuses the same reserve without the token, or with someone else's", async () => {
    const alices = await admit("alice");

    // No session: alice's admission token alone is not enough.
    const anonymous = await reserve(null, alices);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("UNAUTHENTICATED");

    const none = await reserve("bob");
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("ADMISSION_REQUIRED");

    const borrowed = await reserve("bob", alices);
    expect(borrowed.status).toBe(403);
    expect(borrowed.body.code).toBe("TOKEN_MISMATCH");

    // Nothing was taken from stock by either.
    expect(await avail()).toBe(2);

    // Bob waits his turn like anyone else, and then it works.
    const bobs = await admit("bob");
    expect((await reserve("bob", bobs)).status).toBe(201);
    expect(await avail()).toBe(1);
  });
});
