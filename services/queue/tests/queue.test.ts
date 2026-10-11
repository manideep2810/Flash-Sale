import { setTimeout as sleep } from "node:timers/promises";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admittedKey, queueKey } from "../src/redis/keys.js";
import {
  ADMISSION_SECRET,
  createHarness,
  type Harness,
  REDIS_URL,
  request,
  until,
  userIds,
} from "./support.js";

// queue-svc against the real Redis: join, status and the admission token. Where a test needs someone
// admitted it runs admit.lua directly, so nothing here depends on the admitter's timing.

describe.skipIf(!REDIS_URL)("queue-svc, against Redis", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it("1. keeps one entry and one position for a user who joins twice, or 20 times at once", async () => {
    const { eventId } = await h.seedEvent();
    for (const other of ["a", "b", "c"]) {
      await h.join(eventId, other);
    }

    const first = await h.join(eventId, "dana");
    const second = await h.join(eventId, "dana");
    const burst = await Promise.all(Array.from({ length: 20 }, () => h.join(eventId, "dana")));
    for (const reply of [first, second, ...burst]) {
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ status: "QUEUED", position: 4, peopleAhead: 3 });
    }
    expect(await h.redis.zcard(queueKey(eventId))).toBe(4);

    // And when the 20 concurrent calls are the user's first.
    const fresh = await Promise.all(Array.from({ length: 20 }, () => h.join(eventId, "erin")));
    for (const reply of fresh) {
      expect(reply.body).toMatchObject({ status: "QUEUED", position: 5, peopleAhead: 4 });
    }
    expect(await h.redis.zcard(queueKey(eventId))).toBe(5);
  });

  it("2. ranks everyone who joined in the lobby ahead of everyone after, in lottery order", async () => {
    const { eventId, saleOpensAt } = await h.seedEvent({ saleOpensInMs: 4_000 });
    const lobby = userIds("lobby", 100);
    const late = userIds("late", 20);

    // One at a time, so there is a definite join order for the lottery to differ from.
    for (const userId of lobby) {
      const { body } = await h.join(eventId, userId);
      expect(body).toMatchObject({ status: "QUEUED", phase: "LOBBY", estWaitSec: null });
      expect(body.retryAfterMs).toBeGreaterThanOrEqual(4_000);
      expect(body.retryAfterMs).toBeLessThanOrEqual(6_000);
    }
    expect(await h.redisNow(), "the lobby joins ran past saleOpensAt").toBeLessThan(saleOpensAt);

    // join.lua decides lobby-or-not on Redis's clock and the service decides `phase` on this one.
    await until("the sale to open", async () => (await h.redisNow()) > saleOpensAt);
    await sleep(Math.max(saleOpensAt - Date.now(), 0) + 20);
    for (const userId of late) {
      expect((await h.join(eventId, userId)).body).toMatchObject({
        status: "QUEUED",
        phase: "OPEN",
      });
    }

    const order = await h.redis.zrange(queueKey(eventId), "0", "-1");
    expect(order).toHaveLength(120);
    expect(new Set(order.slice(0, 100))).toEqual(new Set(lobby));
    // After the sale opens the line is first come, first served.
    expect(order.slice(100)).toEqual(late);

    // The lobby is not in join order (which, the names being padded, is also alphabetical order). A
    // random shuffle of 100 leaves about one user where they started.
    const lobbyOrder = order.slice(0, 100);
    expect(lobbyOrder).not.toEqual(lobby);
    const unmoved = lobbyOrder.filter((userId, i) => userId === lobby[i]).length;
    expect(unmoved).toBeLessThan(10);

    // Lottery numbers are in [0, 1); join times are epoch ms.
    const scores = await h.redis.zrange(queueKey(eventId), "0", "-1", "WITHSCORES");
    const scoreOf = (i: number) => Number(scores[i * 2 + 1]);
    expect(scoreOf(0)).toBeGreaterThanOrEqual(0);
    expect(scoreOf(99)).toBeLessThan(1);
    expect(scoreOf(100)).toBeGreaterThanOrEqual(saleOpensAt);
  });

  it("3. answers 409 before the lobby opens, 404 for an unknown event, 401 without a session", async () => {
    const { eventId, lobbyOpensAt } = await h.seedEvent({
      lobbyOpensInMs: 3_600_000,
      saleOpensInMs: 7_200_000,
    });
    const early = await h.join(eventId, "u1");
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "NOT_OPEN", lobbyOpensAt });
    expect(typeof early.body.message).toBe("string");
    expect(await h.redis.zcard(queueKey(eventId))).toBe(0);

    for (const reply of [
      await h.join("no-such-event", "u1"),
      await h.status("no-such-event", "u1"),
    ]) {
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ code: "EVENT_NOT_FOUND" });
    }

    const { eventId: open } = await h.seedEvent();
    for (const reply of [await h.join(open), await h.status(open)]) {
      expect(reply.status).toBe(401);
      expect(reply.body).toMatchObject({ code: "UNAUTHENTICATED" });
    }

    // The old X-Dev-User header is not an identity any more, and neither is the gateway's x-user-id.
    const headersOnly = await request(h.baseUrl, "POST", `/queue/${open}/join`, undefined, {
      "x-dev-user": "u1",
      "x-user-id": "u1",
    });
    expect(headersOnly.status).toBe(401);
    expect(headersOnly.body).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await h.redis.zcard(queueKey(open))).toBe(0);

    // With a session they are ignored: the caller is who the session says.
    const asAlice = await request(h.baseUrl, "POST", `/queue/${open}/join`, "alice", {
      "x-dev-user": "bob",
      "x-user-id": "bob",
    });
    expect(asAlice.body).toMatchObject({ status: "QUEUED" });
    expect(await h.redis.zrange(queueKey(open), "0", "-1")).toEqual(["alice"]);
  });

  it("4. reports every field for a queued user, and NOT_IN_QUEUE for one who never joined", async () => {
    const { eventId } = await h.seedEvent({ admitRatePerSec: 2 });
    for (const userId of userIds("u", 5)) {
      await h.join(eventId, userId);
    }

    const queued = await h.status(eventId, "u-0004");
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual({
      status: "QUEUED",
      state: "OPEN",
      position: 5,
      peopleAhead: 4,
      estWaitSec: 2,
      retryAfterMs: expect.any(Number),
      phase: "OPEN",
    });

    const stranger = await h.status(eventId, "never-joined");
    expect(stranger.status).toBe(200);
    expect(stranger.body).toEqual({ status: "NOT_IN_QUEUE" });
  });

  it("describes an event for the event page: its name, price, times and state", async () => {
    const { eventId, lobbyOpensAt, saleOpensAt } = await h.seedEvent({
      saleOpensInMs: 60_000,
      admitRatePerSec: 250,
      name: "Launch day",
      price: 4_999,
    });

    const info = await h.info(eventId, "anyone");
    expect(info.status).toBe(200);
    expect(info.body).toEqual({
      eventId,
      name: "Launch day",
      price: 4_999,
      lobbyOpensAt,
      saleOpensAt,
      admitRatePerSec: 250,
      state: "OPEN",
    });
    // Asking is not joining.
    expect(await h.redis.zcard(queueKey(eventId))).toBe(0);

    // The state is the admitter's, read from its key.
    await h.redis.set(`ev:${eventId}:state`, "SOLD_OUT");
    expect((await h.info(eventId, "anyone")).body.state).toBe("SOLD_OUT");

    // Without a name or a price in the config, the id stands in and there is no price.
    const { eventId: bare } = await h.seedEvent();
    expect((await h.info(bare, "anyone")).body).toMatchObject({ name: bare, price: null });

    expect((await h.info("no-such-event", "anyone")).status).toBe(404);
    expect((await h.info(eventId)).status).toBe(401);
  });

  it("8. mints a token for an admitted user that verifies and expires with their turn", async () => {
    const { eventId } = await h.seedEvent({ admitTtlSec: 120 });
    await h.join(eventId, "u1");
    expect(await h.scripts.admit(eventId, 1)).toBe(1);

    const admitted = await h.status(eventId, "u1");
    expect(admitted.body).toEqual({
      status: "ADMITTED",
      token: expect.any(String),
      expiresAt: expect.any(String),
    });

    const admittedAt = Number(await h.redis.hget(admittedKey(eventId), "u1"));
    const { payload } = await jwtVerify(
      String(admitted.body.token),
      new TextEncoder().encode(ADMISSION_SECRET),
      { audience: "reserve", issuer: "queue-svc" },
    );
    expect(payload.sub).toBe("u1");
    expect(payload.eid).toBe(eventId);
    expect(payload.aud).toBe("reserve");
    expect(payload.exp).toBe(Math.floor((admittedAt + 120_000) / 1000));
    expect(admitted.body.expiresAt).toBe(new Date(admittedAt + 120_000).toISOString());

    // Stateless: asking again gives the same token, not a later one.
    expect((await h.status(eventId, "u1")).body.token).toBe(admitted.body.token);
    // join tells an admitted user so, and leaves the token to status.
    expect((await h.join(eventId, "u1")).body).toEqual({ status: "ADMITTED" });
  });

  it("9. expires a turn after the TTL and sends a rejoin to the back of the line", async () => {
    const { eventId } = await h.seedEvent({ admitTtlSec: 1 });
    for (const userId of ["u1", "u2", "u3", "u4"]) {
      await h.join(eventId, userId);
    }
    expect(await h.scripts.admit(eventId, 1)).toBe(1);
    expect((await h.status(eventId, "u1")).body.status).toBe("ADMITTED");

    const admittedAt = Number(await h.redis.hget(admittedKey(eventId), "u1"));
    await until("the turn to expire", async () => (await h.redisNow()) > admittedAt + 1_000);

    expect((await h.status(eventId, "u1")).body).toEqual({ status: "EXPIRED" });

    const rejoined = await h.join(eventId, "u1");
    expect(rejoined.body).toMatchObject({ status: "QUEUED", position: 4, peopleAhead: 3 });
    expect(await h.redis.zrange(queueKey(eventId), "0", "-1")).toEqual(["u2", "u3", "u4", "u1"]);
    expect(await h.redis.hexists(admittedKey(eventId), "u1")).toBe(0);
  });

  it("12. spaces polls between 1.6s and 18s, further apart the further back a user is", async () => {
    // At one admission a second, 60 people span the whole range: 2s at the front, ~15s at the back.
    const { eventId } = await h.seedEvent({ admitRatePerSec: 1 });
    const users = userIds("u", 60);
    for (const userId of users) {
      await h.join(eventId, userId);
    }

    const replies = await Promise.all(users.map((userId) => h.status(eventId, userId)));
    const retryAt = new Map<number, number>();
    for (const { body } of replies) {
      expect(body.status).toBe("QUEUED");
      expect(body.retryAfterMs).toBeGreaterThanOrEqual(1_600);
      expect(body.retryAfterMs).toBeLessThanOrEqual(18_000);
      retryAt.set(Number(body.position), Number(body.retryAfterMs));
    }
    expect(retryAt.size).toBe(60);

    const front = Number(retryAt.get(1));
    const middle = Number(retryAt.get(30));
    const back = Number(retryAt.get(60));
    // The +/-20% jitter cannot reorder these three: 2s, 7.25s and 14.75s before it.
    expect(front).toBeLessThan(middle);
    expect(middle).toBeLessThan(back);
  });
});
