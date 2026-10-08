import { setTimeout as sleep } from "node:timers/promises";
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { Logger } from "@flash/observability";
import { z } from "zod";
import { config } from "../config.js";
import {
  createMockCharge,
  handlePaymentRequested,
  type PaymentProcessedEvent,
} from "../handlers/paymentRequested.js";
import { kafka } from "../kafka.js";
import { lagStatsCallback, STATS_INTERVAL_MS } from "../lag.js";
import { createPrismaStore, type PaymentStore } from "../paymentStore.js";

/** Created by infra/kafka/topics.sh. Order -> payment, keyed by orderId. */
export const COMMANDS_TOPIC = "payments.commands";
/** Created by infra/kafka/topics.sh. Payment -> order, keyed by orderId. */
export const EVENTS_TOPIC = "payments.events";
export const GROUP_ID = "payment-service";
const PAYMENT_REQUESTED = "PaymentRequested";

const paymentRequested = z.object({
  type: z.literal(PAYMENT_REQUESTED),
  orderId: z.string().min(1),
  amount: z.number().int().positive(),
  userId: z.string().optional(),
});

const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 100;

const consumer = kafka.consumer({
  "group.id": GROUP_ID,
  // Offsets are committed by hand, one message at a time, after the database write and the publish.
  "enable.auto.commit": false,
  "auto.offset.reset": "earliest",
  "statistics.interval.ms": STATS_INTERVAL_MS,
  stats_cb: lagStatsCallback(GROUP_ID),
});

const producer = kafka.producer({ acks: -1, "enable.idempotence": true });

async function publish(event: PaymentProcessedEvent): Promise<void> {
  await producer.send({
    topic: EVENTS_TOPIC,
    messages: [{ key: event.orderId, value: JSON.stringify(event) }],
  });
}

let connected = false;

async function handle(
  { topic, partition, message }: KafkaJS.EachMessagePayload,
  store: PaymentStore,
  logger: Logger,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(message.value?.toString("utf8") ?? "");
  } catch {
    raw = undefined;
  }

  const parsed = paymentRequested.safeParse(raw);
  if (!parsed.success) {
    // Nothing a retry could fix, and retrying would block the partition behind it.
    logger.error("unreadable payment command, skipped", {
      topic,
      partition,
      offset: message.offset,
      issues: z.prettifyError(parsed.error),
    });
  } else {
    const { orderId, amount, userId } = parsed.data;
    const deps = { store, charge: createMockCharge(config.FAIL_RATE), publish };
    for (let attempt = 1; ; attempt++) {
      try {
        await handlePaymentRequested({ orderId, amount, userId }, deps, logger);
        break;
      } catch (error) {
        logger.warn("payment request failed", { orderId, attempt, error: String(error) });
        if (attempt === MAX_ATTEMPTS) {
          // Not committed: the message is delivered again, and finds the row in whatever state this
          // attempt left it (PROCESSING, or decided and awaiting its publish).
          throw error;
        }
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  await consumer.commitOffsets([
    { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
  ]);
}

/** Resolves once the consumer has joined its group; while no broker answers, it keeps waiting. */
export async function startPaymentRequestConsumer(
  logger: Logger,
  store: PaymentStore = createPrismaStore(),
): Promise<() => Promise<void>> {
  await producer.connect();
  await consumer.connect();
  connected = true;
  await consumer.subscribe({ topics: [COMMANDS_TOPIC] });
  await consumer.run({
    // Partitions handled at once; each message is one 100-500ms mock charge, so 1 caps a process at
    // a few charges a second.
    partitionsConsumedConcurrently: config.PAYMENT_CONCURRENCY,
    eachMessage: (payload) => handle(payload, store, logger),
  });
  logger.info("payment request consumer running", { topic: COMMANDS_TOPIC, groupId: GROUP_ID });

  return stopPaymentRequestConsumer;
}

/** Lets the message being handled finish and commit, then leaves the group. */
export async function stopPaymentRequestConsumer(): Promise<void> {
  if (!connected) {
    return;
  }
  connected = false;
  await consumer.disconnect();
  await producer.disconnect();
}
