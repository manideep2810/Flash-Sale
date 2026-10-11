import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import { Redis } from "ioredis";

const PING_TIMEOUT_MS = 1_000;

/**
 * A Redis call failed. The HTTP layer answers it with 503 QUEUE_UNAVAILABLE: with Redis away nobody
 * can be queued or admitted, and the queue never falls back to letting people through.
 */
export class QueueUnavailableError extends Error {
  constructor(cause: unknown) {
    super("the queue's Redis is unavailable", { cause });
    this.name = "QueueUnavailableError";
  }
}

/**
 * A client that fails at once while Redis is away, instead of holding commands until it returns.
 *
 * ioredis's default is to park a command issued while disconnected and give up only after
 * maxRetriesPerRequest reconnect attempts, which was measured here at 6 to 20 seconds per request
 * with Redis stopped. A caller polling the queue should get its 503 now, and the admitter's next tick
 * is what should try again, so:
 *   - enableOfflineQueue: false rejects a command issued while the connection is down;
 *   - maxRetriesPerRequest: 0 rejects the commands that were in flight when it dropped.
 * Reconnecting itself is unaffected: ioredis keeps retrying in the background for as long as it takes.
 *
 * The same applies before the first connection, so nothing can be sent until "ready" (see onReady).
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 0 });
}

/**
 * Runs `task` every time the connection becomes usable: once at startup and again after each
 * reconnect. Both processes load the Lua scripts this way, which also puts them back after a Redis
 * restart has emptied its script cache.
 */
export function onReady(redis: Redis, task: () => void): void {
  redis.on("ready", task);
}

/**
 * Logs an outage once when it starts and once when it ends. ioredis reports every failed reconnect
 * attempt as an "error" event, and with no listener at all those are printed to stderr as unhandled.
 */
export function logConnection(redis: Redis, logger: Logger): void {
  let down = false;
  redis.on("error", (error: Error & { code?: string }) => {
    if (!down) {
      down = true;
      // A refused connection arrives as an AggregateError whose message is empty; its code is not.
      logger.warn("redis connection lost, reconnecting", {
        error: error.message || error.code || String(error),
      });
    }
  });
  redis.on("ready", () => {
    logger.info(down ? "redis connection restored" : "redis connected");
    down = false;
  });
}

/** True when the connection is up and Redis answers a PING within a second. Never rejects. */
export async function redisReachable(redis: Redis): Promise<boolean> {
  if (redis.status !== "ready") {
    return false;
  }
  try {
    const reply = await Promise.race([
      redis.ping(),
      sleep(PING_TIMEOUT_MS, "TIMEOUT", { ref: false }),
    ]);
    return reply === "PONG";
  } catch {
    return false;
  }
}

export type { Redis } from "ioredis";
