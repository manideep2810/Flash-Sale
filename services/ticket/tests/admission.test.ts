import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@flash/observability";
import { register } from "prom-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mintAdmissionToken, TEST_ADMISSION_SECRET } from "../../../tools/admission-token.js";
import {
  admissionAccepted,
  admissionNotRequired,
  admissionRejected,
  createRequireAdmission,
  REJECTION_REASONS,
  type RejectionReason,
  type RequireAdmission,
} from "../src/admission.js";
import type { RedisPool, ReserveScript } from "../src/redis/index.js";
import { createApp } from "../src/server.js";

// POST /redis/reserve behind the admission check, with no Redis: the reserve script and the pool are
// stand-ins that record every use, so a test can say both "nothing reached Redis" and "exactly one
// reserve ran". tests/admission-redis.test.ts repeats the first claim against the real client.

const logger = createLogger({ service: "ticket", level: "error" });

/** Every call the handler makes towards Redis ends up in `calls`. */
function recorder() {
  const calls: string[] = [];
  const script: ReserveScript = {
    sha: "recorded",
    async reserve(eventId, userId, qty) {
      calls.push(`reserve ${eventId} ${userId} ${qty}`);
      return { ok: true, holdId: `${eventId}:${userId}:1` };
    },
  };
  // The reserve handler has no business with the pool at all, so touching it in any way is recorded
  // and fails the request.
  const pool = new Proxy({} as RedisPool, {
    get(_target, property) {
      calls.push(`pool.${String(property)}`);
      throw new Error(`the redis pool was touched: ${String(property)}`);
    },
  });
  return { calls, script, pool };
}

interface Running {
  calls: string[];
  reserve(
    body: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function start(requireAdmission: RequireAdmission): Promise<Running> {
  const { calls, script, pool } = recorder();
  const app = createApp(logger, undefined, {
    reserveScript: script,
    redisPool: pool,
    requireAdmission,
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redis/reserve`;
  return {
    calls,
    async reserve(body, token) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { "x-admission-token": token }),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}

// ---- Tokens the tests need that the mint helper will not make ------------------------------------

const b64url = (value: object | string) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

interface Forged {
  sub?: string | null;
  eid?: string | null;
  aud?: string;
  iss?: string;
  /** Seconds from now; negative is in the past. Null leaves `exp` out. */
  expIn?: number | null;
  alg?: "HS256" | "HS512" | "none";
  secret?: string;
}

/** Signs by hand, so the test controls every part: claims, algorithm and key. */
function forge({
  sub = "alice",
  eid = "evt-a",
  aud = "reserve",
  iss = "queue-svc",
  expIn = 120,
  alg = "HS256",
  secret = TEST_ADMISSION_SECRET,
}: Forged = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...(sub === null ? {} : { sub }),
    ...(eid === null ? {} : { eid }),
    aud,
    iss,
    iat: now,
    ...(expIn === null ? {} : { exp: now + expIn }),
  };
  const signingInput = `${b64url({ alg, typ: "JWT" })}.${b64url(claims)}`;
  if (alg === "none") {
    return `${signingInput}.`;
  }
  const digest = alg === "HS512" ? "sha512" : "sha256";
  return `${signingInput}.${createHmac(digest, secret).update(signingInput).digest("base64url")}`;
}

/** Tokens count time in whole seconds; start a time-sensitive case with most of a second in hand. */
async function earlyInTheSecond(): Promise<void> {
  const intoSecond = Date.now() % 1000;
  if (intoSecond > 600) {
    await sleep(1000 - intoSecond + 5);
  }
}

// ---- Metrics ---------------------------------------------------------------------------------------

async function counts(): Promise<Record<RejectionReason | "accepted", number>> {
  const rejected = (await admissionRejected.get()).values;
  const of = (reason: RejectionReason) =>
    rejected.find((sample) => sample.labels.reason === reason)?.value ?? 0;
  return {
    ADMISSION_REQUIRED: of("ADMISSION_REQUIRED"),
    TOKEN_EXPIRED: of("TOKEN_EXPIRED"),
    TOKEN_INVALID: of("TOKEN_INVALID"),
    TOKEN_MISMATCH: of("TOKEN_MISMATCH"),
    accepted: (await admissionAccepted.get()).values[0]?.value ?? 0,
  };
}

/** Runs `request` and checks that exactly one counter moved, by exactly one: `expected`. */
async function counting<T>(
  expected: RejectionReason | "accepted" | "nothing",
  request: () => Promise<T>,
): Promise<T> {
  const before = await counts();
  const result = await request();
  const after = await counts();
  for (const key of [...REJECTION_REASONS, "accepted"] as const) {
    expect(after[key] - before[key], `${key} counter`).toBe(key === expected ? 1 : 0);
  }
  return result;
}

const ALICE = { eventId: "evt-a", userId: "alice", qty: 1 };

describe("POST /redis/reserve admission check", () => {
  let app: Running;

  beforeAll(async () => {
    app = await start(createRequireAdmission({ secret: TEST_ADMISSION_SECRET, logger }));
  });

  afterAll(async () => {
    await app?.close();
  });

  /** The request is refused with `code`, counted once under it, and nothing reaches Redis. */
  async function expectRefused(
    status: 401 | 403,
    code: RejectionReason,
    body: unknown,
    token?: string,
  ): Promise<void> {
    app.calls.length = 0;
    const reply = await counting(code, () => app.reserve(body, token));
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual({ code, message: expect.any(String) });
    if (token) {
      expect(JSON.stringify(reply.body)).not.toContain(token);
    }
    expect(app.calls).toEqual([]);
  }

  it("1. refuses a request with no token, and sends nothing to Redis", async () => {
    await expectRefused(401, "ADMISSION_REQUIRED", ALICE);
    await expectRefused(401, "ADMISSION_REQUIRED", ALICE, "");
    await expectRefused(401, "ADMISSION_REQUIRED", ALICE, "   ");
  });

  it("runs before the body is validated", async () => {
    // Without the check this body is a 400.
    await expectRefused(401, "ADMISSION_REQUIRED", { nonsense: true });
  });

  it("lets a valid token through to the reserve, unchanged", async () => {
    app.calls.length = 0;
    const token = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    const reply = await counting("accepted", () => app.reserve({ ...ALICE, qty: 2 }, token));
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ holdId: "evt-a:alice:1" });
    expect(app.calls).toEqual(["reserve evt-a alice 2"]);
  });

  it("validates the body once the caller is admitted", async () => {
    app.calls.length = 0;
    const token = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    const reply = await app.reserve({ ...ALICE, qty: 0 }, token);
    expect(reply.status).toBe(400);
    expect(app.calls).toEqual([]);
  });

  it("3. refuses a token signed with another secret", async () => {
    const token = forge({ secret: "another-secret-another-secret-another-secret" });
    await expectRefused(401, "TOKEN_INVALID", ALICE, token);
  });

  it("4. refuses a hand-built alg 'none' token", async () => {
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ alg: "none" }));
  });

  it("5. refuses an HS512 token signed with the right secret", async () => {
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ alg: "HS512" }));
  });

  it("6. refuses a token that expired 10s ago, and accepts one that expired 1s ago", async () => {
    await expectRefused(401, "TOKEN_EXPIRED", ALICE, forge({ expIn: -10 }));

    // Inside the 2s clock tolerance.
    await earlyInTheSecond();
    app.calls.length = 0;
    const reply = await counting("accepted", () => app.reserve(ALICE, forge({ expIn: -1 })));
    expect(reply.status).toBe(201);
    expect(app.calls).toEqual(["reserve evt-a alice 1"]);
  });

  it("7. refuses bob's token when the caller is alice", async () => {
    const token = await mintAdmissionToken({ userId: "bob", eventId: "evt-a" });
    await expectRefused(403, "TOKEN_MISMATCH", ALICE, token);
  });

  it("8. refuses a token for event A on a reserve for event B", async () => {
    const token = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    await expectRefused(403, "TOKEN_MISMATCH", { ...ALICE, eventId: "evt-b" }, token);
  });

  it("9. refuses a token with the wrong audience or issuer", async () => {
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ aud: "session" }));
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ iss: "someone-else" }));
  });

  it("refuses a malformed token, and one missing exp, sub or eid", async () => {
    await expectRefused(401, "TOKEN_INVALID", ALICE, "not-a-jwt");
    await expectRefused(401, "TOKEN_INVALID", ALICE, "a.b.c");
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ expIn: null }));
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ sub: null }));
    await expectRefused(401, "TOKEN_INVALID", ALICE, forge({ eid: null }));
  });

  it("10. exports every rejection reason, and the accepted count", async () => {
    // Each case above already checked that it moved its own counter by one and no other.
    const rejected = await register.getSingleMetricAsString("admission_rejected_total");
    for (const reason of REJECTION_REASONS) {
      expect(rejected).toContain(`admission_rejected_total{reason="${reason}"}`);
    }
    expect(await register.getSingleMetricAsString("admission_accepted_total")).toMatch(
      /^admission_accepted_total \d+$/m,
    );
  });

  it("logs a rejection at debug with the reason and the caller, never the token", async () => {
    const quiet = createLogger({ service: "ticket", level: "error" });
    const debug = vi.spyOn(quiet, "debug");
    const requireAdmission = createRequireAdmission({
      secret: TEST_ADMISSION_SECRET,
      logger: quiet,
    });
    const token = forge({ sub: "bob" });

    await expect(requireAdmission(token, "alice", "evt-a")).rejects.toMatchObject({
      status: 403,
      code: "TOKEN_MISMATCH",
    });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("admission rejected", {
      reason: "TOKEN_MISMATCH",
      callerId: "alice",
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(token);
  });

  it("refuses to build the check on a secret under 32 bytes", () => {
    expect(() => createRequireAdmission({ secret: "x".repeat(31), logger })).toThrow(/32 bytes/);
  });
});

describe("POST /redis/reserve with REQUIRE_ADMISSION=false", () => {
  it("11. reserves without a token, and counts nothing", async () => {
    const app = await start(admissionNotRequired);
    try {
      const reply = await counting("nothing", () => app.reserve(ALICE));
      expect(reply.status).toBe(201);
      expect(app.calls).toEqual(["reserve evt-a alice 1"]);
    } finally {
      await app.close();
    }
  });
});

describe("createApp", () => {
  it("will not mount /redis/reserve without an admission check", () => {
    const { script, pool } = recorder();
    expect(() => createApp(logger, undefined, { reserveScript: script, redisPool: pool })).toThrow(
      /requireAdmission is required/,
    );
  });
});
