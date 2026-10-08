import { kafka } from "./kafka.js";
import { ORDERS_TOPIC } from "./topics.js";

export const ORDER_EXPIRED = "OrderExpired";
export const ORDER_PAID = "OrderPaid";
export const ORDER_PAYMENT_FAILED = "OrderPaymentFailed";

export type OrderEventType = typeof ORDER_EXPIRED | typeof ORDER_PAID | typeof ORDER_PAYMENT_FAILED;

export interface OrderEvent {
  type: OrderEventType;
  /** Fixed per order and type, so a re-published event is recognisably the same one. */
  eventId: string;
  orderId: string;
  timestamp: string;
}

const EVENT_ID_SUFFIX: Record<OrderEventType, string> = {
  [ORDER_EXPIRED]: "expired-v1",
  [ORDER_PAID]: "paid-v1",
  [ORDER_PAYMENT_FAILED]: "payment-failed-v1",
};

export function orderEvent(type: OrderEventType, orderId: string): OrderEvent {
  return {
    type,
    eventId: `${orderId}-${EVENT_ID_SUFFIX[type]}`,
    orderId,
    timestamp: new Date().toISOString(),
  };
}

/** Publishes an order's outcome to the topic the hold-settlement consumer reads. Key = orderId. */
export type PublishOrderEvent = (event: OrderEvent) => Promise<void>;

const producer = kafka.producer({ acks: -1, "enable.idempotence": true });
let connecting: Promise<void> | undefined;

/** Safe to call from every job that publishes: connects once. */
export function connectOrdersProducer(): Promise<void> {
  connecting ??= producer.connect();
  return connecting;
}

export async function disconnectOrdersProducer(): Promise<void> {
  if (connecting) {
    const pending = connecting;
    connecting = undefined;
    await pending;
    await producer.disconnect();
  }
}

export const publishOrderEvent: PublishOrderEvent = async (event) => {
  await producer.send({
    topic: ORDERS_TOPIC,
    messages: [{ key: event.orderId, value: JSON.stringify(event) }],
  });
};
