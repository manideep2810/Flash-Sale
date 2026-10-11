// The one module that talks to the backend. Every call is made by the browser against a relative
// /api/... URL on the page's own origin (the gateway), with the session token attached. Nothing here
// runs on the server. (One exception, uploadCover(): the image itself goes straight to Cloudinary.)

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

// ---- the server's clock ----------------------------------------------------------------------------

/** How far this browser's clock is behind the server's, in ms, as of the last answer that said. */
let clockSkewMs = 0;

/**
 * The time by the server's clock. Every instant the pages count down to is the server's (a sale
 * opening, a turn or a hold ending), so they are compared with this and not with Date.now(): a
 * browser whose clock is a minute off still shows the right time left. It equals Date.now() until
 * an answer has carried the server's time.
 */
export function serverNow(): number {
  return Date.now() + clockSkewMs;
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
  method: "GET" | "POST" | "PUT",
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
    // The catalogue's answers say what time the server makes it.
    if (typeof data.now === "number") {
      clockSkewMs = data.now - Date.now();
    }
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

// ---- logging in ------------------------------------------------------------------------------------

export interface Session {
  token: string;
  /** ISO time. */
  expiresAt: string;
}

/**
 * POST /api/auth/dev-login. Dev only: the backend takes a user id and no password. The login screen
 * has a password field because a login screen has one; what is typed there is never sent.
 */
export function devLogin(userId: string): Promise<Session> {
  return call("POST", "/api/auth/dev-login", { body: { userId } });
}

/** POST /api/auth/admin-login: the one fixed admin password. */
export function adminLogin(password: string): Promise<Session & { role: string }> {
  return call("POST", "/api/auth/admin-login", { body: { password } });
}

// ---- the catalogue ----------------------------------------------------------------------------------

/** Where an event is in its life, as the server saw it when it answered. */
export type EventStatus = "UPCOMING" | "LOBBY" | "LIVE" | "SOLD_OUT";

export interface CatalogueEvent {
  id: string;
  name: string;
  description: string;
  /** Per ticket, in the smallest currency unit. */
  price: number;
  imageUrl: string | null;
  /** Epoch ms, by the server's clock: from here people can join the waiting room. */
  lobbyOpensAt: number;
  /** Epoch ms, by the server's clock: from here the waiting room lets people in to buy. */
  saleOpensAt: number;
  totalStock: number;
  /** Tickets nobody holds or has bought. Null when the live numbers could not be read. */
  available: number | null;
  status: EventStatus;
}

/** GET /api/events. Public: no session needed. */
export async function listEvents(): Promise<CatalogueEvent[]> {
  return (await call<{ events: CatalogueEvent[] }>("GET", "/api/events")).events;
}

/** GET /api/events/:eventId. Public. 404 EVENT_NOT_FOUND. */
export async function getEvent(eventId: string): Promise<CatalogueEvent> {
  const path = `/api/events/${encodeURIComponent(eventId)}`;
  return (await call<{ event: CatalogueEvent }>("GET", path)).event;
}

// ---- the waiting room ------------------------------------------------------------------------------

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

// ---- reserving and paying --------------------------------------------------------------------------

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
  eventId: string;
  qty: number;
  /** What was charged, in the smallest currency unit. Null until payment has been asked for. */
  amount: number | null;
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

// ---- the admin page ---------------------------------------------------------------------------------

/** An event with the numbers behind it. They are null when Redis could not be read. */
export interface AdminEvent extends CatalogueEvent {
  /** Tickets in someone's checkout, not yet paid for. */
  held: number | null;
  sold: number | null;
  /** People waiting in line, and people whose turn it is now. */
  queued: number | null;
  admitted: number | null;
  queueState: "OPEN" | "PAUSED" | "SOLD_OUT" | null;
  admitRatePerSec: number;
  admitTtlSec: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/events. `live` is false when the numbers from Redis are missing. */
export function adminListEvents(): Promise<{ live: boolean; events: AdminEvent[] }> {
  return call("GET", "/api/admin/events");
}

/** What the event form sends. Instants are epoch ms. */
export interface EventInput {
  /** Create only, and optional there: left out, the id is made from the name. */
  id?: string;
  name: string;
  description: string;
  price: number;
  /** Create only: an event's stock is set once. */
  totalStock?: number;
  imageUrl: string | null;
  lobbyOpensAt: number;
  saleOpensAt: number;
  admitRatePerSec: number;
  admitTtlSec: number;
}

/** POST /api/admin/events. 409 EVENT_EXISTS, 400 BAD_REQUEST with `issues` by field. */
export async function adminCreateEvent(input: EventInput): Promise<AdminEvent> {
  return (await call<{ event: AdminEvent }>("POST", "/api/admin/events", { body: input })).event;
}

/** PUT /api/admin/events/:eventId. Anything but the id and the stock. */
export async function adminUpdateEvent(
  eventId: string,
  changes: Omit<EventInput, "id" | "totalStock">,
): Promise<AdminEvent> {
  const path = `/api/admin/events/${encodeURIComponent(eventId)}`;
  return (await call<{ event: AdminEvent }>("PUT", path, { body: changes })).event;
}

/** One row per event and order state. */
export interface OrderMetricsRow {
  eventId: string;
  state: string;
  orders: number;
  /** Tickets those orders are for. */
  units: number;
  /** What they were charged in total, in the smallest currency unit. */
  amount: number;
}

/** GET /api/admin/orders/metrics */
export async function adminOrderMetrics(): Promise<OrderMetricsRow[]> {
  return (await call<{ rows: OrderMetricsRow[] }>("GET", "/api/admin/orders/metrics")).rows;
}

/** What Cloudinary needs for one upload, signed by the ticket service. */
interface UploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
}

export const COVER_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Uploads a cover image and returns its URL. Two steps: POST /api/admin/uploads/sign gets a signature
 * (the API secret stays in the ticket service), then the browser posts the file to Cloudinary itself,
 * so the image never passes through our services. 503 UPLOADS_NOT_CONFIGURED when Cloudinary is not
 * set up: the form then takes a pasted URL.
 */
export async function uploadCover(file: File): Promise<string> {
  if (!COVER_TYPES.includes(file.type)) {
    throw new ApiFailure(400, "UPLOAD_BAD_TYPE");
  }
  if (file.size > COVER_MAX_BYTES) {
    throw new ApiFailure(400, "UPLOAD_TOO_LARGE");
  }
  const ticket = await call<UploadTicket>("POST", "/api/admin/uploads/sign");

  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields)) {
    form.append(name, value);
  }
  form.append("file", file);
  let uploaded: { secure_url?: unknown };
  try {
    const res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
    uploaded = (await res.json()) as { secure_url?: unknown };
  } catch {
    throw new ApiFailure(0, "UPLOAD_FAILED");
  }
  if (typeof uploaded.secure_url !== "string") {
    throw new ApiFailure(502, "UPLOAD_FAILED");
  }
  return uploaded.secure_url;
}
