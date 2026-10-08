import { createLogger } from "@flash/observability";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRedisPool,
  createReserveScript,
  heldKey,
  type RedisPool,
  reserveKeys,
  resetEvent,
  soldKey,
} from "../src/redis/index.js";

// reserve.lua keeps a `held` counter next to avail, in the same atomic step, so avail + held + sold =
// total at every instant. Needs the local Redis: `REDIS_URL=redis://localhost:6380 pnpm test`.
// Skipped when REDIS_URL is unset so plain `pnpm test` stays green.
const REDIS_URL = process.env.REDIS_URL;
const EVENT_ID = "held-counter-test";

describe.skipIf(!REDIS_URL)("reserve.lua held counter", () => {
  let pool: RedisPool;
  let reserve: Awaited<ReturnType<typeof createReserveScript>>["reserve"];

  beforeAll(async () => {
    pool = createRedisPool({ REDIS_URL, REDIS_POOL: "1" } as NodeJS.ProcessEnv);
    await pool.ready();
    ({ reserve } = await createReserveScript({
      pool,
      logger: createLogger({ service: "ticket", level: "silent" }),
      holdTtlMs: 600_000,
    }));
    await resetEvent(pool, EVENT_ID, 10);
  });

  afterAll(async () => {
    const [avail, holds, stream, held] = reserveKeys(EVENT_ID);
    await pool.next().del(avail, holds, stream, held, soldKey(EVENT_ID), `ev:${EVENT_ID}:total`);
    await pool.next().srem("events:active", EVENT_ID);
    await pool.quit();
  });

  const read = async () => {
    const redis = pool.next();
    const [avail, held, sold] = await Promise.all([
      redis.get(reserveKeys(EVENT_ID)[0]),
      redis.get(heldKey(EVENT_ID)),
      redis.get(soldKey(EVENT_ID)),
    ]);
    return { avail: Number(avail ?? 0), held: Number(held ?? 0), sold: Number(sold ?? 0) };
  };

  it("adds the reserved quantity to held in the same step that takes it from avail", async () => {
    expect(await read()).toEqual({ avail: 10, held: 0, sold: 0 });

    expect((await reserve(EVENT_ID, "u1", 3)).ok).toBe(true);
    expect(await read()).toEqual({ avail: 7, held: 3, sold: 0 });

    expect((await reserve(EVENT_ID, "u2", 2)).ok).toBe(true);
    expect(await read()).toEqual({ avail: 5, held: 5, sold: 0 });
  });

  it("leaves held alone when the reserve is refused", async () => {
    const before = await read();
    expect(await reserve(EVENT_ID, "u3", 99)).toEqual({ ok: false, reason: "SOLD_OUT" });
    expect(await read()).toEqual(before);
  });

  it("is cleared by a reset", async () => {
    await resetEvent(pool, EVENT_ID, 10);
    expect(await read()).toEqual({ avail: 10, held: 0, sold: 0 });
  });
});
