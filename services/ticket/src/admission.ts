import type { Logger } from "@flash/observability";
import { errors, type JWTPayload, jwtVerify } from "jose";
import { Counter } from "prom-client";

/** The header the client sends its admission token in. */
export const ADMISSION_HEADER = "x-admission-token";

// What queue-svc mints (createTokenMinter in services/queue/src/queue/token.ts): HS256 under
// ADMISSION_SECRET, sub = userId, eid = eventId. These have to be kept in step with it by hand.
const AUDIENCE = "reserve";
const ISSUER = "queue-svc";
const ALGORITHM = "HS256";
/** Seconds of clock difference allowed between whoever stamped the token and this host. */
const CLOCK_TOLERANCE_SEC = 2;
const MIN_SECRET_BYTES = 32;

const REJECTIONS = {
  ADMISSION_REQUIRED: { status: 401, message: "an admission token is required: join the queue" },
  TOKEN_EXPIRED: { status: 401, message: "the admission token has expired" },
  TOKEN_INVALID: { status: 401, message: "the admission token is not valid" },
  TOKEN_MISMATCH: {
    status: 403,
    message: "the admission token was issued for a different user or event",
  },
} as const;

export type RejectionReason = keyof typeof REJECTIONS;
export const REJECTION_REASONS = Object.keys(REJECTIONS) as RejectionReason[];

/** Why a request was refused. The message is fixed text per reason and never contains the token. */
export class AdmissionError extends Error {
  readonly status: 401 | 403;

  constructor(readonly code: RejectionReason) {
    super(REJECTIONS[code].message);
    this.name = "AdmissionError";
    this.status = REJECTIONS[code].status;
  }
}

// Both register on prom-client's default registry. In the clustered ticket service that is each
// worker's registry, which the primary sums across workers on METRICS_PORT (src/metrics.ts).

export const admissionRejected = new Counter({
  name: "admission_rejected_total",
  help: "Reserve requests refused by the admission check, by reason.",
  labelNames: ["reason"],
});
// A labelled series only exists once it has been touched; start all four at 0 so a rate() over them
// has a first sample to work from.
for (const reason of REJECTION_REASONS) {
  admissionRejected.inc({ reason }, 0);
}

export const admissionAccepted = new Counter({
  name: "admission_accepted_total",
  help: "Reserve requests that passed the admission check.",
});

/** Resolves when the caller may reserve; rejects with an AdmissionError when they may not. */
export type RequireAdmission = (
  token: string | undefined,
  callerId: string,
  eventId: string,
) => Promise<void>;

export interface AdmissionOptions {
  /** ADMISSION_SECRET: the value queue-svc signs with. */
  secret: string;
  logger: Logger;
}

/**
 * Builds requireAdmission(token, callerId, eventId), the check POST /redis/reserve runs before
 * anything else. The secret is encoded once, here, at startup.
 *
 * In order:
 *   1. no token                                         401 ADMISSION_REQUIRED
 *   2. the token does not verify                        401 TOKEN_EXPIRED when it is only out of date,
 *                                                       401 TOKEN_INVALID for everything else
 *   3. it verifies but is for another user or event     403 TOKEN_MISMATCH
 *
 * The algorithm is pinned to HS256, so a token that names `none`, or any other algorithm, fails step 2
 * whatever it is signed with. exp, sub and eid must all be present: a token without an expiry would
 * otherwise never expire, and one without sub or eid is malformed rather than somebody else's.
 */
export function createRequireAdmission({ secret, logger }: AdmissionOptions): RequireAdmission {
  const key = new TextEncoder().encode(secret);
  if (key.byteLength < MIN_SECRET_BYTES) {
    throw new Error(`ADMISSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }

  // `detail` is jose's error code (ERR_JWS_SIGNATURE_VERIFICATION_FAILED, ...), never the token.
  function rejection(reason: RejectionReason, callerId: string, detail?: string): AdmissionError {
    admissionRejected.inc({ reason });
    logger.debug("admission rejected", { reason, callerId, ...(detail ? { detail } : {}) });
    return new AdmissionError(reason);
  }

  return async (token, callerId, eventId) => {
    if (!token?.trim()) {
      throw rejection("ADMISSION_REQUIRED", callerId);
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: [ALGORITHM],
        audience: AUDIENCE,
        issuer: ISSUER,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        requiredClaims: ["exp", "sub", "eid"],
      }));
    } catch (error) {
      const reason = error instanceof errors.JWTExpired ? "TOKEN_EXPIRED" : "TOKEN_INVALID";
      throw rejection(reason, callerId, (error as { code?: string }).code);
    }

    if (payload.sub !== callerId || payload.eid !== eventId) {
      throw rejection("TOKEN_MISMATCH", callerId);
    }
    admissionAccepted.inc();
  };
}

/**
 * REQUIRE_ADMISSION=false: every request is let through unchecked and nothing is counted. For
 * raw-capacity benchmarks; the service refuses to start this way in production (src/config.ts).
 */
export const admissionNotRequired: RequireAdmission = async () => {};
