import { auxRedis } from "./redis.js";

export const GROUP = "relay";
export const CONSUMER = `relay-${process.pid}`;

/** Set of event ids whose reservation streams the relay reads. */
export const ACTIVE_EVENTS = "events:active";

/**
 * Must match reserveKeys() in services/ticket/src/redis/index.ts, which writes the stream under an
 * untagged name. If the ticket service moves to hash-tagged keys for Redis Cluster, this moves too.
 */
export function streamKey(eventId: string): string {
  return `ev:${eventId}:stream`;
}

export async function activeStreams(): Promise<string[]> {
  return (await auxRedis.smembers(ACTIVE_EVENTS)).map(streamKey);
}

/**
 * Creates the relay's consumer group on each stream that does not have it yet.
 *
 * The group starts at 0, not $: entries reserved before the relay first saw the stream are exactly
 * the ones an outbox must not skip. MKSTREAM covers an event that is active before its first reserve.
 *
 * Deliberately not remembered between calls. A consumer group lives inside its stream key, so deleting
 * the key (POST /redis/reset does) deletes the group with it, and a cache would never recreate it.
 */
export async function ensureGroups(streams: string[]): Promise<void> {
  for (const stream of streams) {
    try {
      await auxRedis.xgroup("CREATE", stream, GROUP, "0", "MKSTREAM");
    } catch (error) {
      // BUSYGROUP is Redis saying the group already exists, which is the outcome we wanted.
      if (!(error instanceof Error && error.message.startsWith("BUSYGROUP"))) {
        throw error;
      }
    }
  }
}
