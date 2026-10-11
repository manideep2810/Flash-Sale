// The web app, driven in a real browser (Playwright, Chromium) through the gateway on :8080: the whole
// journey a person takes, and the rules the pages must keep while they take it.
//
//   pnpm -C tests/e2e run test:phase5        (or: make test-phase5)
//
// What it starts: a production build of web/ (`next build`, then `next start` on 3012) and every
// service as a child process on its usual port (stop `make dev` first). The gateway is the one
// already running, with its normal limits: the app's own pace stays inside them. Needs the local
// stack up (`make up`) and a Chromium for Playwright (`pnpm -C tests/e2e exec playwright install chromium`).
//
// Each test seeds a sale of its own: open now, admitting 50 a second, with whatever stock, turn length
// and users the case needs.

import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Harness } from "../phase4/support.js";
import {
  buildWeb,
  call,
  clustersHealthy,
  compose,
  forgetSale,
  GATEWAY,
  GATEWAY_CONTAINERS,
  openWaitingRoom,
  queueProcs,
  TICKET,
  type WaitingRoomOptions,
  waitFor,
  webProc,
} from "./support.js";

describe("the web app, in a browser", () => {
  const h = new Harness({ ticketWorkers: "1" });
  const procs = [...queueProcs(), webProc()];
  const runId = randomUUID().slice(0, 8);
  const sales: string[] = [];
  const contexts: BrowserContext[] = [];
  let browser: Browser;

  /** A user id nobody has used. A prefix of "ok-" or "fail-" decides the mock payment's answer. */
  const user = (name: string) => `${name}-${runId}`;

  /** A sale with an open waiting room. Stock null seeds none: the admitter then admits nobody. */
  async function seedSale(stock: number | null, room: WaitingRoomOptions = {}): Promise<string> {
    let eventId: string;
    if (stock === null) {
      eventId = `e2e-web-${randomUUID().slice(0, 8)}`;
    } else {
      eventId = await h.createSale(stock, "web");
    }
    await openWaitingRoom(h.redis, eventId, { name: "Test event", price: 1_999, ...room });
    sales.push(eventId);
    return eventId;
  }

  /** A browser of one's own: its own storage, so its own login. */
  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    return page;
  }

  /** Opens the event page and logs in through the bar. */
  async function openEvent(page: Page, eventId: string, userId: string): Promise<void> {
    await page.goto(`${GATEWAY}/events/${eventId}`);
    await page.locator('input[name="userId"]').fill(userId);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByText(`Logged in as ${userId}`).waitFor();
  }

  /** From the event page to the buy page: join, wait in the room, be admitted. */
  async function reachBuyPage(page: Page, eventId: string, userId: string): Promise<void> {
    await openEvent(page, eventId, userId);
    await page.getByRole("button", { name: "Join queue" }).click();
    await page.waitForURL(`**/events/${eventId}/buy`);
    await page.getByRole("button", { name: "Reserve" }).waitFor();
  }

  const position = (page: Page) => page.getByTestId("position").innerText();

  beforeAll(async () => {
    await buildWeb();
    // The gateway as `make up` runs it. Restarted, so that it has read the envoy.yaml on disk.
    await compose(["up", "-d", "--wait", ...GATEWAY_CONTAINERS]);
    await compose(["restart", "envoy"]);
    await compose(["exec", "-T", "redis-ratelimit", "redis-cli", "flushall"]);
    try {
      await h.startAll();
      await Promise.all(procs.map((proc) => proc.start()));
    } catch (error) {
      await Promise.all(procs.map((proc) => proc.kill()));
      await h.stopAll();
      throw error;
    }
    await waitFor(
      "Envoy to see every service and the web app healthy",
      90_000,
      () =>
        clustersHealthy(["order-api", "ticket", "queue-svc", "web", "ratelimit"]).catch(
          () => false,
        ),
      500,
    );
    await h.waitQuiet(120_000).catch(() => {});
    await h.resetTables();
    browser = await chromium.launch();
  }, 600_000);

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  });

  afterAll(async () => {
    await browser?.close();
    await Promise.all(procs.map((proc) => proc.kill()));
    for (const eventId of sales) {
      await forgetSale(h.redis, eventId);
    }
    await h.stopAll();
  }, 240_000);

  it("1. takes a user from login to a confirmed order", async () => {
    const eventId = await seedSale(5);
    const page = await newPage();
    await openEvent(page, eventId, user("ok-happy"));

    // The event page shows what /info says.
    await page.getByRole("heading", { name: "Test event" }).waitFor();
    await page.getByText("19.99").waitFor();
    await page.getByText("The sale is open").waitFor();

    await page.getByRole("button", { name: "Join queue" }).click();
    await page.waitForURL(`**/events/${eventId}/buy`);
    await page.getByText("It's your turn — you have until").waitFor();
    expect(await page.title()).toBe("It's your turn!");

    await page.getByRole("button", { name: "Reserve" }).click();
    await page.waitForURL("**/checkout/**");
    await page.getByText("Your item is held until").waitFor();

    await page.getByRole("button", { name: "Pay" }).click();
    await page.getByText("Order confirmed").waitFor({ timeout: 60_000 });
    expect(page.url()).toContain("/orders/");
    await page.getByRole("link", { name: "Back to the event" }).waitFor();
  }, 120_000);

  it("2. keeps the same place in line across a refresh", async () => {
    // No stock, so nobody is admitted and the line stands still; five people are in it already.
    const eventId = await seedSale(null);
    const queue = `ev:${eventId}:queue`;
    const earlier = Date.now() - 30_000;
    for (let i = 0; i < 5; i++) {
      await h.redis.zadd(queue, earlier + i, `ahead-${i}`);
    }
    const userId = user("refresh");
    const page = await newPage();
    await openEvent(page, eventId, userId);
    await page.getByRole("button", { name: "Join queue" }).click();
    await page.waitForURL(`**/events/${eventId}/queue`);

    await page.getByTestId("position").waitFor();
    expect(await position(page)).toBe("6");
    const joinedAt = await h.redis.zscore(queue, userId);
    expect(joinedAt).not.toBeNull();

    await page.reload();
    await page.getByTestId("position").waitFor();
    expect(await position(page)).toBe("6");
    // The same entry, not a new one: one member more than before, with the score it first got.
    expect(await h.redis.zcard(queue)).toBe(6);
    expect(await h.redis.zscore(queue, userId)).toBe(joinedAt);
    // And the session survived the refresh too.
    await page.getByText(`Logged in as ${userId}`).waitFor();
  }, 60_000);

  it("3. is still the user's turn after a refresh of the buy page, and reserve works", async () => {
    const eventId = await seedSale(5);
    const page = await newPage();
    await reachBuyPage(page, eventId, user("ok-reload"));

    // The admission token lives in memory only, so the refresh loses it. The only thing the page
    // has stored is the session.
    // (Evaluated in the page, as a string: this workspace is not compiled against the DOM.)
    const stored = await page.evaluate(
      "({ session: Object.keys(sessionStorage), local: Object.keys(localStorage) })",
    );
    expect(stored).toEqual({ session: ["flash.session"], local: [] });

    await page.reload();
    // ...and the page gets it again from the server, for the same turn.
    await page.getByText("It's your turn — you have until").waitFor();
    await page.getByRole("button", { name: "Reserve" }).click();
    await page.waitForURL("**/checkout/**");
    expect(await h.inventory(eventId)).toMatchObject({ avail: 4 });
  }, 90_000);

  it("4. says the turn expired when it is not used, and Rejoin goes to the back", async () => {
    const eventId = await seedSale(5, { admitTtlSec: 2 });
    const userId = user("slow");
    const page = await newPage();
    await reachBuyPage(page, eventId, userId);

    // While the turn runs out: stock is all held (nobody else gets in), and three people arrive.
    await h.redis.set(`ev:${eventId}:avail`, "0");
    await h.redis.zadd(`ev:${eventId}:holds`, Date.now() + 600_000, "someone-elses-hold");
    for (let i = 0; i < 3; i++) {
      await h.redis.zadd(`ev:${eventId}:queue`, Date.now() + i, `later-${i}`);
    }

    // Never reserve. The page says so by itself, and offers to rejoin.
    await page.getByText("Your turn expired.").waitFor({ timeout: 20_000 });
    expect(page.url()).toContain(`/events/${eventId}/queue`);
    await page.getByRole("button", { name: "Rejoin" }).click();

    // At the back: fourth, behind the three who arrived meanwhile.
    await page.getByTestId("position").waitFor();
    expect(await position(page)).toBe("4");
    await page.getByText("All items are currently held.").waitFor();
    expect(await h.redis.zrank(`ev:${eventId}:queue`, userId)).toBe(3);
  }, 90_000);

  it("5. tells the second of two users that the last item is sold out", async () => {
    const eventId = await seedSale(1);
    const first = await newPage();
    const second = await newPage();
    // Both are admitted before either reserves.
    await reachBuyPage(first, eventId, user("ok-first"));
    await reachBuyPage(second, eventId, user("ok-second"));

    await first.getByRole("button", { name: "Reserve" }).click();
    await first.waitForURL("**/checkout/**");

    await second.getByRole("button", { name: "Reserve" }).click();
    await second.getByText("Sold out.").waitFor();
    expect(second.url()).toContain(`/events/${eventId}/buy`);
    expect(await h.inventory(eventId)).toMatchObject({ avail: 0 });
  }, 90_000);

  it("6. never reserves before being admitted, and never polls sooner than it was told", async () => {
    // No stock at first, so the user waits in line and polls a few times.
    const eventId = await seedSale(null);
    const page = await newPage();

    interface Seen {
      at: number;
      kind: "status-request" | "status-response" | "reserve-request";
      status?: string;
      retryAfterMs?: number;
    }
    const seen: Seen[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/reserve")) {
        seen.push({ at: Date.now(), kind: "reserve-request" });
      } else if (url.endsWith(`/api/queue/${eventId}/status`)) {
        seen.push({ at: Date.now(), kind: "status-request" });
      }
    });
    page.on("response", async (response) => {
      if (response.url().endsWith(`/api/queue/${eventId}/status`) && response.status() === 200) {
        const at = Date.now();
        const body = (await response.json()) as { status: string; retryAfterMs?: number };
        seen.push({
          at,
          kind: "status-response",
          status: body.status,
          retryAfterMs: body.retryAfterMs,
        });
      }
    });

    await openEvent(page, eventId, user("ok-spy"));
    await page.getByRole("button", { name: "Join queue" }).click();
    await page.getByTestId("position").waitFor();

    // Three answers of "still queued", at the server's pace (about two seconds apart).
    await waitFor(
      "three status polls",
      30_000,
      async () =>
        seen.filter((s) => s.kind === "status-response" && s.status === "QUEUED").length >= 3,
    );
    expect(seen.some((s) => s.kind === "reserve-request")).toBe(false);

    // Stock arrives; the admitter lets the user in; the page moves on and the user reserves.
    const reset = await call("POST", `${TICKET}/redis/reset`, {}, { eventId, total: 3 });
    expect(reset.status).toBe(200);
    await page.waitForURL(`**/events/${eventId}/buy`, { timeout: 30_000 });
    await page.getByRole("button", { name: "Reserve" }).click();
    await page.waitForURL("**/checkout/**");

    // No reserve before the status that said ADMITTED.
    const admittedAt = seen.find(
      (s) => s.kind === "status-response" && s.status === "ADMITTED",
    )?.at;
    const reserves = seen.filter((s) => s.kind === "reserve-request");
    expect(admittedAt).toBeDefined();
    expect(reserves).toHaveLength(1);
    expect(reserves[0]?.at).toBeGreaterThan(Number(admittedAt));

    // Every status call came at least retryAfterMs after the answer before it (100 ms of slack for
    // the timestamps, which are taken here and not in the browser).
    const ordered = seen.filter((s) => s.kind !== "reserve-request").sort((a, b) => a.at - b.at);
    let gaps = 0;
    for (let i = 0; i + 1 < ordered.length; i++) {
      const answer = ordered[i];
      const next = ordered[i + 1];
      if (answer?.kind === "status-response" && next?.kind === "status-request") {
        expect(answer.retryAfterMs, "a QUEUED answer names its retryAfterMs").toBeGreaterThan(0);
        expect(next.at - answer.at).toBeGreaterThanOrEqual(Number(answer.retryAfterMs) - 100);
        gaps++;
      }
    }
    expect(gaps).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("7. says the payment failed and the item was released", async () => {
    const eventId = await seedSale(5);
    const page = await newPage();
    // The mock payment service declines users whose id starts with "fail-" (NODE_ENV=test).
    await reachBuyPage(page, eventId, `fail-${user("pay")}`);

    await page.getByRole("button", { name: "Reserve" }).click();
    await page.waitForURL("**/checkout/**");
    await page.getByRole("button", { name: "Pay" }).click();

    await page.getByText("Payment failed — your item was released").waitFor({ timeout: 60_000 });
    expect(page.url()).toContain("/orders/");
    // And it was: the unit is back in stock once the hold is settled.
    await waitFor("the item to be back in stock", 30_000, async () => {
      return (await h.inventory(eventId)).avail === 5;
    });
  }, 120_000);
});
