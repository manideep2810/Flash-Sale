// Mints the two tokens a caller needs, for tests and tools that talk to the services directly
// instead of logging in and waiting in the queue:
//
//   mintSessionToken(userId)             who the caller is. What order-api's dev login issues
//                                        (signSession in packages/auth): HS256, sub = userId,
//                                        aud = "session", iss = "order-api", exp = now + 12h.
//   mintAdmissionToken({userId, eventId}) that the waiting room let them in. What queue-svc issues
//                                        (services/queue/src/queue/token.ts): HS256, sub = userId,
//                                        eid = eventId, aud = "reserve", iss = "queue-svc".

import { SignJWT } from "jose";

/**
 * The secrets the tokens are signed with. The e2e harnesses hand these same values to the services
 * (and the gateway) they start, so the two sides always agree. Against services started by `make dev`
 * they have to match SESSION_SECRET and ADMISSION_SECRET in the services' .env files: the defaults are
 * the .env.example values, and setting the variables in the environment overrides them.
 */
export const TEST_SESSION_SECRET =
  process.env.SESSION_SECRET ?? "local-dev-only-session-secret-0123456789abcdef0";
export const TEST_ADMISSION_SECRET =
  process.env.ADMISSION_SECRET ?? "local-dev-only-admission-secret-0123456789abcdef";

/** The header the ticket service reads the admission token from. */
export const ADMISSION_HEADER = "x-admission-token";

const key = (secret: string) => new TextEncoder().encode(secret);
const sessionKey = key(TEST_SESSION_SECRET);
const admissionKey = key(TEST_ADMISSION_SECRET);

export async function mintSessionToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("session")
    .setIssuer("order-api")
    .setIssuedAt(now)
    .setExpirationTime(now + 12 * 60 * 60)
    .sign(sessionKey);
}

/** `Authorization` header value for `userId`'s session. */
export async function bearer(userId: string): Promise<string> {
  return `Bearer ${await mintSessionToken(userId)}`;
}

export async function mintAdmissionToken({
  userId,
  eventId,
  ttlSec = 120,
}: {
  userId: string;
  eventId: string;
  ttlSec?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ eid: eventId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("reserve")
    .setIssuer("queue-svc")
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(admissionKey);
}

/** Both headers a reserve needs: the caller's session and their admission to `eventId`. */
export async function reserveHeaders(
  userId: string,
  eventId: string,
): Promise<Record<string, string>> {
  return {
    authorization: await bearer(userId),
    [ADMISSION_HEADER]: await mintAdmissionToken({ userId, eventId }),
  };
}
