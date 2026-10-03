import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { Logger } from "@flash/observability";
import { prisma } from "./db.js";
import { deadLetter, dlqProducer, withRetries } from "./dlq.js";
import {
  type HandlerResult,
  parseEvent,
  RESERVATION_CREATED,
  type RelayedEvent,
} from "./events.js";
import { handleReservationCreated } from "./handlers/reservationCreated.js";
import { kafka } from "./kafka.js";
import { consumerLag, eventsDuplicate, eventsProcessed, handlerLatency } from "./metrics.js";

/** Created by infra/kafka/topics.sh. */
export const TOPIC = "reservations.events";
export const GROUP_ID = "order-service";

const STATS_INTERVAL_MS = 5_000;

/**
 * Feeds the lag gauge from the statistics librdkafka emits every few seconds. It derives lag from
 * the fetch responses it already has, so this costs no request to the broker.
 *
 * Deliberately not the admin API: admin.fetchOffsets() called while the broker is away takes the
 * whole process down with a segfault when the broker returns (@confluentinc/kafka-javascript 1.10.1).
 */
function onStats(stats: { message: string }): void {
  const parsed = JSON.parse(stats.message) as {
    topics?: Record<string, { partitions?: Record<string, PartitionStats> }>;
  };
  consumerLag.reset();
  for (const [partition, p] of Object.entries(parsed.topics?.[TOPIC]?.partitions ?? {})) {
    const lag = partitionLag(p);
    if (lag !== undefined) {
      consumerLag.set({ partition }, lag);
    }
  }
}

interface PartitionStats {
  consumer_lag: number;
  fetch_state: string;
  hi_offset: number;
  lo_offset: number;
}

/** Lag for one partition, or undefined when it is not this consumer's to report. */
function partitionLag(p: PartitionStats): number | undefined {
  if (p.consumer_lag >= 0) {
    return p.consumer_lag;
  }
  // librdkafka reports -1 until the group has committed on the partition. Until then the consumer
  // starts from the oldest message, so everything in a partition it is fetching is still ahead of it.
  if (p.fetch_state === "active" && p.hi_offset >= 0) {
    return p.hi_offset - Math.max(p.lo_offset, 0);
  }
  // Not assigned to this consumer (or librdkafka's internal partition): no series.
  return undefined;
}

const consumer = kafka.consumer({
  "group.id": GROUP_ID,
  // Offsets are committed by hand, one message at a time, after that message's handler has finished.
  "enable.auto.commit": false,
  // A group with no committed offset starts from the oldest message, so events published before
  // this service first connected are not skipped.
  "auto.offset.reset": "earliest",
  "statistics.interval.ms": STATS_INTERVAL_MS,
  stats_cb: onStats,
});

let connected = false;

async function route(event: RelayedEvent, logger: Logger): Promise<HandlerResult> {
  if (event.type === RESERVATION_CREATED) {
    return handleReservationCreated(event);
  }
  // No handler for this type. Its id is still recorded, so a redelivery is counted as a duplicate.
  const { count } = await prisma.processedEvent.createMany({
    data: [{ eventId: event.eventId }],
    skipDuplicates: true,
  });
  logger.warn("no handler for event type, skipped", { type: event.type, eventId: event.eventId });
  return count === 0 ? "duplicate" : "processed";
}

async function handle(
  { topic, partition, message }: KafkaJS.EachMessagePayload,
  logger: Logger,
): Promise<void> {
  const attempted = await withRetries(async () => {
    const event = parseEvent(message.value);
    const startedAt = performance.now();
    try {
      return await route(event, logger);
    } finally {
      handlerLatency.observe(performance.now() - startedAt);
    }
  });

  if (attempted.ok) {
    (attempted.value === "duplicate" ? eventsDuplicate : eventsProcessed).inc();
  } else {
    logger.error("message failed after retries, dead-lettering", {
      topic,
      partition,
      offset: message.offset,
      attempts: attempted.attempts,
      error: String(attempted.error),
    });
    await deadLetter({ topic, partition, message }, attempted.error, attempted.attempts);
  }

  // Reached only once the handler's transaction has committed, or the message is in the DLQ. If
  // anything above throws, this is skipped and the client delivers the same message again.
  await consumer.commitOffsets([
    { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
  ]);
}

/** Resolves once the consumer has joined its group; while no broker answers, it keeps waiting. */
export async function startConsumer(logger: Logger): Promise<void> {
  await dlqProducer.connect();
  await consumer.connect();
  connected = true;

  await consumer.subscribe({ topics: [TOPIC] });
  await consumer.run({ eachMessage: (payload) => handle(payload, logger) });
}

/** Lets the message being handled finish and commit, then leaves the group. */
export async function stopConsumer(): Promise<void> {
  if (!connected) {
    return;
  }
  connected = false;
  await consumer.disconnect();
  await dlqProducer.disconnect();
}
