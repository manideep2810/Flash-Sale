import { randomBytes } from "node:crypto";
import type { Logger } from "@flash/observability";
import { type Request, type RequestHandler, type Response, Router } from "express";
import { z } from "zod";
import type { EventLive, LiveCounts, QueueState } from "./live.js";
import { EventExistsError, type EventRecord, type EventStore, type NewEvent } from "./store.js";
import type { UploadSigner } from "./uploads.js";

// The catalogue's HTTP side.
//
//   GET  /events                 everyone: the listing
//   GET  /events/:id             everyone: one event
//   GET  /admin/events           admin: the listing with every number
//   POST /admin/events           admin: put a new event on sale
//   PUT  /admin/events/:id       admin: edit one (anything but its id and its stock)
//   POST /admin/uploads/sign     admin: a signature for one cover upload to Cloudinary
//
// Errors are {code, message}, like the session and admission checks.

/** Where an event is in its life, by the server's clock. */
export type EventStatus =
  /** The lobby has not opened: nothing to do but wait. */
  | "UPCOMING"
  /** People can join the waiting room; the sale has not started. */
  | "LOBBY"
  /** The sale is on. */
  | "LIVE"
  /** The sale is on and nothing is left, in stock or in anyone's checkout. */
  | "SOLD_OUT";

/** An event as anyone may see it. Instants are epoch milliseconds. */
export interface EventView {
  id: string;
  name: string;
  description: string;
  /** Per ticket, in the smallest currency unit. */
  price: number;
  imageUrl: string | null;
  lobbyOpensAt: number;
  saleOpensAt: number;
  totalStock: number;
  /** Null when the live numbers could not be read. */
  available: number | null;
  status: EventStatus;
}

/** An event as the admin page sees it: the same, with the numbers behind it. */
export interface AdminEventView extends EventView {
  held: number | null;
  sold: number | null;
  /** People waiting in line, and people whose turn it is now. */
  queued: number | null;
  admitted: number | null;
  queueState: QueueState | null;
  admitRatePerSec: number;
  admitTtlSec: number;
  /** ISO times. */
  createdAt: string;
  updatedAt: string;
}

export function statusOf(
  event: Pick<EventRecord, "lobbyOpensAt" | "saleOpensAt">,
  live: LiveCounts | undefined,
  now: number,
): EventStatus {
  if (now < event.lobbyOpensAt.getTime()) {
    return "UPCOMING";
  }
  if (now < event.saleOpensAt.getTime()) {
    return "LOBBY";
  }
  // Stock at zero is not sold out while tickets sit in checkouts: those can still come back.
  if (live && (live.queueState === "SOLD_OUT" || (live.available === 0 && live.held === 0))) {
    return "SOLD_OUT";
  }
  return "LIVE";
}

function publicView(event: EventRecord, live: LiveCounts | undefined, now: number): EventView {
  return {
    id: event.id,
    name: event.name,
    description: event.description,
    price: event.price,
    imageUrl: event.imageUrl,
    lobbyOpensAt: event.lobbyOpensAt.getTime(),
    saleOpensAt: event.saleOpensAt.getTime(),
    totalStock: event.totalStock,
    available: live?.available ?? null,
    status: statusOf(event, live, now),
  };
}

function adminView(event: EventRecord, live: LiveCounts | undefined, now: number): AdminEventView {
  return {
    ...publicView(event, live, now),
    held: live?.held ?? null,
    sold: live?.sold ?? null,
    queued: live?.queued ?? null,
    admitted: live?.admitted ?? null,
    queueState: live?.queueState ?? null,
    admitRatePerSec: event.admitRatePerSec,
    admitTtlSec: event.admitTtlSec,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

// ---- what an admin may send ---------------------------------------------------------------------

/** 3 to 48 of a-z, 0-9 and "-", not starting or ending with "-". Never a ":", which hold ids split on. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
/** The year 2100, in epoch ms: far enough, and well inside what a Date can hold. */
const LATEST_INSTANT = 4_102_444_800_000;

const instant = z.number().int().min(0).max(LATEST_INSTANT);

const editable = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  price: z.number().int().min(1).max(100_000_000),
  // https only: the URL goes into an <img> on every visitor's page.
  imageUrl: z.union([z.null(), z.url({ protocol: /^https$/ }).max(2_048)]),
  lobbyOpensAt: instant,
  saleOpensAt: instant,
  admitRatePerSec: z.number().int().min(1).max(10_000),
  admitTtlSec: z.number().int().min(10).max(3_600),
};

const createBody = z.strictObject({
  ...editable,
  /** Left out, it is made from the name. */
  id: z.string().regex(SLUG).optional(),
  description: editable.description.default(""),
  imageUrl: editable.imageUrl.default(null),
  admitRatePerSec: editable.admitRatePerSec.default(50),
  admitTtlSec: editable.admitTtlSec.default(120),
  totalStock: z.number().int().min(1).max(1_000_000),
});

// Strict, so that an edit naming `id` or `totalStock` is refused, not quietly ignored.
const updateBody = z.strictObject(editable).partial();

/** "Aurora Sound Festival 2026!" -> "aurora-sound-festival-2026". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return SLUG.test(slug) ? slug : "event";
}

function invalid(res: Response, issues: Record<string, string[]>): void {
  res.status(400).json({ code: "BAD_REQUEST", message: "the event is not valid", issues });
}

/** Zod's per-field messages; anything about the body as a whole goes under "body". */
function issuesOf(error: z.ZodError): Record<string, string[]> {
  const { formErrors, fieldErrors } = z.flattenError(error);
  const issues: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, string[]>)) {
    if (messages.length > 0) {
      issues[field] = messages;
    }
  }
  if (formErrors.length > 0) {
    issues.body = formErrors;
  }
  return issues;
}

const SALE_BEFORE_LOBBY = {
  saleOpensAt: ["the sale cannot open before the lobby does"],
};

// ---- the listing's cache ---------------------------------------------------------------------------

/**
 * The public pages read the rows through this: the whole table, kept for `ttlMs`. The listing is
 * what a crowd refreshes while it waits for a sale, and the rows behind it change when an admin
 * saves, not when a ticket sells; the numbers that do move come from Redis on every request.
 *
 * Each cluster worker has its own copy, so an edit shows everywhere within `ttlMs`. A new event is
 * visible by its id at once: an id the copy does not know is looked up directly.
 */
function createCachedRows(store: EventStore, ttlMs: number) {
  let loadedAt = 0;
  let rows: Promise<EventRecord[]> | undefined;

  function list(): Promise<EventRecord[]> {
    if (!rows || Date.now() - loadedAt >= ttlMs) {
      const loading = store.list();
      rows = loading;
      loadedAt = Date.now();
      // A failed read is not kept: the next request tries again.
      loading.catch(() => {
        if (rows === loading) {
          rows = undefined;
        }
      });
    }
    return rows;
  }

  return {
    list,
    async get(id: string): Promise<EventRecord | null> {
      return (await list()).find((event) => event.id === id) ?? (await store.get(id));
    },
    clear() {
      rows = undefined;
    },
  };
}

// ---- the router --------------------------------------------------------------------------------------

export interface CatalogueRouterOptions {
  store: EventStore;
  live: EventLive;
  logger: Logger;
  /** requireAdmin() from @flash/auth, in front of everything under /admin. */
  requireAdmin: RequestHandler;
  /** Absent when Cloudinary is not configured: the sign route then answers 503. */
  uploads?: UploadSigner;
  /** How long the public pages may show a row after it changed. */
  cacheTtlMs?: number;
}

const AUTO_ID_ATTEMPTS = 3;

export function createCatalogueRouter({
  store,
  live,
  logger,
  requireAdmin,
  uploads,
  cacheTtlMs = 2_000,
}: CatalogueRouterOptions): Router {
  const router = Router();
  const cached = createCachedRows(store, cacheTtlMs);

  /** The live numbers, or nothing when Redis cannot be read: the pages still show the events. */
  async function countsFor(events: EventRecord[]): Promise<Map<string, LiveCounts> | null> {
    try {
      return await live.read(events.map((event) => event.id));
    } catch (error) {
      logger.warn("catalogue: live numbers unavailable", { error: String(error) });
      return null;
    }
  }

  function unavailable(res: Response, what: string, error: unknown): void {
    logger.error(`catalogue: ${what} failed`, { error: String(error) });
    res.status(503).json({
      code: "CATALOGUE_UNAVAILABLE",
      message: "the catalogue is temporarily unavailable",
    });
  }

  router.get("/events", async (_req: Request, res: Response) => {
    try {
      const events = await cached.list();
      const counts = await countsFor(events);
      const now = Date.now();
      res.json({
        now,
        events: events.map((event) => publicView(event, counts?.get(event.id), now)),
      });
    } catch (error) {
      unavailable(res, "listing", error);
    }
  });

  router.get("/events/:id", async (req: Request, res: Response) => {
    try {
      const event = await cached.get(String(req.params.id));
      if (!event) {
        res.status(404).json({ code: "EVENT_NOT_FOUND", message: "there is no such event" });
        return;
      }
      const counts = await countsFor([event]);
      const now = Date.now();
      res.json({ now, event: publicView(event, counts?.get(event.id), now) });
    } catch (error) {
      unavailable(res, "reading an event", error);
    }
  });

  router.use("/admin", requireAdmin);

  router.get("/admin/events", async (_req: Request, res: Response) => {
    try {
      // Not the cached rows: the admin sees what they just saved.
      const events = await store.list();
      const counts = await countsFor(events);
      const now = Date.now();
      res.json({
        now,
        /** False when the numbers from Redis could not be read; they are then null. */
        live: counts !== null,
        events: events.map((event) => adminView(event, counts?.get(event.id), now)),
      });
    } catch (error) {
      unavailable(res, "the admin listing", error);
    }
  });

  /** Inserts under the id asked for, or under one made from the name, made unique if it has to be. */
  async function insert(
    wanted: string | undefined,
    event: Omit<NewEvent, "id">,
  ): Promise<EventRecord> {
    if (wanted) {
      return store.create({ ...event, id: wanted });
    }
    const base = slugify(event.name);
    for (let attempt = 1; ; attempt++) {
      const id = attempt === 1 ? base : `${base}-${randomBytes(2).toString("hex")}`;
      try {
        return await store.create({ ...event, id });
      } catch (error) {
        if (!(error instanceof EventExistsError) || attempt >= AUTO_ID_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  router.post("/admin/events", async (req: Request, res: Response) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      invalid(res, issuesOf(parsed.error));
      return;
    }
    const { id, lobbyOpensAt, saleOpensAt, ...rest } = parsed.data;
    if (saleOpensAt < lobbyOpensAt) {
      invalid(res, SALE_BEFORE_LOBBY);
      return;
    }

    let created: EventRecord;
    try {
      created = await insert(id, {
        ...rest,
        lobbyOpensAt: new Date(lobbyOpensAt),
        saleOpensAt: new Date(saleOpensAt),
      });
    } catch (error) {
      if (error instanceof EventExistsError) {
        res.status(409).json({ code: "EVENT_EXISTS", message: error.message });
        return;
      }
      unavailable(res, "creating an event", error);
      return;
    }

    try {
      await live.open(created);
    } catch (error) {
      // An event in the catalogue with no stock behind it could be listed but never bought: take the
      // row back out, so that the admin's retry starts clean.
      await store.remove(created.id).catch((cleanup) =>
        logger.error("catalogue: could not remove a half-created event", {
          eventId: created.id,
          error: String(cleanup),
        }),
      );
      unavailable(res, "putting an event on sale", error);
      return;
    }

    cached.clear();
    logger.info("catalogue: event created", { eventId: created.id, stock: created.totalStock });
    const counts = await countsFor([created]);
    res.status(201).json({ event: adminView(created, counts?.get(created.id), Date.now()) });
  });

  router.put("/admin/events/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      invalid(res, issuesOf(parsed.error));
      return;
    }
    const { lobbyOpensAt, saleOpensAt, ...rest } = parsed.data;
    const notFound = () =>
      res.status(404).json({ code: "EVENT_NOT_FOUND", message: "there is no such event" });

    let updated: EventRecord | null;
    try {
      const existing = await store.get(id);
      if (!existing) {
        notFound();
        return;
      }
      // The two instants are checked as they will be once saved, whichever of them the edit names.
      const lobby = lobbyOpensAt ?? existing.lobbyOpensAt.getTime();
      const sale = saleOpensAt ?? existing.saleOpensAt.getTime();
      if (sale < lobby) {
        invalid(res, SALE_BEFORE_LOBBY);
        return;
      }
      updated = await store.update(id, {
        ...rest,
        ...(lobbyOpensAt === undefined ? {} : { lobbyOpensAt: new Date(lobbyOpensAt) }),
        ...(saleOpensAt === undefined ? {} : { saleOpensAt: new Date(saleOpensAt) }),
      });
    } catch (error) {
      unavailable(res, "saving an event", error);
      return;
    }
    if (!updated) {
      notFound();
      return;
    }
    cached.clear();

    try {
      await live.configure(updated);
    } catch (error) {
      // The row is saved and Redis still has the old times, rate and price. Saving again, with the
      // same values, is all it takes: configure() writes the whole config from the row.
      logger.error("catalogue: saved, but the waiting room's config was not written", {
        eventId: id,
        error: String(error),
      });
      res.status(503).json({
        code: "SYNC_FAILED",
        message: "saved, but the live sale could not be updated: save again",
      });
      return;
    }

    logger.info("catalogue: event updated", { eventId: id });
    const counts = await countsFor([updated]);
    res.json({ event: adminView(updated, counts?.get(updated.id), Date.now()) });
  });

  router.post("/admin/uploads/sign", (_req: Request, res: Response) => {
    if (!uploads) {
      res.status(503).json({
        code: "UPLOADS_NOT_CONFIGURED",
        message: "image uploads are off: set the CLOUDINARY_* variables of the ticket service",
      });
      return;
    }
    res.json(uploads.sign());
  });

  return router;
}
