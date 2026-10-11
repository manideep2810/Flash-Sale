// Tokens for the k6 scripts, which start after the login and after the waiting room and so mint
// their own, with the claims the services issue:
//
//   mintSessionToken(userId)             who the caller is. order-api's dev login (packages/auth):
//                                        HS256, sub = userId, aud = "session", iss = "order-api",
//                                        exp = now + 12h. Sent as `Authorization: Bearer <token>`.
//   mintAdmissionToken(userId, eventId)  that the waiting room let them in. queue-svc
//                                        (services/queue/src/queue/token.ts): HS256, sub = userId,
//                                        eid = eventId, aud = "reserve", iss = "queue-svc". Sent as
//                                        `X-Admission-Token`.
//
// Both are bound to one user, and these scripts use a new user id on every iteration, so they are
// minted per iteration rather than once in setup(). Each is one HMAC-SHA256, done in k6's Go runtime.
//
// SESSION_SECRET and ADMISSION_SECRET have to be the services'. The defaults are the values in the
// services' .env.example files; tests/e2e/phase4/run-load.ts passes the ones it started them with.

import crypto from "k6/crypto";
import encoding from "k6/encoding";

const SESSION_SECRET = __ENV.SESSION_SECRET || "local-dev-only-session-secret-0123456789abcdef0";
const ADMISSION_SECRET =
  __ENV.ADMISSION_SECRET || "local-dev-only-admission-secret-0123456789abcdef";

/** The header the ticket service reads the admission token from. */
export const ADMISSION_HEADER = "X-Admission-Token";

const b64url = (text) => encoding.b64encode(text, "rawurl");
const JWT_HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** Signs any claims with any secret: also for the tokens no real login would issue (bot-flood.js). */
export function sign(claims, secret) {
  const body = b64url(JSON.stringify(claims));
  const signature = crypto.hmac("sha256", secret, `${JWT_HEADER}.${body}`, "base64rawurl");
  return `${JWT_HEADER}.${body}.${signature}`;
}

export function mintSessionToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: userId, aud: "session", iss: "order-api", iat: now, exp: now + 12 * 60 * 60 },
    SESSION_SECRET,
  );
}

export function mintAdmissionToken(userId, eventId, ttlSec = 120) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: userId, eid: eventId, aud: "reserve", iss: "queue-svc", iat: now, exp: now + ttlSec },
    ADMISSION_SECRET,
  );
}

/** `Authorization` header value for `userId`'s session. */
export function bearer(userId) {
  return `Bearer ${mintSessionToken(userId)}`;
}
