// What Redis holds for one event: who is in its queue, who is admitted, its state and its stock
// counters. The simulator saves this the moment a run ends, and the order checker judges the run
// against that picture. A picture taken later would be missing people: the admitter removes a
// user from the admitted hash a minute after their turn has expired.

import type { Redis } from "ioredis";
import { keysOf } from "./seed.js";

export interface RedisState {
  /** This machine's clock, ms. */
  takenAt: number;
  /** OPEN, PAUSED or SOLD_OUT, as admit.lua last wrote it; null until it has run for the event. */
  state: string | null;
  /** The queue zset: [userId, score]. */
  queued: [string, number][];
  /** The admitted hash: [userId, admittedAt on Redis's clock]. */
  admitted: [string, number][];
  stock: { avail: number | null; total: number | null; held: number; sold: number; holds: number };
}

/** Read in pages: a run can leave tens of thousands of users in either structure. */
const PAGE = 5_000;

async function pairs(
  scan: (cursor: string) => Promise<[cursor: string, entries: string[]]>,
): Promise<[string, number][]> {
  const found = new Map<string, number>();
  let cursor = "0";
  do {
    const [next, entries] = await scan(cursor);
    for (let i = 0; i + 1 < entries.length; i += 2) {
      found.set(String(entries[i]), Number(entries[i + 1]));
    }
    cursor = next;
  } while (cursor !== "0");
  return [...found];
}

const numberOrNull = (value: string | null): number | null =>
  value === null ? null : Number(value);

export async function readRedisState(redis: Redis, eventId: string): Promise<RedisState> {
  const keys = keysOf(eventId);
  const [queued, admitted, state, avail, total, held, sold, holds] = await Promise.all([
    pairs((cursor) => redis.zscan(keys.queue, cursor, "COUNT", PAGE)),
    pairs((cursor) => redis.hscan(keys.admitted, cursor, "COUNT", PAGE)),
    redis.get(keys.state),
    redis.get(keys.avail),
    redis.get(keys.total),
    redis.get(keys.held),
    redis.get(keys.sold),
    redis.zcard(keys.holds),
  ]);
  return {
    takenAt: Date.now(),
    state,
    queued,
    admitted,
    stock: {
      avail: numberOrNull(avail),
      total: numberOrNull(total),
      held: Number(held ?? 0),
      sold: Number(sold ?? 0),
      holds,
    },
  };
}
