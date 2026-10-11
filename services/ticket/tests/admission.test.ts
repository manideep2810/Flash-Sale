import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { requireSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { register } from "prom-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mintAdmissionToken,
  mintSessionToken,
  TEST_ADMISSION_SECRET,
  TEST_SESSION_SECRET,
} from "../../../tools/tokens.js";
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

// POST /redis/reserve behind the session and the admission check, with no Redis: the reserve script
// and the pool are stand-ins that record every use, so a test can say both "nothing reached Redis"
// and "exactly one reserve ran". tests/admission-redis.test.ts repeats the first claim against the
// real client.

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

interface Caller {
  /** Whose session to send. Null sends none; a string starting with "raw:" is sent as the header. */
  as?: string | null;
  /** The X-Admission-Token header, when given. */
  admission?: string;
}

interface Running {
  calls: string[];
  reserve(
    body: unknown,
    caller?: Caller,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function start(requireAdmission: RequireAdmission): Promise<Running> {
  const { calls, script, pool } = recorder();
  const app = createApp(logger, undefined, {
    reserveScript: script,
    redisPool: pool,
    authenticate: requireSession(TEST_SESSION_SECRET),
    requireAdmission,
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redis/reserve`;
  return {
    calls,
    async reserve(body, { as = "alice", admission } = {}) {
      const authorization =
        as === null
          ? undefined
          : as.startsWith("raw:")
            ? as.slice(4)
            : `Bearer ${await mintSessionToken(as)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
          ...(admission === undefined ? {} : { "x-admission-token": admission }),
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

// ---- Tokens the tests need that the mint helpers will not make -----------------------------------

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

/** Signs by hand, so the test controls every part: claims, algorithm and key. An admission token by default. */
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

/** A hand-signed session for alice, for the cases a real login would never produce. */
const forgeSession = (overrides: Forged = {}) =>
  forge({
    eid: null,
    aud: "session",
    iss: "order-api",
    expIn: 3600,
    secret: TEST_SESSION_SECRET,
    ...overrides,
  });

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

/** What alice sends. Who she is comes from her session, so the body does not say. */
const BODY = { eventId: "evt-a", qty: 1 };

describe("POST /redis/reserve: the caller", () => {
  let app: Running;

  beforeAll(async () => {
    app = await start(createRequireAdmission({ secret: TEST_ADMISSION_SECRET, logger }));
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Refused by the session check: 401 with `code`, no admission counter moves, nothing reaches Redis. */
  async function expectNoCaller(code: string, caller: Caller): Promise<void> {
    app.calls.length = 0;
    const reply = await counting("nothing", () => app.reserve(BODY, caller));
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ code, message: expect.any(String) });
    expect(app.calls).toEqual([]);
  }

  it("refuses a request with no session before it looks at anything else", async () => {
    const admission = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    // A perfectly good admission token does not help: there is nobody for it to belong to.
    await expectNoCaller("UNAUTHENTICATED", { as: null, admission });
    await expectNoCaller("UNAUTHENTICATED", { as: "raw:Bearer not-a-jwt", admission });
    await expectNoCaller("UNAUTHENTICATED", { as: `raw:${await mintSessionToken("alice")}` });
  });

  it("refuses an expired session as SESSION_EXPIRED", async () => {
    await expectNoCaller("SESSION_EXPIRED", { as: `raw:Bearer ${forgeSession({ expIn: -10 })}` });
  });

  it("refuses a forged session, and an admission token offered as one", async () => {
    const admission = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    const notSessions = [
      forgeSession({ secret: "another-secret-another-secret-another-secret" }),
      forgeSession({ alg: "none" }),
      forgeSession({ aud: "reserve" }),
      forgeSession({ iss: "queue-svc" }),
      admission,
    ];
    for (const token of notSessions) {
      await expectNoCaller("UNAUTHENTICATED", { as: `raw:Bearer ${token}`, admission });
    }
  });

  it("takes the caller from the session, whatever the body or an x-user-id header claims", async () => {
    app.calls.length = 0;
    const admission = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    const reply = await app.reserve({ ...BODY, userId: "mallory" }, { as: "alice", admission });
    expect(reply.status).toBe(201);
    expect(app.calls).toEqual(["reserve evt-a alice 1"]);

    // And naming someone else in the body does not let alice use their admission.
    app.calls.length = 0;
    const mallorys = await mintAdmissionToken({ userId: "mallory", eventId: "evt-a" });
    const borrowed = await app.reserve(
      { ...BODY, userId: "mallory" },
      { as: "alice", admission: mallorys },
    );
    expect(borrowed.status).toBe(403);
    expect(borrowed.body).toMatchObject({ code: "TOKEN_MISMATCH" });
    expect(app.calls).toEqual([]);
  });
});

describe("POST /redis/reserve: the admission check", () => {
  let app: Running;

  beforeAll(async () => {
    app = await start(createRequireAdmission({ secret: TEST_ADMISSION_SECRET, logger }));
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Alice, logged in, is refused with `code`, counted once under it, and nothing reaches Redis. */
  async function expectRefused(
    status: 401 | 403,
    code: RejectionReason,
    body: unknown,
    admission?: string,
  ): Promise<void> {
    app.calls.length = 0;
    const reply = await counting(code, () => app.reserve(body, { admission }));
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual({ code, message: expect.any(String) });
    if (admission) {
      expect(JSON.stringify(reply.body)).not.toContain(admission);
    }
    expect(app.calls).toEqual([]);
  }

  it("1. refuses a request with no admission token, and sends nothing to Redis", async () => {
    await expectRefused(401, "ADMISSION_REQUIRED", BODY);
    await expectRefused(401, "ADMISSION_REQUIRED", BODY, "");
    await expectRefused(401, "ADMISSION_REQUIRED", BODY, "   ");
  });

  it("runs before the body is validated", async () => {
    // Without the check this body is a 400.
    await expectRefused(401, "ADMISSION_REQUIRED", { nonsense: true });
  });

  it("lets a valid token through to the reserve, unchanged", async () => {
    app.calls.length = 0;
    const admission = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    const reply = await counting("accepted", () => app.reserve({ ...BODY, qty: 2 }, { admission }));
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ holdId: "evt-a:alice:1" });
    expect(app.calls).toEqual(["reserve evt-a alice 2"]);
  });

  it("validates the body once the caller is admitted", async () => {
    app.calls.length = 0;
    const admission = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    const reply = await app.reserve({ ...BODY, qty: 0 }, { admission });
    expect(reply.status).toBe(400);
    expect(app.calls).toEqual([]);
  });

  it("3. refuses a token signed with another secret", async () => {
    const token = forge({ secret: "another-secret-another-secret-another-secret" });
    await expectRefused(401, "TOKEN_INVALID", BODY, token);
  });

  it("4. refuses a hand-built alg 'none' token", async () => {
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ alg: "none" }));
  });

  it("5. refuses an HS512 token signed with the right secret", async () => {
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ alg: "HS512" }));
  });

  it("6. refuses a token that expired 10s ago, and accepts one that expired 1s ago", async () => {
    await expectRefused(401, "TOKEN_EXPIRED", BODY, forge({ expIn: -10 }));

    // Inside the 2s clock tolerance.
    await earlyInTheSecond();
    app.calls.length = 0;
    const reply = await counting("accepted", () =>
      app.reserve(BODY, { admission: forge({ expIn: -1 }) }),
    );
    expect(reply.status).toBe(201);
    expect(app.calls).toEqual(["reserve evt-a alice 1"]);
  });

  it("7. refuses bob's token when the caller is alice", async () => {
    const token = await mintAdmissionToken({ userId: "bob", eventId: "evt-a" });
    await expectRefused(403, "TOKEN_MISMATCH", BODY, token);
  });

  it("8. refuses a token for event A on a reserve for event B", async () => {
    const token = await mintAdmissionToken({ userId: "alice", eventId: "evt-a" });
    await expectRefused(403, "TOKEN_MISMATCH", { ...BODY, eventId: "evt-b" }, token);
  });

  it("9. refuses a token with the wrong audience or issuer", async () => {
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ aud: "session" }));
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ iss: "someone-else" }));
    // Alice's own session is not an admission either.
    await expectRefused(401, "TOKEN_INVALID", BODY, await mintSessionToken("alice"));
  });

  it("refuses a malformed token, and one missing exp, sub or eid", async () => {
    await expectRefused(401, "TOKEN_INVALID", BODY, "not-a-jwt");
    await expectRefused(401, "TOKEN_INVALID", BODY, "a.b.c");
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ expIn: null }));
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ sub: null }));
    await expectRefused(401, "TOKEN_INVALID", BODY, forge({ eid: null }));
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
  it("11. reserves without an admission token, and counts nothing", async () => {
    const app = await start(admissionNotRequired);
    try {
      const reply = await counting("nothing", () => app.reserve(BODY));
      expect(reply.status).toBe(201);
      expect(app.calls).toEqual(["reserve evt-a alice 1"]);

      // The flag turns off the waiting room, not the login.
      const anonymous = await app.reserve(BODY, { as: null });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toMatchObject({ code: "UNAUTHENTICATED" });
    } finally {
      await app.close();
    }
  });
});

describe("createApp", () => {
  it("will not mount /redis/reserve without both checks", () => {
    const { script, pool } = recorder();
    const options = { reserveScript: script, redisPool: pool };
    const authenticate = requireSession(TEST_SESSION_SECRET);
    expect(() => createApp(logger, undefined, options)).toThrow(/are required to mount/);
    expect(() => createApp(logger, undefined, { ...options, authenticate })).toThrow(
      /are required to mount/,
    );
    expect(() =>
      createApp(logger, undefined, { ...options, requireAdmission: admissionNotRequired }),
    ).toThrow(/are required to mount/);
  });
});
