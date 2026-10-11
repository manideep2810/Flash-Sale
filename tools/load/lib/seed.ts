// Seeding one event for a run, straight into Redis: its waiting room, and its stock through the
// ticket service. Used by the load tools here and by ../../seed-queue-event.ts.
//
// An event seeded this way has no entry in the catalogue (the ticket service's Event table), so it
// is not on the web app's front page. That is what a load run wants: a fresh event id every run,
// with nothing left over from the one before.

import type { Redis } from "ioredis";

// The queue's key names (services/queue/src/redis/keys.ts) and the ticket service's
// (reserveKeys() in services/ticket/src/redis/index.ts), kept in step with them by hand.
export const QUEUE_EVENTS = "queue:events";
export const ACTIVE_EVENTS = "events:active";
export const keysOf = (eventId: string) => ({
  config: `ev:${eventId}:config`,
  queue: `ev:${eventId}:queue`,
  admitted: `ev:${eventId}:admitted`,
  state: `ev:${eventId}:state`,
  avail: `ev:${eventId}:avail`,
  total: `ev:${eventId}:total`,
  held: `ev:${eventId}:held`,
  sold: `ev:${eventId}:sold`,
  holds: `ev:${eventId}:holds`,
  stream: `ev:${eventId}:stream`,
});

export interface WaitingRoomSeed {
  eventId: string;
  /** Epoch ms. */
  lobbyOpensAt: number;
  /** Epoch ms. */
  saleOpensAt: number;
  admitRatePerSec: number;
  admitTtlSec: number;
  name?: string;
  /** Per ticket, in the smallest currency unit: what the order service charges, times the quantity. */
  price?: number;
}

/**
 * Writes the event's config hash, lists it for the admitter and empties its queue, admitted and
 * state keys, in one MULTI. Stock is not touched: see seedStock().
 */
export async function seedWaitingRoom(redis: Redis, seed: WaitingRoomSeed): Promise<void> {
  const keys = keysOf(seed.eventId);
  const replies = await redis
    .multi()
    .del(keys.queue, keys.admitted, keys.state)
    .hset(keys.config, {
      lobbyOpensAt: String(Math.round(seed.lobbyOpensAt)),
      saleOpensAt: String(Math.round(seed.saleOpensAt)),
      admitRatePerSec: String(seed.admitRatePerSec),
      admitTtlSec: String(Math.round(seed.admitTtlSec)),
      ...(seed.name === undefined ? {} : { name: seed.name }),
      ...(seed.price === undefined ? {} : { price: String(Math.round(seed.price)) }),
    })
    .sadd(QUEUE_EVENTS, seed.eventId)
    .exec();
  if (!replies) {
    throw new Error("seed transaction was aborted");
  }
  for (const [error] of replies) {
    if (error) {
      throw error;
    }
  }
}

/**
 * The Phase 2 stock seed: POST /redis/reset on the ticket service, which puts `total` on sale with
 * no holds and marks the event active for the relay. Called on the service directly, not through
 * the gateway, which does not route it.
 */
export async function seedStock(ticketUrl: string, eventId: string, total: number): Promise<void> {
  const res = await fetch(`${ticketUrl}/redis/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId, total }),
  });
  if (!res.ok) {
    throw new Error(`POST ${ticketUrl}/redis/reset answered ${res.status}: ${await res.text()}`);
  }
}

/**
 * Takes the event off the admitter's list (and the relay's), leaving every one of its keys in place
 * to look at. An event left listed costs the admitter a script call every tick, for good.
 */
export async function unlistEvent(redis: Redis, eventId: string): Promise<void> {
  await redis.multi().srem(QUEUE_EVENTS, eventId).srem(ACTIVE_EVENTS, eventId).exec();
}

/**
 * How far Redis's clock is ahead of this process's, in ms (negative: behind). admit.lua and
 * join.lua stamp with Redis's clock, the tools stamp with their own, and the order checker has to
 * put the two on one line. The best of five samples; `uncertaintyMs` is half that sample's round trip.
 */
export async function redisClockOffset(
  redis: Redis,
): Promise<{ offsetMs: number; uncertaintyMs: number }> {
  let best = { offsetMs: 0, uncertaintyMs: Number.POSITIVE_INFINITY };
  for (let i = 0; i < 5; i++) {
    const sent = Date.now();
    const [seconds, micros] = await redis.time();
    const received = Date.now();
    const redisMs = Number(seconds) * 1000 + Number(micros) / 1000;
    const uncertaintyMs = (received - sent) / 2;
    if (uncertaintyMs < best.uncertaintyMs) {
      best = { offsetMs: redisMs - (sent + received) / 2, uncertaintyMs };
    }
  }
  return best;
}
