import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ADMIN_ROLE, requireAdmin, signSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventLive, LiveCounts } from "../src/catalogue/live.js";
import { slugify, statusOf } from "../src/catalogue/routes.js";
import {
  type EventChanges,
  EventExistsError,
  type EventRecord,
  type EventStore,
  type NewEvent,
} from "../src/catalogue/store.js";
import { createUploadSigner, signParams } from "../src/catalogue/uploads.js";
import { createApp } from "../src/server.js";

// The catalogue's routes over HTTP, with the two things behind them replaced: the rows are a Map and
// the Redis half records what it was asked to do. Nothing here needs Postgres or Redis.

const SECRET = "catalogue-test-session-secret-0123456789abcdef";

// biome-ignore lint/suspicious/noExplicitAny: the tests read whatever shape a reply has.
type Json = Record<string, any>;
const HOUR = 3_600_000;

class MemoryStore implements EventStore {
  readonly rows = new Map<string, EventRecord>();
  failing = false;

  #check(): void {
    if (this.failing) {
      throw new Error("postgres is down");
    }
  }

  async list(): Promise<EventRecord[]> {
    this.#check();
    return [...this.rows.values()].sort(
      (a, b) => a.saleOpensAt.getTime() - b.saleOpensAt.getTime(),
    );
  }

  async get(id: string): Promise<EventRecord | null> {
    this.#check();
    return this.rows.get(id) ?? null;
  }

  async create(event: NewEvent): Promise<EventRecord> {
    this.#check();
    if (this.rows.has(event.id)) {
      throw new EventExistsError(event.id);
    }
    const row = { ...event, createdAt: new Date(), updatedAt: new Date() };
    this.rows.set(event.id, row);
    return row;
  }

  async update(id: string, changes: EventChanges): Promise<EventRecord | null> {
    this.#check();
    const row = this.rows.get(id);
    if (!row) {
      return null;
    }
    const next = { ...row, ...changes, updatedAt: new Date() };
    this.rows.set(id, next);
    return next;
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async close(): Promise<void> {}
}

class RecordingLive implements EventLive {
  readonly opened: string[] = [];
  readonly configured: EventRecord[] = [];
  readonly counts = new Map<string, LiveCounts>();
  failing = false;

  async read(ids: readonly string[]): Promise<Map<string, LiveCounts>> {
    if (this.failing) {
      throw new Error("redis is down");
    }
    const found = new Map<string, LiveCounts>();
    for (const id of ids) {
      const known = this.counts.get(id);
      if (known) {
        found.set(id, known);
      }
    }
    return found;
  }

  async open(event: EventRecord): Promise<void> {
    if (this.failing) {
      throw new Error("redis is down");
    }
    this.opened.push(event.id);
  }

  async configure(event: EventRecord): Promise<void> {
    if (this.failing) {
      throw new Error("redis is down");
    }
    this.configured.push(event);
  }
}

const counts = (over: Partial<LiveCounts> = {}): LiveCounts => ({
  available: 10,
  held: 0,
  sold: 0,
  queueState: "OPEN",
  queued: 0,
  admitted: 0,
  ...over,
});

describe("the catalogue", () => {
  let store: MemoryStore;
  let live: RecordingLive;
  let server: Server;
  let base: string;
  let admin: Record<string, string>;
  let customer: Record<string, string>;

  /** A body the create route accepts, with the sale an hour away. */
  const valid = (over: Record<string, unknown> = {}) => ({
    name: "Aurora Sound Festival",
    price: 149_900,
    totalStock: 500,
    lobbyOpensAt: Date.now() - HOUR,
    saleOpensAt: Date.now() + HOUR,
    ...over,
  });

  async function request(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  beforeEach(async () => {
    store = new MemoryStore();
    live = new RecordingLive();
    const app = createApp(createLogger({ service: "ticket", level: "error" }), undefined, {
      catalogue: {
        store,
        live,
        requireAdmin: requireAdmin(SECRET),
        uploads: createUploadSigner({
          cloudName: "demo-cloud",
          apiKey: "1234",
          apiSecret: "shh",
          folder: "flash-sale/events",
        }),
        // No caching, so each test reads what it just wrote.
        cacheTtlMs: 0,
      },
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = {
      authorization: `Bearer ${(await signSession(SECRET, "admin", Date.now(), ADMIN_ROLE)).token}`,
    };
    // A customer who picked the name "admin": a session, but no role.
    customer = { authorization: `Bearer ${(await signSession(SECRET, "admin")).token}` };
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  describe("for the admin", () => {
    it("refuses everything under /admin without an admin session", async () => {
      expect((await request("GET", "/admin/events")).status).toBe(401);
      const asCustomer = await request("POST", "/admin/events", customer, valid());
      expect(asCustomer.status).toBe(403);
      expect(asCustomer.body.code).toBe("FORBIDDEN");
      expect((await request("POST", "/admin/uploads/sign", customer)).status).toBe(403);
      expect(store.rows.size).toBe(0);
      expect(live.opened).toEqual([]);
    });

    it("creates an event, with an id made from its name, and puts it on sale", async () => {
      const created = await request("POST", "/admin/events", admin, valid());
      expect(created.status).toBe(201);
      expect(created.body.event).toMatchObject({
        id: "aurora-sound-festival",
        name: "Aurora Sound Festival",
        price: 149_900,
        totalStock: 500,
        description: "",
        imageUrl: null,
        admitRatePerSec: 50,
        admitTtlSec: 120,
        status: "LOBBY",
      });
      expect(live.opened).toEqual(["aurora-sound-festival"]);

      // The same name again gets an id of its own.
      const second = await request("POST", "/admin/events", admin, valid());
      expect(second.status).toBe(201);
      expect(second.body.event.id).toMatch(/^aurora-sound-festival-[0-9a-f]{4}$/);
    });

    it("answers 409 for an id that is taken, and leaves the first event alone", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      const again = await request(
        "POST",
        "/admin/events",
        admin,
        valid({ id: "launch", price: 1 }),
      );
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("EVENT_EXISTS");
      expect(store.rows.get("launch")?.price).toBe(149_900);
      expect(live.opened).toEqual(["launch"]);
    });

    it("says which fields are wrong", async () => {
      const bad = await request(
        "POST",
        "/admin/events",
        admin,
        valid({ name: " ", price: 0, imageUrl: "http://example.com/a.png", id: "Not A Slug" }),
      );
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("BAD_REQUEST");
      expect(Object.keys(bad.body.issues).sort()).toEqual(["id", "imageUrl", "name", "price"]);

      const backwards = await request(
        "POST",
        "/admin/events",
        admin,
        valid({ lobbyOpensAt: Date.now() + 2 * HOUR }),
      );
      expect(backwards.status).toBe(400);
      expect(Object.keys(backwards.body.issues)).toEqual(["saleOpensAt"]);
      expect(store.rows.size).toBe(0);
    });

    it("takes the row back out when the event could not be put on sale", async () => {
      live.failing = true;
      const created = await request("POST", "/admin/events", admin, valid());
      expect(created.status).toBe(503);
      expect(created.body.code).toBe("CATALOGUE_UNAVAILABLE");
      expect(store.rows.size).toBe(0);
    });

    it("edits an event and rewrites its waiting room's config", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      const edited = await request("PUT", "/admin/events/launch", admin, {
        name: "Launch night",
        price: 2_500,
        imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/flash-sale/events/a.jpg",
      });
      expect(edited.status).toBe(200);
      expect(edited.body.event).toMatchObject({ id: "launch", name: "Launch night", price: 2_500 });
      expect(live.configured.map((event) => [event.id, event.price])).toEqual([["launch", 2_500]]);
      // The stock was not reset: the event was opened once, when it was created.
      expect(live.opened).toEqual(["launch"]);
    });

    it("refuses an edit of the id or the stock, and a sale that would open before its lobby", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      const stock = await request("PUT", "/admin/events/launch", admin, { totalStock: 9 });
      expect(stock.status).toBe(400);
      const rename = await request("PUT", "/admin/events/launch", admin, { id: "other" });
      expect(rename.status).toBe(400);
      // Only the sale time is named; it is checked against the lobby time already saved.
      const backwards = await request("PUT", "/admin/events/launch", admin, {
        saleOpensAt: Date.now() - 2 * HOUR,
      });
      expect(backwards.status).toBe(400);
      expect(live.configured).toEqual([]);
      expect(store.rows.get("launch")?.totalStock).toBe(500);

      expect((await request("PUT", "/admin/events/nope", admin, { price: 5 })).status).toBe(404);
    });

    it("says so when an edit was saved but Redis was not updated", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      live.failing = true;
      const edited = await request("PUT", "/admin/events/launch", admin, { price: 777 });
      expect(edited.status).toBe(503);
      expect(edited.body.code).toBe("SYNC_FAILED");
      expect(store.rows.get("launch")?.price).toBe(777);
    });

    it("lists every event with the numbers behind it", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      live.counts.set("launch", counts({ available: 420, held: 30, sold: 50, queued: 12 }));
      const listed = await request("GET", "/admin/events", admin);
      expect(listed.status).toBe(200);
      expect(listed.body.live).toBe(true);
      expect(listed.body.events).toHaveLength(1);
      expect(listed.body.events[0]).toMatchObject({
        id: "launch",
        available: 420,
        held: 30,
        sold: 50,
        queued: 12,
        admitted: 0,
        queueState: "OPEN",
      });
    });

    it("signs a cover upload, and says so when Cloudinary is not configured", async () => {
      const signed = await request("POST", "/admin/uploads/sign", admin);
      expect(signed.status).toBe(200);
      expect(signed.body.uploadUrl).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
      const { signature, api_key, ...params } = signed.body.fields as Record<string, string>;
      expect(api_key).toBe("1234");
      expect(params.folder).toBe("flash-sale/events");
      expect(signature).toBe(signParams(params, "shh"));
      // The secret itself is nowhere in the answer.
      expect(JSON.stringify(signed.body)).not.toContain("shh");

      const bare = createApp(createLogger({ service: "ticket", level: "error" }), undefined, {
        catalogue: { store, live, requireAdmin: requireAdmin(SECRET) },
      }).listen(0, "127.0.0.1");
      await once(bare, "listening");
      try {
        const res = await fetch(
          `http://127.0.0.1:${(bare.address() as AddressInfo).port}/admin/uploads/sign`,
          { method: "POST", headers: admin },
        );
        expect(res.status).toBe(503);
        expect(((await res.json()) as { code: string }).code).toBe("UPLOADS_NOT_CONFIGURED");
      } finally {
        bare.close();
        await once(bare, "close");
      }
    });
  });

  describe("for everyone", () => {
    it("lists the events, soonest sale first, with no session at all", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "later", name: "Later" }));
      await request(
        "POST",
        "/admin/events",
        admin,
        valid({ id: "sooner", name: "Sooner", saleOpensAt: Date.now() + 60_000 }),
      );
      live.counts.set("sooner", counts({ available: 7 }));

      const before = Date.now();
      const listed = await request("GET", "/events");
      expect(listed.status).toBe(200);
      expect(listed.body.now).toBeGreaterThanOrEqual(before);
      expect(listed.body.events.map((event: { id: string }) => event.id)).toEqual([
        "sooner",
        "later",
      ]);
      expect(listed.body.events[0]).toMatchObject({ available: 7, status: "LOBBY" });
      // Nothing an admin sees beyond that.
      expect(listed.body.events[0]).not.toHaveProperty("held");
      expect(listed.body.events[0]).not.toHaveProperty("admitRatePerSec");
    });

    it("shows one event, and 404s for one that does not exist", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      const found = await request("GET", "/events/launch");
      expect(found.status).toBe(200);
      expect(found.body.event).toMatchObject({ id: "launch", totalStock: 500 });

      const missing = await request("GET", "/events/nope");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("EVENT_NOT_FOUND");
    });

    it("still lists the events when the live numbers cannot be read", async () => {
      await request("POST", "/admin/events", admin, valid({ id: "launch" }));
      live.failing = true;
      const listed = await request("GET", "/events");
      expect(listed.status).toBe(200);
      expect(listed.body.events[0]).toMatchObject({ id: "launch", available: null });
    });

    it("answers 503 when the rows cannot be read", async () => {
      store.failing = true;
      const listed = await request("GET", "/events");
      expect(listed.status).toBe(503);
      expect(listed.body.code).toBe("CATALOGUE_UNAVAILABLE");
    });
  });
});

describe("statusOf", () => {
  const now = Date.now();
  const at = (lobby: number, sale: number) => ({
    lobbyOpensAt: new Date(now + lobby),
    saleOpensAt: new Date(now + sale),
  });

  it("goes by the clock until the sale opens", () => {
    expect(statusOf(at(HOUR, 2 * HOUR), counts(), now)).toBe("UPCOMING");
    expect(statusOf(at(-HOUR, HOUR), counts({ available: 0 }), now)).toBe("LOBBY");
    expect(statusOf(at(-2 * HOUR, -HOUR), counts(), now)).toBe("LIVE");
  });

  it("is sold out only when nothing is left in stock or in anyone's checkout", () => {
    const open = at(-2 * HOUR, -HOUR);
    expect(statusOf(open, counts({ available: 0, held: 3 }), now)).toBe("LIVE");
    expect(statusOf(open, counts({ available: 0, held: 0 }), now)).toBe("SOLD_OUT");
    expect(statusOf(open, counts({ queueState: "SOLD_OUT" }), now)).toBe("SOLD_OUT");
    // No numbers to go by: the sale is on as far as anyone can tell.
    expect(statusOf(open, undefined, now)).toBe("LIVE");
  });
});

describe("slugify", () => {
  it("makes an id out of a name", () => {
    expect(slugify("Aurora Sound Festival 2026!")).toBe("aurora-sound-festival-2026");
    expect(slugify("  Café — Late Show  ")).toBe("cafe-late-show");
    expect(slugify("x".repeat(80))).toHaveLength(40);
  });

  it("falls back when nothing usable is left", () => {
    expect(slugify("!!")).toBe("event");
    expect(slugify("日本")).toBe("event");
  });
});

describe("signParams", () => {
  it("matches the example in Cloudinary's documentation", () => {
    // "eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510"
    // with the secret "abcd" appended, SHA-1. Given out of order here: signing sorts by name.
    expect(
      signParams(
        {
          timestamp: "1315060510",
          public_id: "sample_image",
          eager: "w_400,h_300,c_pad|w_260,h_200,c_crop",
        },
        "abcd",
      ),
    ).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e");
  });
});
