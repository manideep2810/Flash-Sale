import { heldKey, type RedisPool, reserveKeys, resetEvent, soldKey } from "../redis/index.js";
import type { EventRecord } from "./store.js";

// The Redis half of an event: its stock counters (this service's own keys) and its waiting room (the
// queue service's keys). The catalogue row in Postgres is the source of truth; what is written here
// is the copy the hot path reads, so that reserving and queueing never touch Postgres.
//
// The four names below belong to the queue service and must match services/queue/src/redis/keys.ts.
const QUEUE_EVENTS = "queue:events";
const configKey = (eventId: string): string => `ev:${eventId}:config`;
const queueKey = (eventId: string): string => `ev:${eventId}:queue`;
const admittedKey = (eventId: string): string => `ev:${eventId}:admitted`;
const stateKey = (eventId: string): string => `ev:${eventId}:state`;

/** What the admitter last found for an event (admit.lua writes it); OPEN until it has run. */
export type QueueState = "OPEN" | "PAUSED" | "SOLD_OUT";

/** An event's numbers right now. */
export interface LiveCounts {
  /** Tickets nobody holds or has bought. Null when the event has no stock key in Redis. */
  available: number | null;
  /** Tickets in someone's checkout, not yet paid for. */
  held: number;
  /** Tickets paid for. */
  sold: number;
  queueState: QueueState;
  /** People waiting in line. */
  queued: number;
  /** People whose turn it is now. */
  admitted: number;
}

export interface EventLive {
  /** One round trip for all of `ids`. */
  read(ids: readonly string[]): Promise<Map<string, LiveCounts>>;
  /**
   * Puts a new event on sale: stock at `totalStock` with no holds, an empty waiting room, and the
   * event listed for the admitter and the relay. Whatever those keys held before is gone.
   */
  open(event: EventRecord): Promise<void>;
  /** Rewrites the waiting room's config from the row. Stock, holds and the line are left alone. */
  configure(event: EventRecord): Promise<void>;
}

/** The waiting room's config hash, as services/queue/src/config/events.ts reads it. */
function configOf(event: EventRecord): Record<string, string> {
  return {
    lobbyOpensAt: String(event.lobbyOpensAt.getTime()),
    saleOpensAt: String(event.saleOpensAt.getTime()),
    admitRatePerSec: String(event.admitRatePerSec),
    admitTtlSec: String(event.admitTtlSec),
    name: event.name,
    // Also what the order service charges per ticket (services/order/src/redis/index.ts).
    price: String(event.price),
  };
}

type Replies = [error: Error | null, result: unknown][] | null;

function resultsOf(replies: Replies, what: string): unknown[] {
  if (!replies) {
    throw new Error(`${what} was aborted`);
  }
  return replies.map(([error, result]) => {
    if (error) {
      throw error;
    }
    return result;
  });
}

const count = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const COMMANDS_PER_EVENT = 6;

export function createEventLive(pool: RedisPool): EventLive {
  return {
    async read(ids) {
      const counts = new Map<string, LiveCounts>();
      if (ids.length === 0) {
        return counts;
      }
      const pipeline = pool.next().pipeline();
      for (const id of ids) {
        const [availKey] = reserveKeys(id);
        pipeline
          .get(availKey)
          .get(heldKey(id))
          .get(soldKey(id))
          .get(stateKey(id))
          .zcard(queueKey(id))
          .hlen(admittedKey(id));
      }
      const results = resultsOf(await pipeline.exec(), "the live read");
      ids.forEach((id, index) => {
        const [available, held, sold, state, queued, admitted] = results.slice(
          index * COMMANDS_PER_EVENT,
          (index + 1) * COMMANDS_PER_EVENT,
        );
        counts.set(id, {
          available: available === null || available === undefined ? null : count(available),
          held: count(held),
          sold: count(sold),
          queueState: state === "PAUSED" || state === "SOLD_OUT" ? state : "OPEN",
          queued: count(queued),
          admitted: count(admitted),
        });
      });
      return counts;
    },

    async open(event) {
      // Stock first: the admitter leaves an event alone until its stock key exists, so a waiting room
      // that appears a moment before its stock would only wait.
      await resetEvent(pool, event.id, event.totalStock);
      const replies = await pool
        .next()
        .multi()
        .del(queueKey(event.id), admittedKey(event.id), stateKey(event.id))
        .hset(configKey(event.id), configOf(event))
        .sadd(QUEUE_EVENTS, event.id)
        .exec();
      resultsOf(replies, "opening the waiting room");
    },

    async configure(event) {
      const replies = await pool
        .next()
        .multi()
        .hset(configKey(event.id), configOf(event))
        .sadd(QUEUE_EVENTS, event.id)
        .exec();
      resultsOf(replies, "writing the waiting room's config");
    },
  };
}
