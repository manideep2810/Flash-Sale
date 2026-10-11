import { Counter, Gauge, Histogram } from "prom-client";

// Everything registers on prom-client's default registry, which GET /metrics serves in both
// processes. queue-svc moves the first two; the admitter moves the rest.

/** Incremented by POST /queue/:eventId/join for each call join.lua answered. */
export const queueJoins = new Counter({
  name: "queue_joins_total",
  help: "Join requests answered by join.lua, repeats by an already queued user included.",
  labelNames: ["event"],
});

/** Incremented by GET /queue/:eventId/status, labelled with the status it answered. */
export const queueStatusRequests = new Counter({
  name: "queue_status_requests_total",
  help: "Status requests, by the status returned (QUEUED, ADMITTED, EXPIRED, SOLD_OUT, NOT_IN_QUEUE).",
  labelNames: ["event", "status"],
});

export const queueAdmitted = new Counter({
  name: "queue_admitted_total",
  help: "Users moved from the queue to admitted by the admitter.",
  labelNames: ["event"],
});

/** Sampled once a second by the admitter (ZCARD). */
export const queueDepth = new Gauge({
  name: "queue_depth",
  help: "Users waiting in the queue.",
  labelNames: ["event"],
});

export const EVENT_STATES = ["OPEN", "PAUSED", "SOLD_OUT"] as const;
export type EventState = (typeof EVENT_STATES)[number];

export const eventState = new Gauge({
  name: "event_state",
  help: "1 for the state the admitter last saw the event in, 0 for the other two.",
  labelNames: ["event", "state"],
});

export const admitterTickDuration = new Histogram({
  name: "admitter_tick_duration_seconds",
  help: "Time one admitter tick took across all events.",
  // A tick is one EVALSHA per event against a 100ms budget.
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const admitterTicksSkipped = new Counter({
  name: "admitter_ticks_skipped_total",
  help: "Ticks not started because the previous one was still running.",
});
