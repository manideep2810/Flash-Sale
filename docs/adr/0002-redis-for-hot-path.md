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
| Redis (Lua) | 8,900+ | 436ms | Host CPU, not the service |

Even the best SQL approach (atomic) saturates at 800 RPS because every request needs an exclusive lock on a single inventory row. Redis Lua scripts run serially in memory with no locks, enabling 50k+ RPS.

## Phase 2 results (Redis)
Measured on one Windows laptop (16 logical CPUs) running the service, k6 and Redis (Docker) together.

| Target RPS | Achieved | p50 | p99 | Errors |
| --- | --- | --- | --- | --- |
| 5,000 | 5,000 | 2ms | 182ms | 0 |
| 10,000 | 8,900 | 38ms | 436ms | 0 |

- A Node worker handles about 5,000 RPS per core. At 10k the laptop ran out of CPU for Node, k6 and Redis together; the service itself never failed a request.
- Redis was not the bottleneck. Its slowlog recorded nothing during the runs.
- One Node instance is enough for capacity. A second one is for availability only.
- Per-event throughput is bounded by one Redis thread, because the Lua script runs serially. Scaling past that means sharding events across Redis instances (ADR 0003).

## Consequences
- Redis becomes source of truth for stock during sale
- Postgres is the permanent record (saga state)
- Requires Redis failover strategy (covered in Phase 5)
- Hot-path throughput per event is bounded by one Redis; event partitioning (ADR 0003) is the scale-out path
