import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createSessionVerifier, requireSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { Router } from "express";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createAuthRouter } from "../src/routes/auth.js";
import { createApp } from "../src/server.js";

// The dev login and the session it issues, with no database: the routers here need none.

const SECRET = "test-only-session-secret-0123456789abcdef";
const logger = createLogger({ service: "order", level: "error" });

async function withApi(run: (url: string) => Promise<void>): Promise<void> {
  // Mounted the way src/api.ts mounts them: login open, everything under /orders behind a session.
  const routes = Router();
  routes.use(createAuthRouter({ secret: SECRET }));
  routes.use("/orders", requireSession(SECRET));
  routes.get("/orders/:id", (req, res) => {
    res.json({ id: req.params.id });
  });

  const server = createApp(logger, undefined, routes).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
}

const login = (url: string, body: unknown) =>
  fetch(`${url}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /auth/dev-login", () => {
  it("issues a 12-hour session for the user it is given", async () => {
    await withApi(async (url) => {
      const before = Math.floor(Date.now() / 1000);
      const res = await login(url, { userId: "alice_01" });
      expect(res.status).toBe(200);
      const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };

      const { payload, protectedHeader } = await jwtVerify(
        token,
        new TextEncoder().encode(SECRET),
        {
          algorithms: ["HS256"],
          audience: "session",
          issuer: "order-api",
        },
      );
      expect(protectedHeader.alg).toBe("HS256");
      expect(payload.sub).toBe("alice_01");
      expect(Number(payload.exp) - before).toBeGreaterThanOrEqual(12 * 3600);
      expect(Number(payload.exp) - before).toBeLessThanOrEqual(12 * 3600 + 5);
      expect(expiresAt).toBe(new Date(Number(payload.exp) * 1000).toISOString());

      // And it is what the shared check accepts.
      expect(await createSessionVerifier(SECRET)(`Bearer ${token}`)).toBe("alice_01");
    });
  });

  it("refuses a userId that is not 3 to 64 of [a-zA-Z0-9_-]", async () => {
    await withApi(async (url) => {
      const bad = ["ab", "x".repeat(65), "has space", "semi;colon", "ünïcode", "", 42, undefined];
      for (const userId of bad) {
        const res = await login(url, { userId });
        expect(res.status, `userId ${String(userId)}`).toBe(400);
        expect(await res.json()).toEqual({ code: "BAD_REQUEST", message: expect.any(String) });
      }
      expect((await login(url, { userId: "abc" })).status).toBe(200);
      expect((await login(url, { userId: "x".repeat(64) })).status).toBe(200);
    });
  });
});

describe("order routes behind the session", () => {
  it("answers 401 without a session and serves the request with one", async () => {
    await withApi(async (url) => {
      const anonymous = await fetch(`${url}/orders/o-1`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "UNAUTHENTICATED" });

      const { token } = (await (await login(url, { userId: "alice" })).json()) as { token: string };
      const mine = await fetch(`${url}/orders/o-1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(mine.status).toBe(200);
      expect(await mine.json()).toEqual({ id: "o-1" });
    });
  });
});
