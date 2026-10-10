import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventState, queueAdmitted, queueDepth } from "../src/metrics.js";
import { admittedKey, availKey, holdsKey, queueKey, stateKey } from "../src/redis/keys.js";
import { createHarness, type Harness, metricValue, REDIS_URL, until, userIds } from "./support.js";

// The admitter loop, in this process, against the real Redis. Each test starts admitters of its own
// through the harness, which stops whatever is still running when the file ends.

describe.skipIf(!REDIS_URL)("queue-admitter, against Redis", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  const admittedCount = (eventId: string) => h.redis.hlen(admittedKey(eventId));
  const queued = (eventId: string) => h.redis.zrange(queueKey(eventId), "0", "-1");
  const admittedUsers = (eventId: string) => h.redis.hkeys(admittedKey(eventId));

  /** Every user is in exactly one of the two places: still queued, or admitted. */
  async function expectConserved(eventId: string, users: string[]): Promise<void> {
    // One MULTI, so the two reads see the same instant even with an admitter running.
    const replies = await h.redis
      .multi()
      .zrange(queueKey(eventId), "0", "-1")
      .hkeys(admittedKey(eventId))
      .exec();
    const [inQueue, inAdmitted] = (replies ?? []).map(([, value]) => value as string[]);
    expect([...(inQueue ?? []), ...(inAdmitted ?? [])].sort()).toEqual([...users].sort());
  }

  it("5. admits in score order: whoever is admitted was at the front", async () => {
    const { eventId } = await h.seedEvent({ admitRatePerSec: 20 });
    for (const userId of userIds("u", 60)) {
      await h.join(eventId, userId);
    }
    const line = await queued(eventId);
    expect(line).toHaveLength(60);

    const admitter = h.newAdmitter();
    admitter.start();
    await until("some admissions", async () => (await admittedCount(eventId)) >= 20);
    await admitter.stop();

    const admitted = await admittedUsers(eventId);
    expect(admitted.length).toBeLessThan(60);
    // The admitted are exactly the first k of the line, and the rest of the line is untouched.
    expect([...admitted].sort()).toEqual(line.slice(0, admitted.length));
    expect(await queued(eventId)).toEqual(line.slice(admitted.length));

    // And they were admitted front to back.
    const times = await h.redis.hmget(admittedKey(eventId), ...line.slice(0, admitted.length));
    const admittedAt = times.map(Number);
    expect(admittedAt).toEqual([...admittedAt].sort((a, b) => a - b));
  });

  it("6. holds the configured rate: 500/s for 10s admits 5,000 +/- 5%", async () => {
    const { eventId } = await h.seedEvent({ admitRatePerSec: 500 });
    const pipeline = h.redis.pipeline();
    for (const [i, userId] of userIds("u", 8_000).entries()) {
      pipeline.zadd(queueKey(eventId), i, userId);
    }
    await pipeline.exec();

    const admitter = h.newAdmitter();
    admitter.start();
    await sleep(10_000);
    await admitter.stop();

    const admitted = await admittedCount(eventId);
    expect(admitted).toBeGreaterThanOrEqual(4_750);
    expect(admitted).toBeLessThanOrEqual(5_250);
    expect(await h.redis.zcard(queueKey(eventId))).toBe(8_000 - admitted);
    expect(await metricValue(queueAdmitted, { event: eventId })).toBe(admitted);
    expect(await h.redis.get(stateKey(eventId))).toBe("OPEN");
  }, 20_000);

  it("7. never tells a waiting user NOT_IN_QUEUE while the admitter is moving people", async () => {
    const { eventId } = await h.seedEvent({ admitRatePerSec: 100 });
    const users = userIds("u", 200);
    await Promise.all(users.map((userId) => h.join(eventId, userId)));

    const admitter = h.newAdmitter();
    admitter.start();

    const seen = new Map<string, number>();
    const done = new Set<string>();
    const deadline = Date.now() + 15_000;
    while (done.size < users.length && Date.now() < deadline) {
      const replies = await Promise.all(users.map((userId) => h.status(eventId, userId)));
      replies.forEach(({ body }, i) => {
        const status = String(body.status);
        seen.set(status, (seen.get(status) ?? 0) + 1);
        if (status === "ADMITTED") {
          done.add(String(users[i]));
        }
      });
    }
    await admitter.stop();

    expect(done.size).toBe(200);
    // Popped from the queue and written to admitted in one script: there is no instant in between.
    expect([...seen.keys()].sort()).toEqual(["ADMITTED", "QUEUED"]);
    expect(seen.get("QUEUED")).toBeGreaterThan(0);
  }, 20_000);

  it("10. pauses while stock is all on hold, then marks the event sold out", async () => {
    const { eventId } = await h.seedEvent({ stock: 0 });
    await h.redis.zadd(holdsKey(eventId), Date.now() + 600_000, "some-hold");
    for (const userId of ["u1", "u2", "u3"]) {
      await h.join(eventId, userId);
    }

    const admitter = h.newAdmitter();
    admitter.start();

    // avail = 0 with a hold outstanding: PAUSED, and nobody gets in.
    await until("PAUSED", async () => (await h.redis.get(stateKey(eventId))) === "PAUSED");
    await sleep(300);
    expect(await h.redis.get(stateKey(eventId))).toBe("PAUSED");
    expect(await admittedCount(eventId)).toBe(0);
    expect(await queued(eventId)).toEqual(["u1", "u2", "u3"]);
    expect((await h.status(eventId, "u2")).body).toMatchObject({
      status: "QUEUED",
      state: "PAUSED",
      position: 2,
    });
    expect(await metricValue(eventState, { event: eventId, state: "PAUSED" })).toBe(1);

    // The hold is gone and avail is still 0: nothing left, nothing held.
    await h.redis.del(holdsKey(eventId));
    await until("SOLD_OUT", async () => (await h.redis.get(stateKey(eventId))) === "SOLD_OUT");
    expect(await admittedCount(eventId)).toBe(0);
    expect((await h.join(eventId, "newcomer")).body).toEqual({ status: "SOLD_OUT" });
    expect((await h.join(eventId, "u1")).body).toEqual({ status: "SOLD_OUT" });
    expect((await h.status(eventId, "u1")).body).toEqual({ status: "SOLD_OUT" });
    expect(await queued(eventId)).toEqual(["u1", "u2", "u3"]);

    await until(
      "the SOLD_OUT gauge",
      async () => (await metricValue(eventState, { event: eventId, state: "SOLD_OUT" })) === 1,
    );
    expect(await metricValue(eventState, { event: eventId, state: "PAUSED" })).toBe(0);
    await admitter.stop();
  });

  it("resumes from PAUSED when a hold is released back to stock", async () => {
    const { eventId } = await h.seedEvent({ stock: 0 });
    await h.redis.zadd(holdsKey(eventId), Date.now() + 600_000, "some-hold");
    const users = userIds("u", 30);
    for (const userId of users) {
      await h.join(eventId, userId);
    }

    const admitter = h.newAdmitter();
    admitter.start();
    await until("PAUSED", async () => (await h.redis.get(stateKey(eventId))) === "PAUSED");
    expect(await admittedCount(eventId)).toBe(0);

    // What release.lua does when a hold expires: the hold leaves the set and its units return.
    await h.redis.multi().zrem(holdsKey(eventId), "some-hold").incrby(availKey(eventId), 2).exec();
    await until("everyone admitted", async () => (await admittedCount(eventId)) === 30);
    expect(await h.redis.get(stateKey(eventId))).toBe("OPEN");
    await admitter.stop();
  });

  it("leaves an event alone while its stock key does not exist", async () => {
    const { eventId } = await h.seedEvent({ stock: null });
    for (const userId of ["u1", "u2"]) {
      await h.join(eventId, userId);
    }

    const admitter = h.newAdmitter();
    admitter.start();
    await sleep(500);
    // admit.lua would have read the missing key as 0 and written SOLD_OUT. It was never run.
    expect(await h.redis.exists(stateKey(eventId))).toBe(0);
    expect(await admittedCount(eventId)).toBe(0);
    expect((await h.status(eventId, "u1")).body).toMatchObject({ status: "QUEUED", state: "OPEN" });

    // Stock arrives (the ticket service's /redis/reset): admission starts within a second or so.
    await h.redis.set(availKey(eventId), "100");
    await until("both admitted", async () => (await admittedCount(eventId)) === 2);
    await admitter.stop();
  });

  it("11. resumes after a restart with nobody lost or duplicated", async () => {
    const { eventId } = await h.seedEvent({ admitRatePerSec: 50 });
    const early = userIds("early", 60);
    const later = userIds("later", 40);
    await Promise.all(early.map((userId) => h.join(eventId, userId)));

    const first = h.newAdmitter();
    first.start();
    await until("the first admissions", async () => (await admittedCount(eventId)) >= 10);
    await first.stop();

    // Stopped mid-run. People keep joining, and nobody is admitted meanwhile.
    const stoppedAt = await admittedCount(eventId);
    expect(stoppedAt).toBeLessThan(60);
    await Promise.all(later.map((userId) => h.join(eventId, userId)));
    await sleep(300);
    expect(await admittedCount(eventId)).toBe(stoppedAt);
    await expectConserved(eventId, [...early, ...later]);

    // A new admitter knows nothing of the old one; the queue in Redis is all the state there is.
    const second = h.newAdmitter();
    second.start();
    await until("admissions to resume", async () => (await admittedCount(eventId)) > stoppedAt);
    await expectConserved(eventId, [...early, ...later]);
    await until("everyone admitted", async () => (await admittedCount(eventId)) === 100, 8_000);
    await second.stop();

    expect(await queued(eventId)).toEqual([]);
    await expectConserved(eventId, [...early, ...later]);
  }, 20_000);

  it("13. cleans up admissions that expired over a minute ago, and only those", async () => {
    const { eventId } = await h.seedEvent({ admitTtlSec: 120 });
    const now = await h.redisNow();
    const stale = userIds("stale", 1_200);
    const expired = userIds("expired", 50);
    const live = userIds("live", 300);

    const pipeline = h.redis.pipeline();
    for (const userId of stale) {
      // Past ttl + 60s.
      pipeline.hset(admittedKey(eventId), userId, now - 185_000);
    }
    for (const userId of expired) {
      // Turn over, but inside the minute of grace: status still answers EXPIRED for these.
      pipeline.hset(admittedKey(eventId), userId, now - 150_000);
    }
    for (const userId of live) {
      pipeline.hset(admittedKey(eventId), userId, now - 1_000);
    }
    await pipeline.exec();

    const removed = await h.newAdmitter().cleanup();
    expect(removed).toBe(1_200);

    const left = await admittedUsers(eventId);
    expect(left.sort()).toEqual([...expired, ...live].sort());
    expect((await h.status(eventId, "expired-0000")).body).toEqual({ status: "EXPIRED" });
    expect((await h.status(eventId, "stale-0000")).body).toEqual({ status: "NOT_IN_QUEUE" });
  });

  it("samples the queue depth for each event", async () => {
    const { eventId } = await h.seedEvent();
    for (const userId of userIds("u", 7)) {
      await h.join(eventId, userId);
    }
    await h.newAdmitter().sampleDepth();
    expect(await metricValue(queueDepth, { event: eventId })).toBe(7);
  });
});
