import type { Request, RequestHandler } from "express";
import { errors, jwtVerify, SignJWT } from "jose";

// The session: who the caller is. order-api's dev login signs it; every service that takes requests
// from users verifies it for itself with requireSession(), whether or not a gateway already has.

export const SESSION_ISSUER = "order-api";
export const SESSION_AUDIENCE = "session";
/** Twelve hours. */
export const SESSION_TTL_SEC = 12 * 60 * 60;

const ALGORITHM = "HS256";
/** Seconds of clock difference allowed between whoever signed the token and this host. */
const CLOCK_TOLERANCE_SEC = 2;
const MIN_SECRET_BYTES = 32;

const REJECTIONS = {
  UNAUTHENTICATED: "a valid session is required: log in first",
  SESSION_EXPIRED: "the session has expired: log in again",
} as const;

export type SessionRejection = keyof typeof REJECTIONS;

/** Why a request has no caller. Always a 401; the message is fixed text and never holds the token. */
export class SessionError extends Error {
  readonly status = 401;

  constructor(readonly code: SessionRejection) {
    super(REJECTIONS[code]);
    this.name = "SessionError";
  }
}

function keyOf(secret: string): Uint8Array {
  const key = new TextEncoder().encode(secret);
  if (key.byteLength < MIN_SECRET_BYTES) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return key;
}

export interface Session {
  token: string;
  /** ISO time the session ends. */
  expiresAt: string;
}

/** Signs a session for `userId`: sub = userId, aud = "session", iss = "order-api", exp = now + 12h. */
export async function signSession(
  secret: string,
  userId: string,
  now: number = Date.now(),
): Promise<Session> {
  const issuedAt = Math.floor(now / 1000);
  const expires = issuedAt + SESSION_TTL_SEC;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setAudience(SESSION_AUDIENCE)
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(keyOf(secret));
  return { token, expiresAt: new Date(expires * 1000).toISOString() };
}

/** Resolves to the session's userId, or rejects with a SessionError. */
export type VerifySession = (authorization: string | undefined) => Promise<string>;

/**
 * Verifies an `Authorization: Bearer <token>` header. The secret is encoded once, here.
 *
 * The algorithm is pinned to HS256, so a token naming `none` or anything else fails, and audience
 * and issuer are checked, so a token minted for another purpose (the admission token is signed by
 * queue-svc for "reserve") is not a session. Expired is told apart from everything else because the
 * client's remedy differs: log in again, as opposed to log in.
 */
export function createSessionVerifier(secret: string): VerifySession {
  const key = keyOf(secret);
  return async (authorization) => {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) {
      throw new SessionError("UNAUTHENTICATED");
    }
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [ALGORITHM],
        audience: SESSION_AUDIENCE,
        issuer: SESSION_ISSUER,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        requiredClaims: ["exp", "sub"],
      });
      if (!payload.sub) {
        throw new SessionError("UNAUTHENTICATED");
      }
      return payload.sub;
    } catch (error) {
      throw new SessionError(
        error instanceof errors.JWTExpired ? "SESSION_EXPIRED" : "UNAUTHENTICATED",
      );
    }
  };
}

// The verified caller of each request in flight. Keyed by the request object, so it cannot be set by
// anything a client sends, and it goes away with the request.
const callers = new WeakMap<object, string>();

/**
 * Express middleware: lets a request through only with a valid session, and remembers whose it is for
 * getCallerId(). Anything else is answered 401 {code, message}, with code UNAUTHENTICATED or
 * SESSION_EXPIRED.
 */
export function requireSession(secret: string): RequestHandler {
  const verify = createSessionVerifier(secret);
  return async (req, res, next) => {
    try {
      callers.set(req, await verify(req.get("authorization")));
    } catch (error) {
      if (error instanceof SessionError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      next(error);
      return;
    }
    next();
  };
}

/**
 * Who is calling: the userId of the session requireSession() verified. This is the only source of a
 * caller's identity. Request bodies and the gateway's x-user-id header are never one: the gateway
 * sets that header for its own rate limiting, and a service reached directly would be taking the
 * client's word for it.
 */
export function getCallerId(req: Request): string {
  const userId = callers.get(req);
  if (userId === undefined) {
    throw new Error("getCallerId() needs a route that is behind requireSession()");
  }
  return userId;
}
