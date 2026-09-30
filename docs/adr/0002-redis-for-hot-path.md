# ADR 0002: Redis for the hot path

## Context
The reserve operation must handle 100k+ concurrent users during a flash sale.

## Decision
Move the reserve check-and-decrement from Postgres to Redis (Lua script).

## Rationale
Phase 1 load testing (pessimistic vs optimistic vs atomic SQL) showed:

| Variant | Max RPS | p99 latency | Reason it stops |
| --- | --- | --- | --- |
| Pessimistic | 330 | 4s | FOR UPDATE lock held whole transaction |
| Optimistic | 300 | 16s | Retry storms under contention |
| Atomic | 800 | 7s | Row lock on hot row (brief, but serial) |

Even the best SQL approach (atomic) saturates at 800 RPS because every request needs an exclusive lock on a single inventory row. Redis Lua scripts run serially in memory with no locks, enabling 50k+ RPS.

## Consequences
- Redis becomes source of truth for stock during sale
- Postgres is the permanent record (saga state)
- Requires Redis failover strategy (covered in Phase 5)