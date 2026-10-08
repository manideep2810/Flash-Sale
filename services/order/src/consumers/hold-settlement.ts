import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { Logger } from "@flash/observability";
import { z } from "zod";
import { config } from "../config.js";
import { withRetries } from "../dlq.js";
import { kafka } from "../kafka.js";
import { lagStatsCallback, STATS_INTERVAL_MS } from "../lag.js";
import { ORDER_EXPIRED, ORDER_PAID, ORDER_PAYMENT_FAILED } from "../orderEvents.js";
import type { HoldStore } from "../redis/index.js";
import { settle } from "../services/settle.js";
import { ORDERS_TOPIC } from "../topics.js";

export const HOLD_SETTLEMENT_GROUP_ID = "hold-settlement";

const outcome = z.object({
  type: z.enum([ORDER_EXPIRED, ORDER_PAID, ORDER_PAYMENT_FAILED]),
  orderId: z.string().min(1),
  eventId: z.string().min(1),
});

const consumer = kafka.consumer({
  "group.id": HOLD_SETTLEMENT_GROUP_ID,
  // Offsets are committed by hand, one message at a time, after the settlement has finished.
  "enable.auto.commit": false,
  "auto.offset.reset": "earliest",
  "statistics.interval.ms": STATS_INTERVAL_MS,
  stats_cb: lagStatsCallback(HOLD_SETTLEMENT_GROUP_ID),
});

let connected = false;

async function handle(
  { topic, partition, message }: KafkaJS.EachMessagePayload,
  holds: HoldStore,
  logger: Logger,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(message.value?.toString("utf8") ?? "");
  } catch {
    raw = undefined;
  }

  // The topic carries other types too; only the three outcomes are ours, the rest are committed past.
  const parsed = outcome.safeParse(raw);
  if (parsed.success) {
    const { orderId, eventId, type } = parsed.data;
    // The order row decides what happens, not the event: settle() reads the state and is idempotent,
    // so a duplicate, a late or a reordered event is harmless.
    const attempted = await withRetries(() => settle(orderId, holds, logger));
    if (!attempted.ok) {
      logger.error("hold settlement failed, will be redelivered", {
        orderId,
        eventId,
        type,
        attempts: attempted.attempts,
        error: String(attempted.error),
      });
      // Not committed: the message is delivered again; the sweeper is the backstop meanwhile.
      throw attempted.error;
    }
  }

  await consumer.commitOffsets([
    { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
  ]);
}

/** Resolves once the consumer has joined its group; while no broker answers, it keeps waiting. */
export async function startHoldSettlementConsumer(
  logger: Logger,
  holds: HoldStore,
): Promise<() => Promise<void>> {
  await consumer.connect();
  connected = true;
  await consumer.subscribe({ topics: [ORDERS_TOPIC] });
  await consumer.run({
    partitionsConsumedConcurrently: config.RESULT_CONSUMER_CONCURRENCY,
    eachMessage: (payload) => handle(payload, holds, logger),
  });
  logger.info("hold settlement consumer running", {
    topic: ORDERS_TOPIC,
    groupId: HOLD_SETTLEMENT_GROUP_ID,
  });

  return async () => {
    if (!connected) {
      return;
    }
    connected = false;
    await consumer.disconnect();
  };
}
