/** Order -> payment: asks for a charge. Created by infra/kafka/topics.sh, keyed by orderId. */
export const PAYMENTS_COMMANDS_TOPIC = "payments.commands";
/** Payment -> order: the outcome of a charge. Created by infra/kafka/topics.sh, keyed by orderId. */
export const PAYMENTS_EVENTS_TOPIC = "payments.events";
/** Order service's own events (OrderExpired, ...). Created by `make up` (KAFKA_TOPICS in the Makefile). */
export const ORDERS_TOPIC = "orders.events";

export const PAYMENT_REQUESTED = "PaymentRequested";
export const PAYMENT_PROCESSED = "PaymentProcessed";
