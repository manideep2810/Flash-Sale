import { producer, TOPIC, toKafkaMessage } from "./producer.js";
import { recoverPending } from "./recovery.js";
import { redis } from "./redis.js";
import { ACTIVE_EVENTS, CONSUMER, GROUP, streamKey } from "./streams.js";

let shuttingDown = false;

/** Lets run() finish the batch it is on and return; a parked XREADGROUP wakes within its 1s BLOCK. */
export function stop(): void {
  shuttingDown = true;
}

export async function run(): Promise<void> {
  await recoverPending(); // 1. resend anything left from a crash
  while (!shuttingDown) {
    const streams = await redis.smembers(ACTIVE_EVENTS);
    const batch = await redis.xreadgroup(
      "GROUP",
      GROUP,
      CONSUMER,
      "COUNT",
      500,
      "BLOCK",
      1000,
      "STREAMS",
      ...streams.map(streamKey),
      ...streams.map(() => ">"),
    );
    if (!batch) continue;
    for (const [stream, entries] of batch) {
      const messages = entries.map(([entryId, fields]) => toKafkaMessage(stream, entryId, fields));
      await producer.send({ topic: TOPIC, messages }); // 2. waits for acks=all
      await redis.xack(stream, GROUP, ...entries.map(([id]) => id)); // 3. only after Kafka confirms
    }
  }
}
