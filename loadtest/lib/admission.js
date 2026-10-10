// Admission tokens for the k6 scripts that call POST /redis/reserve.
//
// The ticket service refuses a reserve without a valid token from the waiting room. A load run that
// starts after the waiting room mints its own instead, with the same claims as queue-svc
// (services/queue/src/queue/token.ts): HS256, sub = userId, eid = eventId, aud = "reserve",
// iss = "queue-svc", iat = now, exp = now + ttl.
//
// A token is bound to one user and one event, and these scripts use a new user id on every iteration,
// so it is minted per request rather than once in setup(). That is one HMAC-SHA256, done in k6's Go
// runtime.
//
// ADMISSION_SECRET has to be the ticket service's. The default is the value in the services'
// .env.example files; tests/e2e/phase4/run-load.ts passes the one it started the service with.

import crypto from "k6/crypto";
import encoding from "k6/encoding";

const SECRET = __ENV.ADMISSION_SECRET || "local-dev-only-admission-secret-0123456789abcdef";

/** The header the ticket service reads the token from. */
export const ADMISSION_HEADER = "X-Admission-Token";

const b64url = (text) => encoding.b64encode(text, "rawurl");
const JWT_HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export function mintAdmissionToken(userId, eventId, ttlSec = 120) {
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(
    JSON.stringify({
      sub: userId,
      eid: eventId,
      aud: "reserve",
      iss: "queue-svc",
      iat: now,
      exp: now + ttlSec,
    }),
  );
  const signature = crypto.hmac("sha256", SECRET, `${JWT_HEADER}.${claims}`, "base64rawurl");
  return `${JWT_HEADER}.${claims}.${signature}`;
}
