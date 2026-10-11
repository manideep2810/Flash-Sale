import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { requireAdmin } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { Router } from "express";
import { describe, expect, it } from "vitest";
import { createPriceReader } from "../src/redis/index.js";
import { createAdminAuthRouter, createAuthRouter } from "../src/routes/auth.js";
import { createApp } from "../src/server.js";

// The admin login and what it opens, with no database: the routers here need none.

const SECRET = "test-only-session-secret-0123456789abcdef";
const PASSWORD = "correct-horse-battery";
const logger = createLogger({ service: "order", level: "error" });

async function withApi(
  run: (url: string) => Promise<void>,
  // Null for "no password configured" (undefined would only select the default).
  password: string | null = PASSWORD,
): Promise<void> {
  // Mounted the way src/api.ts mounts them: both logins open, everything under /admin for admins.
  const routes = Router();
  routes.use(createAuthRouter({ secret: SECRET }));
  routes.use(createAdminAuthRouter({ secret: SECRET, password: password ?? undefined }));
  routes.use("/admin", requireAdmin(SECRET));
  routes.get("/admin/orders/metrics", (_req, res) => {
    res.json({ rows: [] });
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

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const metrics = (url: string, token?: string) =>
  fetch(`${url}/admin/orders/metrics`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("POST /auth/admin-login", () => {
  it("issues an admin session for the right password, and it opens the admin routes", async () => {
    await withApi(async (url) => {
      const res = await post(url, "/auth/admin-login", { password: PASSWORD });
      expect(res.status).toBe(200);
      const session = (await res.json()) as { token: string; expiresAt: string; role: string };
      expect(session.role).toBe("admin");
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());

      expect((await metrics(url, session.token)).status).toBe(200);
    });
  });

  it("refuses a wrong, missing or non-string password, all the same way", async () => {
    await withApi(async (url) => {
      for (const body of [
        { password: "nope" },
        { password: `${PASSWORD}x` },
        {},
        { password: 7 },
      ]) {
        const res = await post(url, "/auth/admin-login", body);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
          code: "INVALID_CREDENTIALS",
          message: "wrong password",
        });
      }
    });
  });

  it("lets nobody in when no password is configured", async () => {
    await withApi(async (url) => {
      for (const body of [{ password: "" }, { password: "undefined" }, {}]) {
        const res = await post(url, "/auth/admin-login", body);
        expect(res.status).toBe(503);
        expect(((await res.json()) as { code: string }).code).toBe("ADMIN_LOGIN_OFF");
      }
    }, null);
  });

  it("does not make an admin of a customer who logs in as 'admin'", async () => {
    await withApi(async (url) => {
      const res = await post(url, "/auth/dev-login", { userId: "admin" });
      const { token } = (await res.json()) as { token: string };

      const refused = await metrics(url, token);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("FORBIDDEN");
      // And no session at all is a 401, as on every other route.
      expect((await metrics(url)).status).toBe(401);
    });
  });
});

describe("createPriceReader", () => {
  const reader = (stored: string | null) => {
    const asked: string[][] = [];
    const read = createPriceReader({
      hget: async (key: string, field: string) => {
        asked.push([key, field]);
        return stored;
      },
    } as Parameters<typeof createPriceReader>[0]);
    return { read, asked };
  };

  it("reads the price from the event's config hash", async () => {
    const { read, asked } = reader("149900");
    expect(await read("aurora")).toBe(149_900);
    expect(asked).toEqual([["ev:aurora:config", "price"]]);
  });

  it("answers null for an event with no usable price", async () => {
    for (const stored of [null, "", "0", "-5", "12.5", "free"]) {
      expect(await reader(stored).read("aurora")).toBeNull();
    }
  });
});
