// Mints the admission token POST /redis/reserve demands, for tests and tools that reserve directly
// instead of going through the waiting room. Same claims as queue-svc (createTokenMinter in
// services/queue/src/queue/token.ts): HS256, sub = userId, eid = eventId, aud = "reserve",
// iss = "queue-svc", iat = now, exp = now + ttl.

import { SignJWT } from "jose";

/**
 * The secret the tokens are signed with. The e2e harnesses hand this same value to the ticket service
 * they start, so the two always agree. Against services started by `make dev` it has to match
 * ADMISSION_SECRET in services/ticket/.env: the default is the .env.example value, and setting
 * ADMISSION_SECRET in the environment overrides it.
 */
export const TEST_ADMISSION_SECRET =
  process.env.ADMISSION_SECRET ?? "local-dev-only-admission-secret-0123456789abcdef";

/** The header the ticket service reads the token from. */
export const ADMISSION_HEADER = "x-admission-token";

const key = new TextEncoder().encode(TEST_ADMISSION_SECRET);

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
    .sign(key);
}
