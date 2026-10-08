import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { kafka } from "../kafka.js";
import { PAYMENT_REQUESTED, PAYMENTS_COMMANDS_TOPIC } from "../topics.js";

export interface PaymentRequestedEvent {
  type: typeof PAYMENT_REQUESTED;
  eventId: string;
  orderId: string;
  userId: string;
  amount: number;
  timestamp: string;
}

/** Publishes PaymentRequested; `/pay` and the stale sweeper both go through this. */
export type PublishPaymentRequested = (order: { id: string; userId: string }) => Promise<void>;

export const paymentProducer = kafka.producer({ acks: -1, "enable.idempotence": true });

/**
 * A fresh eventId each time: the payment service dedupes on the order, not on the event, so a
 * re-publish is a new message about the same order.
 */
export const publishPaymentRequested: PublishPaymentRequested = async ({ id, userId }) => {
  const event: PaymentRequestedEvent = {
    type: PAYMENT_REQUESTED,
    eventId: randomUUID(),
    orderId: id,
    userId,
    amount: config.PAY_AMOUNT,
    timestamp: new Date().toISOString(),
  };
  await paymentProducer.send({
    topic: PAYMENTS_COMMANDS_TOPIC,
    messages: [{ key: id, value: JSON.stringify(event) }],
  });
};
