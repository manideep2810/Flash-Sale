import type { RequestHandler, Response } from "express";

// TODO(item 4): replace with session JWT from dev-login

/**
 * TEMPORARY caller identity: the userId is whatever the X-Dev-User header says. Nothing checks it, so
 * it is honoured only when NODE_ENV is development or test; in any other environment every request
 * is 401, header or not.
 */
export function devUser(nodeEnv: string): RequestHandler {
  const trusted = nodeEnv === "development" || nodeEnv === "test";
  return (req, res, next) => {
    const userId = trusted ? req.get("x-dev-user")?.trim() : undefined;
    if (!userId) {
      res.status(401).json({ code: "UNAUTHENTICATED", message: "no caller identity" });
      return;
    }
    res.locals.userId = userId;
    next();
  };
}

/** The userId devUser() put on the response. Only valid on routes mounted behind it. */
export function userIdOf(res: Response): string {
  return res.locals.userId as string;
}
