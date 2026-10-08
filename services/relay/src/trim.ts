import type { Logger } from "@flash/observability";
import { every } from "./every.js";
import { auxRedis } from "./redis.js";
import { activeStreams, GROUP } from "./streams.js";

const TRIM_INTERVAL_MS = 60_000;

/** The relay group's last-delivered-id, or undefined when the stream or the group does not exist. */
async function lastDeliveredId(stream: string): Promise<string | undefined> {
  let groups: unknown;
  try {
    groups = await auxRedis.xinfo("GROUPS", stream);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such key")) {
      return undefined;
    }
    throw error;
  }
  // Each group is a flat [field, value, field, value, ...] list.
  for (const group of groups as unknown[][]) {
    if (group[group.indexOf("name") + 1] === GROUP) {
      return String(group[group.indexOf("last-delivered-id") + 1]);
    }
  }
  return undefined;
}

/**
 * Drops every entry the relay has finished with: everything below the oldest pending id, or below
 * the last delivered id when nothing is pending. Returns how many entries were removed.
 *
 * The two reads are in this order on purpose. If the pending summary came first, entries delivered
 * between the reads would move last-delivered-id past ids that are still unacked, and trimming to it
 * would delete them. Read this way round, a last-delivered-id that is already stale can only make
 * the trim more conservative.
 */
async function trimStream(stream: string): Promise<number> {
  const lastDelivered = await lastDeliveredId(stream);
  if (lastDelivered === undefined) {
    return 0;
  }
  const [pending, oldestPending] = (await auxRedis.xpending(stream, GROUP)) as [
    count: number,
    oldest: string | null,
    ...rest: unknown[],
  ];
  const minId = pending > 0 && oldestPending ? oldestPending : lastDelivered;
  if (minId === "0-0") {
    return 0;
  }
  // MINID removes ids strictly below the threshold, so the oldest pending entry itself stays.
  return auxRedis.xtrim(stream, "MINID", minId);
}

/** Starts the 60s trim of every active stream. Returns a function that stops it. */
export function startTrim(logger: Logger): () => void {
  return every(TRIM_INTERVAL_MS, "stream trim", logger, async () => {
    for (const stream of await activeStreams()) {
      try {
        const removed = await trimStream(stream);
        if (removed > 0) {
          logger.debug("stream trimmed", { stream, removed });
        }
      } catch (error) {
        // One stream failing should not stop the others from being trimmed.
        logger.error("stream trim failed", { stream, error: String(error) });
      }
    }
  });
}
