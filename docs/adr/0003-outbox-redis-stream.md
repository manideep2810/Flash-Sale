# ADR 0003: Redis stream as the outbox to Kafka

## Context
A hold lives in Redis (ADR 0002) but must become a durable order in Postgres. Reserve must stay fast and must not depend on Kafka being up.

## Options

| Option | Why not |
| --- | --- |
| Publish to Kafka inside the request | Dual write: a crash between Redis and Kafka leaves a hold with no event. Kafka is on the hot path. |
| Write to Postgres inside the request | Postgres is back on the hot path (800 RPS at best, ADR 0002). |
| CDC from a database | Needs the state in a database first. |
| **Outbox in the Redis stream written by `reserve.lua`** | Chosen. |

## Decision
- `reserve.lua` writes the event to a Redis stream in the same script as the hold, so the two are atomic.
- A relay publishes stream entries to Kafka, keyed by reservation id, and acks an entry only after Kafka has it.
- The order service is an idempotent consumer: it dedupes on the event id and inserts the order in one transaction.

The ticket service has no Kafka client, so Kafka is off the hot path: users can still reserve while Kafka is down.

## Consequences
- At-least-once delivery, so every consumer must dedupe.
- Orders appear in Postgres a moment after the hold (eventual consistency), and minutes after at peak.
- Redis durability still matters (AOF, replica), since the outbox lives there.
- One more service (the relay) to run and monitor.

## Evidence
Relay killed mid-run, which cuts Kafka off. Measured on one laptop.

| | 1,000 RPS | 5,000 RPS |
| --- | --- | --- |
| Reservations, errors | 92,995, 0 | 450,551, 0 |
| Reserve p99 before / during the outage | 3.3 ms / 2.9 ms | 287 ms / 302 ms |
| Backlog waiting for the relay, peak | 73,391 | 270,962 |
| Last order written after the run | 6.5 min | 34 min |
| Holds = orders at the end | 92,995 | 450,551 |

- Reserve latency did not change while the relay was down.
- The order service is the slow stage, at about 200 orders per second.
- Broker killed: `tests/e2e/chaos.test.ts`. Every reservation made during the outage was accepted, and every hold got one order.
