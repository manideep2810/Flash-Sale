import { setTimeout as sleep } from "node:timers/promises";
import { Redis } from "ioredis";
import { config } from "./config.js";

const PING_TIMEOUT_MS = 1_000;

// Both connections open as soon as this module is imported and ioredis keeps retrying them for as
// long as Redis is away, so nothing here has to be awaited at startup.
function connect(): Redis {
  return new Redis(config.REDIS_URL, {
    // Fail a command after a few reconnect attempts instead of parking it for the whole outage; the
    // caller's retry (the loop supervisor, the next timer tick) is what should decide to try again.
    maxRetriesPerRequest: 3,
  });
}

/** The loop's connection. XREADGROUP BLOCK parks it for up to a second at a time. */
export const redis: Redis = connect();

/**
 * Everything else: recovery, trimming, metrics and the readiness ping. A command sent on a connection
 * that is parked in a blocking read waits for that read to return, so these get their own socket.
 */
export const auxRedis: Redis = connect();

/** True when both connections are up and Redis answers a PING within a second. */
export async function redisReachable(): Promise<boolean> {
  if (redis.status !== "ready" || auxRedis.status !== "ready") {
    return false;
  }
  try {
    const reply = await Promise.race([
      auxRedis.ping(),
      sleep(PING_TIMEOUT_MS, "TIMEOUT", { ref: false }),
    ]);
    return reply === "PONG";
  } catch {
    return false;
  }
}
