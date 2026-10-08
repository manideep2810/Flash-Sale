import type { Logger } from "@flash/observability";
import { every } from "./every.js";
import { producer, TOPIC, toKafkaMessage } from "./producer.js";
import { auxRedis } from "./redis.js";
import { activeStreams, CONSUMER, ensureGroups, GROUP } from "./streams.js";

const BATCH = 500;
const AUTOCLAIM_INTERVAL_MS = 30_000;
/** Longer than any healthy send takes, so a batch the loop is still producing is not claimed. */
const AUTOCLAIM_MIN_IDLE_MS = 60_000;

type PendingEntry = [id: string, fields: string[] | null];

/** Produce, then ack: the same order as the loop, so a failure in between resends, never drops. */
async function resend(stream: string, entries: PendingEntry[]): Promise<void> {
  // A pending id whose entry is no longer in the stream comes back with null fields. There is
  // nothing left to send, so it is only acked to clear it from the pending list.
  const messages = entries.flatMap(([id, fields]) =>
    fields ? [toKafkaMessage(stream, id, fields)] : [],
  );
  if (messages.length > 0) {
    await producer.send({ topic: TOPIC, messages });
  }
  await auxRedis.xack(stream, GROUP, ...entries.map(([id]) => id));
}

/**
 * Runs at the top of the loop: creates any missing consumer group, then resends the entries this
 * consumer read and never acked.
 */
export async function recoverPending(): Promise<void> {
  const streams = await activeStreams();
  await ensureGroups(streams);
  for (const stream of streams) {
    // Reading from id 0 instead of > returns this consumer's own pending entries rather than new
    // ones. Acked entries leave the pending list, so reading from 0 again walks it until it is empty.
    for (;;) {
      const reply = await auxRedis.xreadgroup(
        "GROUP",
        GROUP,
        CONSUMER,
        "COUNT",
        BATCH,
        "STREAMS",
        stream,
        "0",
      );
      const entries = reply?.[0]?.[1] ?? [];
      if (entries.length === 0) {
        break;
      }
      await resend(stream, entries);
    }
  }
}

/** Takes over entries another consumer read and has left unacked for a minute, and resends them. */
async function claimAbandoned(): Promise<void> {
  const streams = await activeStreams();
  await ensureGroups(streams);
  for (const stream of streams) {
    let cursor = "0-0";
    do {
      const [next, entries] = (await auxRedis.xautoclaim(
        stream,
        GROUP,
        CONSUMER,
        AUTOCLAIM_MIN_IDLE_MS,
        cursor,
        "COUNT",
        BATCH,
      )) as [next: string, entries: PendingEntry[], deleted?: string[]];
      if (entries.length > 0) {
        await resend(stream, entries);
      }
      cursor = next;
    } while (cursor !== "0-0");
  }
}

/** Starts the 30s XAUTOCLAIM sweep. Returns a function that stops it. */
export function startRecovery(logger: Logger): () => void {
  return every(AUTOCLAIM_INTERVAL_MS, "recovery sweep", logger, claimAbandoned);
}
