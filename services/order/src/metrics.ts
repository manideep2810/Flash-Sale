import { Counter, Gauge, Histogram } from "prom-client";

// All four register on prom-client's default registry, which GET /metrics in server.ts serves.

export const eventsProcessed = new Counter({
  name: "order_events_processed_total",
  help: "Events handled for the first time: written by a handler, or recorded and skipped when no handler exists for the type.",
});

export const eventsDuplicate = new Counter({
  name: "order_events_duplicate_total",
  help: "Events that were already in ProcessedEvent when they arrived, so nothing was written.",
});

/** One sample per handler call, including calls that throw and are retried. */
export const handlerLatency = new Histogram({
  name: "order_handler_latency_ms",
  help: "Time spent in the handler for one event, in milliseconds.",
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500],
});

/** Set by the consumer from librdkafka's statistics every few seconds; see onStats in consumer.ts. */
export const consumerLag = new Gauge({
  name: "order_consumer_lag",
  help: "Messages in reservations.events the order-service group has not committed yet, per partition.",
  labelNames: ["partition"],
});

export const paymentRequestRepublished = new Counter({
  name: "payment_request_republished_total",
  help: "PaymentRequested events the stale sweeper sent again for orders still PAYMENT_PENDING.",
});

/** Set by the stale sweeper on each pass. */
export const oldestPaymentPendingAge = new Gauge({
  name: "oldest_payment_pending_age_seconds",
  help: "Seconds since the oldest PAYMENT_PENDING order was last requested; 0 when there is none.",
});

export const paymentStateMismatch = new Counter({
  name: "payment_state_mismatch_total",
  help: "PaymentProcessed events that matched no PAYMENT_PENDING order and were not a repeat of one already applied.",
});

export const holdMissingOnConfirm = new Counter({
  name: "hold_missing_on_confirm_total",
  help: "PAID orders whose Redis hold was already gone when it was confirmed: an oversell risk.",
});

export const holdSettlementBackstop = new Counter({
  name: "hold_settlement_backstop_total",
  help: "Holds settled by the sweeper because the event-driven path had not got to them.",
});

export const payDuration = new Histogram({
  name: "order_pay_duration_ms",
  help: "Time to answer POST /orders/:id/pay, in milliseconds (the charge itself is asynchronous).",
  labelNames: ["status"],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500],
});
