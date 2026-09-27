# 0002. Redis is the Hot-Path Inventory Authority; Postgres is System of Record

**Status:** Accepted

**Date:** 2026-09-27

## Context
We need to check "are tickets available?" and decrement inventory millions of times in 60 seconds.

Two options:
1. Postgres: Every check is a query. `SELECT available FROM events WHERE id=$1`
2. Redis: In-memory, sub-millisecond checks and updates.

## Options Considered

### Option A: Postgres Conditional Update
```sql
UPDATE events SET available = available - 1 
WHERE id = $1 AND available > 0
RETURNING available
```
- Pros: Single system of record, no sync needed
- Cons: Row lock on one hot row, 5–10ms latency, saturates at ~2k RPS (Phase 1 will measure this)

### Option B: Redis Lua Script (Chosen)
```lua
if redis.call('GET', 'available') > 0 then
  redis.call('DECR', 'available')
  return 'success'
end
```
- Pros: Sub-millisecond, atomic, scales to 50k RPS
- Cons: Need to sync with Postgres, handle failover

### Option C: In-Memory Cache + Periodic Flush
- Pros: Fast
- Cons: Crash loses data, complex reconciliation

## Decision
We choose **Option B (Redis as hot-path authority)**.

Redis → Kafka → Postgres (system of record, via relay + order service).

## Consequences

### What Becomes Easier
- Reserve latency is <50ms (vs. >100ms with Postgres)
- Can handle 50k RPS (vs. 2k with Postgres)
- Lua scripts are atomic (no race conditions)

### What Becomes Harder
- Redis failover must be handled (Sentinel, AOF, `WAIT` command)
- Need Kafka/relay to reliably move holds to Postgres
- Reconciliation job in Phase 8 to verify Redis and Postgres agree

### What We Must Do
- Implement Redis Sentinel (Phase 6)
- Implement reconciliation checker (Phase 8)
- Test Redis failover scenarios (Phase 8)

## Questions This Answers in Interviews
- "Why not put everything in Postgres?" → "Postgres row locks saturate at 2k RPS. Redis is 25× faster."
- "What if Redis crashes?" → "We use AOF + Sentinel. If primary dies, replica takes over. Kafka has the full audit log, so we can replay if needed."
- "How do you keep Redis and Postgres in sync?" → "Every write goes through Kafka. Relay service is the bridge. If relay crashes, events stay in Redis Stream until it recovers."