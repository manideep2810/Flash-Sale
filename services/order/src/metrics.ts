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
