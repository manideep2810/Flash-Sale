import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { Logger } from "@flash/observability";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { withRetries } from "../dlq.js";
import { kafka } from "../kafka.js";
import { lagStatsCallback, STATS_INTERVAL_MS } from "../lag.js";
import { paymentStateMismatch } from "../metrics.js";
import {
  connectOrdersProducer,
  ORDER_PAID,
  ORDER_PAYMENT_FAILED,
  orderEvent,
  type PublishOrderEvent,
  publishOrderEvent,
} from "../orderEvents.js";
import { PAYMENT_PROCESSED, PAYMENTS_EVENTS_TOPIC } from "../topics.js";

export const PAYMENT_RESULT_GROUP_ID = "payment-result-consumer";

const paymentProcessed = z.object({
  type: z.literal(PAYMENT_PROCESSED),
  orderId: z.string().min(1),
  eventId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED"]),
});

type PaymentProcessedEvent = z.infer<typeof paymentProcessed>;
export type PaymentResult = "paid" | "payment_failed" | "duplicate" | "mismatch";

const consumer = kafka.consumer({
  "group.id": PAYMENT_RESULT_GROUP_ID,
  // Offsets are committed by hand, one message at a time, after its transaction has committed.
  "enable.auto.commit": false,
  "auto.offset.reset": "earliest",
  "statistics.interval.ms": STATS_INTERVAL_MS,
  stats_cb: lagStatsCallback(PAYMENT_RESULT_GROUP_ID),
});

let connected = false;

/**
 * PaymentProcessed -> PAID or PAYMENT_FAILED, once per event.
 *
 * One transaction: record the event id (ON CONFLICT DO NOTHING, so a redelivery inserts nothing and
 * stops here), then a guarded update that only moves an order that is still PAYMENT_PENDING.
 * The Kafka offset is committed by the caller after this resolves, which is after COMMIT.
 *
 * After the commit, publishes OrderPaid or OrderPaymentFailed (the fast path to hold settlement).
 * That publish is best effort: if it fails it is only logged, because the settlement sweeper settles
 * every PAID or PAYMENT_FAILED order whose hold is still open.
 */
export async function applyPaymentResult(
  event: PaymentProcessedEvent,
  logger: Logger,
  publish: PublishOrderEvent = publishOrderEvent,
): Promise<PaymentResult> {
  const target = event.status === "SUCCEEDED" ? "PAID" : "PAYMENT_FAILED";

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.processedEvent.createMany({
      data: [{ eventId: event.eventId }],
      skipDuplicates: true,
    });
    if (claimed.count === 0) {
      return "duplicate" as const;
    }

    const updated = await tx.order.updateMany({
      where: { id: event.orderId, state: "PAYMENT_PENDING" },
      data: { state: target },
    });
    if (updated.count === 1) {
      return target === "PAID" ? ("paid" as const) : ("payment_failed" as const);
    }

    // Guard matched nothing: the order is already where this event would put it (a duplicate that
    // carried a new event id), or it is somewhere it should not be.
    const current = await tx.order.findUnique({
      where: { id: event.orderId },
      select: { state: true },
    });
    return current?.state === target ? ("duplicate" as const) : ("mismatch" as const);
  });

  if (result === "mismatch") {
    const current = await prisma.order.findUnique({
      where: { id: event.orderId },
      select: { state: true },
    });
    paymentStateMismatch.inc();
    logger.error("payment result does not fit the order state, skipped", {
      orderId: event.orderId,
      eventId: event.eventId,
      status: event.status,
      orderState: current?.state ?? "NOT_FOUND",
    });
  } else if (result === "duplicate") {
    logger.info("payment result already applied, skipped", {
      orderId: event.orderId,
      eventId: event.eventId,
    });
  } else {
    logger.info("payment result applied", {
      orderId: event.orderId,
      eventId: event.eventId,
      state: target,
    });
    const outcome = orderEvent(
      result === "paid" ? ORDER_PAID : ORDER_PAYMENT_FAILED,
      event.orderId,
    );
    try {
      await publish(outcome);
    } catch (error) {
      logger.warn("publishing the order outcome failed, the settlement sweeper will cover it", {
        orderId: event.orderId,
        eventId: outcome.eventId,
        type: outcome.type,
        error: String(error),
      });
    }
  }
  return result;
}

async function handle(
  { topic, partition, message }: KafkaJS.EachMessagePayload,
  logger: Logger,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(message.value?.toString("utf8") ?? "");
  } catch {
    raw = undefined;
  }

  const type =
    typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
  // Only PaymentProcessed is ours; anything else on the topic is committed past.
  if (type === PAYMENT_PROCESSED || raw === undefined) {
    const parsed = paymentProcessed.safeParse(raw);
    if (!parsed.success) {
      // A message that can never parse would block the partition forever if it were retried.
      logger.error("malformed PaymentProcessed, skipped", {
        topic,
        partition,
        offset: message.offset,
        issues: z.prettifyError(parsed.error),
      });
    } else {
      const attempted = await withRetries(() => applyPaymentResult(parsed.data, logger));
      if (!attempted.ok) {
        // Not committed: the client delivers this message again, so a failed write is never lost.
        throw attempted.error;
      }
    }
  }

  await consumer.commitOffsets([
    { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
  ]);
}

/** Resolves once the consumer has joined its group; while no broker answers, it keeps waiting. */
export async function startPaymentResultConsumer(logger: Logger): Promise<() => Promise<void>> {
  await connectOrdersProducer();
  await consumer.connect();
  connected = true;
  await consumer.subscribe({ topics: [PAYMENTS_EVENTS_TOPIC] });
  await consumer.run({
    partitionsConsumedConcurrently: config.RESULT_CONSUMER_CONCURRENCY,
    eachMessage: (payload) => handle(payload, logger),
  });
  logger.info("payment result consumer running", {
    topic: PAYMENTS_EVENTS_TOPIC,
    groupId: PAYMENT_RESULT_GROUP_ID,
  });

  return stopPaymentResultConsumer;
}

/** Lets the message being handled finish and commit, then leaves the group. */
export async function stopPaymentResultConsumer(): Promise<void> {
  if (!connected) {
    return;
  }
  connected = false;
  await consumer.disconnect();
}
