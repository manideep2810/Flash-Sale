// The one module that talks to the backend. Every call is made by the browser against a relative
// /api/... URL on the page's own origin (the gateway), with the session token attached. Nothing here
// runs on the server.

import { sentenceFor } from "./messages";

/**
 * A call that did not succeed, in one shape whatever answered: the gateway and the auth checks send
 * {code, message}, the order and stock errors send {error}, and a dropped connection sends nothing.
 * `message` is always our own sentence for the code (lib/messages.ts), never the server's text.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** From a Retry-After header, in milliseconds. */
    readonly retryAfterMs: number | null = null,
    /** The parsed error body, for the few fields a page needs (NOT_OPEN's lobbyOpensAt). */
    readonly body: Record<string, unknown> = {},
  ) {
    super(sentenceFor(code, status));
    this.name = "ApiFailure";
  }

  /** The server could not be reached, or the gateway could not reach the service behind it. */
  get unavailable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }

  get unauthenticated(): boolean {
    return (
      this.status === 401 && (this.code === "UNAUTHENTICATED" || this.code === "SESSION_EXPIRED")
    );
  }
}

export function toFailure(error: unknown): ApiFailure {
  return error instanceof ApiFailure ? error : new ApiFailure(0, "NETWORK");
}

// ---- the session, supplied by lib/session.tsx ---------------------------------------------------

let getSessionToken: () => string | null = () => null;
let onSessionRejected: () => void = () => {};

export function configureApi(hooks: {
  getSessionToken: () => string | null;
  /** Called when a call is refused for want of a valid session. */
  onSessionRejected: () => void;
}): void {
  getSessionToken = hooks.getSessionToken;
  onSessionRejected = hooks.onSessionRejected;
}

interface CallOptions {
  body?: unknown;
  /** The admission token, for reserve. */
  admission?: string;
  /**
   * Leave a 401 to the caller. Reserve needs this: through the gateway an expired turn and an expired
   * session are the same 401, and only the caller can find out which it was.
   */
  ownsAuthFailure?: boolean;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  options: CallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const session = getSessionToken();
  if (session) {
    headers.authorization = `Bearer ${session}`;
  }
  if (options.admission) {
    headers["x-admission-token"] = options.admission;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiFailure(0, "NETWORK");
  }

  let data: Record<string, unknown> = {};
  let isJson = true;
  try {
    const text = await res.text();
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON (an HTML error page, say): the status is all there is.
    isJson = false;
  }
  if (res.ok) {
    return data as T;
  }

  const code =
    typeof data.code === "string"
      ? data.code
      : typeof data.error === "string"
        ? data.error
        : res.status === 404 && !isJson
          ? // Behind the gateway every /api path answers in JSON, a 404 included. A 404 that is a web
            // page came from the web app itself: the page was opened on its own port, not the gateway's.
            "NOT_BEHIND_GATEWAY"
          : `HTTP_${res.status}`;
  const retryAfterSec = Number(res.headers.get("retry-after"));
  const failure = new ApiFailure(
    res.status,
    code,
    Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : null,
    data,
  );
  if (failure.unauthenticated && !options.ownsAuthFailure) {
    onSessionRejected();
  }
  throw failure;
}

// ---- the endpoints -------------------------------------------------------------------------------

export interface Session {
  token: string;
  /** ISO time. */
  expiresAt: string;
}

/** POST /api/auth/dev-login. Dev only: no password. */
export function devLogin(userId: string): Promise<Session> {
  return call("POST", "/api/auth/dev-login", { body: { userId } });
}

export interface EventInfo {
  eventId: string;
  name: string;
  /** In the smallest currency unit, or null when the event has none. Display only. */
  price: number | null;
  /** Epoch ms. */
  lobbyOpensAt: number;
  /** Epoch ms. */
  saleOpensAt: number;
  admitRatePerSec: number;
  state: "OPEN" | "PAUSED" | "SOLD_OUT";
}

/** GET /api/queue/:eventId/info */
export function getEventInfo(eventId: string): Promise<EventInfo> {
  return call("GET", `/api/queue/${encodeURIComponent(eventId)}/info`);
}

export interface Queued {
  status: "QUEUED";
  /** Only on status replies. */
  state?: "OPEN" | "PAUSED";
  position: number;
  peopleAhead: number;
  /** Null in the lobby, where the order is not final. */
  estWaitSec: number | null;
  /** How long to wait before asking again. */
  retryAfterMs: number;
  phase: "LOBBY" | "OPEN";
}

export type JoinReply = Queued | { status: "ADMITTED" } | { status: "SOLD_OUT" };

/** POST /api/queue/:eventId/join. Safe to repeat: a queued user keeps their place. */
export function joinQueue(eventId: string): Promise<JoinReply> {
  return call("POST", `/api/queue/${encodeURIComponent(eventId)}/join`);
}

export interface Admitted {
  status: "ADMITTED";
  /** The admission token. Kept in memory only (lib/admission.tsx). */
  token: string;
  /** ISO time the turn ends. */
  expiresAt: string;
}

export type StatusReply =
  | Queued
  | Admitted
  | { status: "EXPIRED" }
  | { status: "SOLD_OUT" }
  | { status: "NOT_IN_QUEUE" };

/** GET /api/queue/:eventId/status */
export function getQueueStatus(eventId: string): Promise<StatusReply> {
  return call("GET", `/api/queue/${encodeURIComponent(eventId)}/status`);
}

/**
 * POST /api/reserve. There is no way to call this without an admission token: the parameter is
 * required and an empty one is refused here, before any request is made.
 */
export function reserve(
  eventId: string,
  qty: number,
  admissionToken: string,
): Promise<{ holdId: string }> {
  if (!admissionToken) {
    return Promise.reject(new ApiFailure(401, "ADMISSION_REQUIRED"));
  }
  return call("POST", "/api/reserve", {
    body: { eventId, qty },
    admission: admissionToken,
    ownsAuthFailure: true,
  });
}

export interface Order {
  id: string;
  state: string;
  /** ISO time the hold ends. */
  expiresAt: string;
  updatedAt: string;
}

/** GET /api/orders/:orderId. 404 NOT_FOUND until the order has been created from the reservation. */
export function getOrder(orderId: string): Promise<Order> {
  return call("GET", `/api/orders/${encodeURIComponent(orderId)}`);
}

/** POST /api/orders/:orderId/pay. 202 or 200 with the order's state. */
export function payOrder(orderId: string): Promise<{ state: string }> {
  return call("POST", `/api/orders/${encodeURIComponent(orderId)}/pay`);
}

/** Order states after which nothing more happens to a payment. */
export const SETTLED_STATES = [
  "PAID",
  "CONFIRMED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "RELEASED",
  "REFUNDED",
];
