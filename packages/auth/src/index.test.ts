import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE,
  createCallerVerifier,
  createSessionVerifier,
  getCallerId,
  requireAdmin,
  requireSession,
  SESSION_TTL_SEC,
  signSession,
} from "./index.js";

const SECRET = "test-only-session-secret-0123456789abcdef";
const key = (secret: string) => new TextEncoder().encode(secret);

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Signs by hand, so a test controls every part of the token. */
function forge({
  sub = "alice" as string | null,
  aud = "session",
  iss = "order-api",
  expIn = 3600 as number | null,
  alg = "HS256" as "HS256" | "HS512" | "none",
  secret = SECRET,
} = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...(sub === null ? {} : { sub }),
    aud,
    iss,
    iat: now,
    ...(expIn === null ? {} : { exp: now + expIn }),
  };
  const input = `${b64url({ alg, typ: "JWT" })}.${b64url(claims)}`;
  if (alg === "none") {
    return `${input}.`;
  }
  const digest = alg === "HS512" ? "sha512" : "sha256";
  return `${input}.${createHmac(digest, secret).update(input).digest("base64url")}`;
}

describe("signSession", () => {
  it("issues a 12-hour HS256 session for the user", async () => {
    const now = Date.now();
    const { token, expiresAt } = await signSession(SECRET, "alice", now);
    const { payload, protectedHeader } = await jwtVerify(token, key(SECRET), {
      audience: "session",
      issuer: "order-api",
    });
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("alice");
    expect(payload.exp).toBe(Math.floor(now / 1000) + SESSION_TTL_SEC);
    expect(SESSION_TTL_SEC).toBe(43_200);
    expect(expiresAt).toBe(new Date(Number(payload.exp) * 1000).toISOString());
  });

  it("refuses a secret under 32 bytes", async () => {
    await expect(signSession("x".repeat(31), "alice")).rejects.toThrow(/32 bytes/);
    expect(() => createSessionVerifier("x".repeat(31))).toThrow(/32 bytes/);
  });
});

describe("createSessionVerifier", () => {
  const verify = createSessionVerifier(SECRET);
  const bearer = (token: string) => `Bearer ${token}`;

  it("returns the user of a session it signed", async () => {
    const { token } = await signSession(SECRET, "alice");
    expect(await verify(bearer(token))).toBe("alice");
    expect(await verify(`bearer ${token}`)).toBe("alice");
  });

  it("answers UNAUTHENTICATED without a usable Authorization header", async () => {
    const { token } = await signSession(SECRET, "alice");
    for (const header of [undefined, "", "Bearer", "Bearer ", token, `Basic ${token}`]) {
      await expect(verify(header)).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    }
  });

  it("answers UNAUTHENTICATED for a token that is forged, malformed or not a session", async () => {
    const bad = [
      forge({ secret: "another-secret-another-secret-another-secret" }),
      forge({ alg: "none" }),
      forge({ alg: "HS512" }),
      forge({ aud: "reserve" }),
      forge({ iss: "queue-svc" }),
      // An admission token: right secret family or not, it is for "reserve" and from queue-svc.
      forge({ aud: "reserve", iss: "queue-svc" }),
      forge({ sub: null }),
      forge({ expIn: null }),
      "not-a-jwt",
    ];
    for (const token of bad) {
      await expect(verify(bearer(token))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("answers SESSION_EXPIRED for a session past its expiry", async () => {
    await expect(verify(bearer(forge({ expIn: -10 })))).rejects.toMatchObject({
      status: 401,
      code: "SESSION_EXPIRED",
    });
  });
});

describe("requireSession", () => {
  function run(authorization: string | undefined, extra: Record<string, string> = {}) {
    const headers: Record<string, string | undefined> = { authorization, ...extra };
    const req = { get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
    const reply: { status?: number; body?: unknown; passed: boolean } = { passed: false };
    const res = {
      status(code: number) {
        reply.status = code;
        return this;
      },
      json(body: unknown) {
        reply.body = body;
        return this;
      },
    } as unknown as Response;
    const done = Promise.resolve(
      requireSession(SECRET)(req, res, () => {
        reply.passed = true;
      }),
    );
    return done.then(() => ({ req, reply }));
  }

  it("passes a valid session on and remembers the caller", async () => {
    const { token } = await signSession(SECRET, "alice");
    const { req, reply } = await run(`Bearer ${token}`);
    expect(reply).toEqual({ passed: true });
    expect(getCallerId(req)).toBe("alice");
  });

  it("answers 401 {code, message} and stops", async () => {
    const missing = await run(undefined);
    expect(missing.reply).toEqual({
      passed: false,
      status: 401,
      body: { code: "UNAUTHENTICATED", message: expect.any(String) },
    });

    const expired = await run(`Bearer ${forge({ expIn: -10 })}`);
    expect(expired.reply).toMatchObject({ status: 401, body: { code: "SESSION_EXPIRED" } });
    expect(() => getCallerId(expired.req)).toThrow(/behind requireSession/);
  });

  it("takes the caller from the session, whatever identity headers the client adds", async () => {
    const { token } = await signSession(SECRET, "alice");
    const { req } = await run(`Bearer ${token}`, { "x-user-id": "bob", "x-dev-user": "bob" });
    expect(getCallerId(req)).toBe("alice");

    const headersOnly = await run(undefined, { "x-user-id": "bob", "x-dev-user": "bob" });
    expect(headersOnly.reply).toMatchObject({ passed: false, status: 401 });
  });
});

describe("the admin role", () => {
  it("is a claim in the signed session, and only when asked for", async () => {
    const verify = createCallerVerifier(SECRET);
    const admin = await signSession(SECRET, "admin", Date.now(), ADMIN_ROLE);
    expect(await verify(`Bearer ${admin.token}`)).toEqual({ userId: "admin", role: "admin" });

    // A customer who picked the name "admin" has the name and nothing else.
    const customer = await signSession(SECRET, "admin");
    expect(await verify(`Bearer ${customer.token}`)).toEqual({ userId: "admin" });
  });

  /** Runs requireAdmin on a request with this Authorization header. */
  async function run(authorization: string | undefined) {
    const reply: { passed: boolean; status?: number; body?: unknown } = { passed: false };
    const req = {
      get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
    } as unknown as Request;
    const res = {
      status(code: number) {
        reply.status = code;
        return this;
      },
      json(body: unknown) {
        reply.body = body;
        return this;
      },
    } as unknown as Response;
    await requireAdmin(SECRET)(req, res, () => {
      reply.passed = true;
    });
    return { req, reply };
  }

  it("requireAdmin passes an admin session on", async () => {
    const { token } = await signSession(SECRET, "admin", Date.now(), ADMIN_ROLE);
    const { req, reply } = await run(`Bearer ${token}`);
    expect(reply).toEqual({ passed: true });
    expect(getCallerId(req)).toBe("admin");
  });

  it("requireAdmin answers 403 FORBIDDEN to a customer, and 401 to nobody at all", async () => {
    const { token } = await signSession(SECRET, "admin");
    const customer = await run(`Bearer ${token}`);
    expect(customer.reply).toEqual({
      passed: false,
      status: 403,
      body: { code: "FORBIDDEN", message: expect.any(String) },
    });

    const anonymous = await run(undefined);
    expect(anonymous.reply).toMatchObject({ passed: false, status: 401 });
  });

  it("does not take the role from a token signed with another key", async () => {
    const elsewhere = await signSession(`${SECRET}-other`, "admin", Date.now(), ADMIN_ROLE);
    const { reply } = await run(`Bearer ${elsewhere.token}`);
    expect(reply).toMatchObject({ passed: false, status: 401 });
  });
});
