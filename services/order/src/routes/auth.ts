import { signSession } from "@flash/auth";
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
 * they name. It exists so the rest of the system can require a real, signed identity before a real
 * login does; api.ts does not mount it in production.
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
