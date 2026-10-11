import { createHash, timingSafeEqual } from "node:crypto";
import { ADMIN_ROLE, signSession } from "@flash/auth";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

const loginBody = z.object({
  userId: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/),
});

export interface AuthRouterOptions {
  /** SESSION_SECRET: what every service verifies a session with. */
  secret: string;
}

/**
 * POST /auth/dev-login  {userId} -> 200 {token, expiresAt} | 400 {code: "BAD_REQUEST"}
 *
 * DEV ONLY. There is no password: anyone who can reach this gets a 12-hour session for any userId
 * they name. (The login screen has a password field; what is typed there is never sent.) It exists
 * so the rest of the system can require a real, signed identity before a real login does; api.ts
 * does not mount it in production.
 */
export function createAuthRouter({ secret }: AuthRouterOptions): Router {
  const router = Router();

  router.post("/auth/dev-login", async (req: Request, res: Response) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "BAD_REQUEST",
        message: "userId must be 3 to 64 characters from a-z, A-Z, 0-9, _ and -",
      });
      return;
    }
    res.json(await signSession(secret, parsed.data.userId));
  });

  return router;
}

/** Compares in constant time, whatever the lengths: both sides are hashed first. */
function samePassword(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export interface AdminAuthRouterOptions {
  /** SESSION_SECRET. An admin session is an ordinary session with a role claim. */
  secret: string;
  /** ADMIN_PASSWORD: the one fixed password. Without one, nobody can log in as admin. */
  password: string | undefined;
}

/**
 * POST /auth/admin-login  {password} -> 200 {token, expiresAt, role: "admin"}
 *                                     | 401 {code: "INVALID_CREDENTIALS"}
 *                                     | 503 {code: "ADMIN_LOGIN_OFF"} when no password is configured
 *
 * One fixed password, from ADMIN_PASSWORD. The session it issues is for the user "admin" and carries
 * role "admin", which is what requireAdmin() checks; logging in as a customer called "admin" through
 * the other login carries no role and opens nothing.
 */
export function createAdminAuthRouter({ secret, password }: AdminAuthRouterOptions): Router {
  const router = Router();

  router.post("/auth/admin-login", async (req: Request, res: Response) => {
    if (password === undefined) {
      res.status(503).json({
        code: "ADMIN_LOGIN_OFF",
        message: "the admin login is off: set ADMIN_PASSWORD for the order service",
      });
      return;
    }
    const given = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof given !== "string" || !samePassword(given, password)) {
      res.status(401).json({ code: "INVALID_CREDENTIALS", message: "wrong password" });
      return;
    }
    const session = await signSession(secret, "admin", Date.now(), ADMIN_ROLE);
    res.json({ ...session, role: ADMIN_ROLE });
  });

  return router;
}
