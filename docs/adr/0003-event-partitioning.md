# 0003. Events Keyed by reservationId; Outbox via Redis Stream

**Status:** Accepted

**Date:** 2026-09-27

## Context
We need to durably deliver events (reservations, payments) to Kafka.

Two problems:
1. If Redis decrements `available` but crashes before publishing the event, we lose the hold.
2. One popular event means all traffic goes to one Kafka partition.

## Options Considered

### Outbox Options

#### Option A: Postgres Outbox Table
- Service writes to Postgres outbox after reserve
- Background job reads outbox, produces to Kafka
- Pros: Transactional guarantee (reserve + outbox in same txn)
- Cons: Postgres latency on hot path, complex two-phase commit

#### Option B: Redis Stream Outbox (Chosen)
- Lua script writes event to Redis Stream inside the reserve script
- Relay service reads Redis Stream, produces to Kafka
- Pros: Atomic with reserve (same Lua call), no network round-trips
- Cons: Relay must retry on failure, idempotency needed

### Event Partitioning Options

#### Option C: Partition by eventId
- All events for a sale go to one partition
- Pros: Easy to reason about order
- Cons: Hot partition (all 20k RPS hits partition 0)

#### Option D: Partition by reservationId (Chosen)
- Each reservation's events go to its own partition
- Pros: Spreads load across 12 partitions, one hot event doesn't bottleneck Kafka
- Cons: Per-reservation ordering not guaranteed across partitions (but that's OK; per-order service handles it)

## Decision
- **Outbox:** Redis Stream, written inside Lua reserve script
- **Partitioning:** By `reservationId`

## Consequences

### What Becomes Easier
- Reserve is atomic (no separate outbox write needed)
- Kafka load is spread across partitions
- Relay can scale independently (one service or many replicas)

### What Becomes Harder
- Relay must be idempotent (handle duplicate events)
- Must handle Redis Stream cleanup (MAXLEN trimming)
- Per-event ordering is per-reservation, not per-sale (acceptable)

## Questions This Answers in Interviews
- "Why not Postgres outbox?" → "Postgres would add 10–20ms to reserve latency. Redis Stream is immediate."
- "How do you handle relay crashes?" → "Events stay in Redis Stream. On restart, relay reads from last ACK offset and continues."
- "What if the same event is published twice?" → "Order service has idempotency (ProcessedEvent table). Duplicate is ignored."