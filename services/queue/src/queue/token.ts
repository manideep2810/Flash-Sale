import { SignJWT } from "jose";

export const TOKEN_ISSUER = "queue-svc";
export const TOKEN_AUDIENCE = "reserve";
const ALGORITHM = "HS256";

export interface AdmissionToken {
  token: string;
  /** ISO time the turn ends; the token's `exp` is the same instant in whole seconds. */
  expiresAt: string;
}

export type MintToken = (admission: {
  userId: string;
  eventId: string;
  /** Epoch ms, as admit.lua stamped it. */
  admittedAt: number;
  admitTtlSec: number;
}) => Promise<AdmissionToken>;

/**
 * Mints the admission JWT: sub = userId, eid = eventId, aud = "reserve", iss = "queue-svc".
 *
 * Every claim is derived from admittedAt, never from the clock, so the token is not stored anywhere:
 * each ADMITTED status call computes it again and gets the same lifetime (iat = admittedAt, exp =
 * admittedAt + ttl). Asking again cannot extend a turn.
 */
export function createTokenMinter(secret: string): MintToken {
  const key = new TextEncoder().encode(secret);
  return async ({ userId, eventId, admittedAt, admitTtlSec }) => {
    const expiresAtMs = admittedAt + admitTtlSec * 1000;
    const token = await new SignJWT({ eid: eventId })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(userId)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuer(TOKEN_ISSUER)
      .setIssuedAt(Math.floor(admittedAt / 1000))
      .setExpirationTime(Math.floor(expiresAtMs / 1000))
      .sign(key);
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  };
}
