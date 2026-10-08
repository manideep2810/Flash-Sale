import { createLogger } from "@flash/observability";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Needs the same dedicated test schema as payment-flow.test.ts (a `_test` schema, because every test
// empties the Order table) and the local Redis: `make test-order-db`. The Redis keys it touches are
// all under the event id below. Skipped when DATABASE_URL or REDIS_URL is unset.
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const schema = DATABASE_URL ? new URL(DATABASE_URL).searchParams.get("schema") : null;
const enabled = Boolean(DATABASE_URL) && Boolean(REDIS_URL) && Boolean(schema?.endsWith("_test"));

const EVENT_ID = "evt-settle-test";
const TOTAL = 10;
const logger = createLogger({ service: "order", level: "silent" });

describe.skipIf(!enabled)("hold settlement, against Postgres and Redis", () => {
  // Loaded here, not at the top: src/config.ts reads the environment as soon as it is imported.
  let prisma: typeof import("../src/db.js").prisma;
  let orderTable: typeof import("../src/db.js").ORDER_TABLE;
  let orderState: typeof import("../src/db.js").ORDER_STATE_TYPE;
  let settleModule: typeof import("../src/services/settle.js");
  let sweeper: typeof import("../src/services/settlement-sweeper.js");
  let metrics: typeof import("../src/metrics.js");
  let redisModule: typeof import("../src/redis/index.js");
  let redis: Redis;
  let holds: import("../src/redis/index.js").HoldStore;

  /** Quantity of every hold the current test created, so I1 can be computed after it. */
  const held = new Map<string, number>();

  beforeAll(async () => {
    process.env.KAFKA_BROKERS ??= "localhost:19092";
    process.env.PORT ??= "3003";
    process.env.LOG_LEVEL ??= "error";
    ({
      prisma,
      ORDER_TABLE: orderTable,
      ORDER_STATE_TYPE: orderState,
    } = await import("../src/db.js"));
    settleModule = await import("../src/services/settle.js");
    sweeper = await import("../src/services/settlement-sweeper.js");
    metrics = await import("../src/metrics.js");
    redisModule = await import("../src/redis/index.js");
    redis = redisModule.createRedis(String(REDIS_URL));
    holds = redisModule.createHoldStore(redis);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    redis?.disconnect();
  });

  const keys = () => [
    redisModule.availKey(EVENT_ID),
    redisModule.holdsKey(EVENT_ID),
    redisModule.soldKey(EVENT_ID),
    redisModule.heldKey(EVENT_ID),
  ];

  beforeEach(async () => {
    held.clear();
    await prisma.order.deleteMany();
    await redis.del(...keys());
    await redis.set(redisModule.availKey(EVENT_ID), String(TOTAL));
  });

  /** What reserve.lua does for one hold, plus the order row Phase 3 would create for it. */
  async function reserve(id: string, qty: number, state: string): Promise<void> {
    await redis.decrby(redisModule.availKey(EVENT_ID), qty);
    await redis.incrby(redisModule.heldKey(EVENT_ID), qty); // reserve.lua does both in one step
    await redis.zadd(redisModule.holdsKey(EVENT_ID), String(Date.now() + 600_000), id);
    held.set(id, qty);
    await prisma.$executeRaw`
      INSERT INTO ${orderTable} (id, "eventId", "userId", qty, state, "expiresAt", "updatedAt")
      VALUES (${id}, ${EVENT_ID}, 'u', ${qty}, ${state}::${orderState},
              (now() AT TIME ZONE 'UTC') + interval '10 minutes', (now() AT TIME ZONE 'UTC'))`;
  }

  const num = async (key: string) => Number((await redis.get(key)) ?? 0);
  const avail = () => num(redisModule.availKey(EVENT_ID));
  const sold = () => num(redisModule.soldKey(EVENT_ID));
  const heldCounter = () => num(redisModule.heldKey(EVENT_ID));
  const stillHeld = async () => {
    let total = 0;
    for (const id of await redis.zrange(redisModule.holdsKey(EVENT_ID), "0", "-1")) {
      total += held.get(id) ?? 0;
    }
    return total;
  };
  const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const backdate = (seconds: number) => prisma.$executeRaw`
    UPDATE ${orderTable}
       SET "updatedAt" = (now() AT TIME ZONE 'UTC') - ${seconds} * interval '1 second'`;

  /**
   * I1: avail + held + sold = total, all from Redis, and the held counter equals the quantity of the
   * holds still in the ZSET. Checked after every test.
   */
  afterEach(async () => {
    if (!enabled) {
      return;
    }
    expect((await avail()) + (await heldCounter()) + (await sold())).toBe(TOTAL);
    expect(await heldCounter()).toBe(await stillHeld());
  });

  it("an expired order: avail restored by exactly its qty, order RELEASED", async () => {
    await reserve("h1", 3, "EXPIRED");
    expect(await avail()).toBe(7);

    expect(await settleModule.settle("h1", holds, logger)).toBe("released");

    expect(await avail()).toBe(10);
    expect(await stillHeld()).toBe(0);
    const row = await order("h1");
    expect(row.state).toBe("RELEASED");
    expect(row.holdSettledAt).not.toBeNull();
  });

  it("the same OrderExpired delivered 3 times: avail restored once", async () => {
    await reserve("h1", 3, "EXPIRED");
    await reserve("h2", 2, "HELD"); // someone else's hold must not move

    for (let i = 0; i < 3; i++) {
      await settleModule.settle("h1", holds, logger);
    }

    expect(await avail()).toBe(8); // 10 - 2 (h2) after h1's 3 came back, once
    expect(await stillHeld()).toBe(2);
  });

  it("a PAYMENT_FAILED order is released like an expired one", async () => {
    await reserve("h1", 4, "PAYMENT_FAILED");
    expect(await settleModule.settle("h1", holds, logger)).toBe("released");
    expect(await avail()).toBe(10);
    expect((await order("h1")).state).toBe("RELEASED");
  });

  it("a PAID order: sold += qty, held -= qty, avail unchanged, state stays PAID", async () => {
    await reserve("h1", 3, "PAID");
    const availBefore = await avail();

    expect(await settleModule.settle("h1", holds, logger)).toBe("confirmed");
    expect(await settleModule.settle("h1", holds, logger)).toBe("settled"); // and a repeat is a no-op

    expect(await sold()).toBe(3);
    expect(await stillHeld()).toBe(0);
    expect(await avail()).toBe(availBefore);
    const row = await order("h1");
    expect(row.state).toBe("PAID");
    expect(row.holdSettledAt).not.toBeNull();
  });

  it("a crash after the Redis call but before the DB update: the sweeper finishes it, with no double release", async () => {
    await reserve("h1", 3, "EXPIRED");
    // The "crash": Redis was updated, Postgres never was.
    expect(await holds.release({ eventId: EVENT_ID, holdId: "h1", qty: 3 })).toBe(true);
    expect(await avail()).toBe(10);
    expect((await order("h1")).state).toBe("EXPIRED");

    await backdate(31);
    expect((await sweeper.sweepUnsettled(logger, holds)).settled).toBe(1);
    expect((await sweeper.sweepUnsettled(logger, holds)).settled).toBe(0); // nothing left

    expect(await avail()).toBe(10); // not 13
    expect((await order("h1")).state).toBe("RELEASED");
  });

  it("the sweeper leaves alone anything that is fresh, already settled, or not terminal", async () => {
    await reserve("fresh", 1, "EXPIRED"); // too young: the fast path gets first go
    await reserve("held", 1, "HELD");
    await reserve("pending", 1, "PAYMENT_PENDING");
    await prisma.$executeRaw`
      UPDATE ${orderTable} SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '31 seconds'
       WHERE id IN ('held', 'pending')`;

    expect((await sweeper.sweepUnsettled(logger, holds)).settled).toBe(0);
    expect(await avail()).toBe(7);
  });

  it("confirming a PAID order whose hold is already gone is reported loudly, and still marked settled", async () => {
    await reserve("h1", 3, "PAID");
    await redis.zrem(redisModule.holdsKey(EVENT_ID), "h1"); // removed from under the paid order
    held.delete("h1");
    await redis.decrby(redisModule.heldKey(EVENT_ID), 3); // keep I1 about the rest of the system
    await redis.incrby(redisModule.availKey(EVENT_ID), 3);

    const before = (await metrics.holdMissingOnConfirm.get()).values[0]?.value ?? 0;
    expect(await settleModule.settle("h1", holds, logger)).toBe("settled");
    const after = (await metrics.holdMissingOnConfirm.get()).values[0]?.value ?? 0;

    expect(after).toBe(before + 1);
    expect(await sold()).toBe(0);
    expect((await order("h1")).holdSettledAt).not.toBeNull();
  });
});
