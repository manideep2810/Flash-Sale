# ADR 0004: Payment saga over Kafka, decided on the order row

## Context
A hold (ADR 0002) must end in exactly one of two ways: sold, or back on sale. Payment is slow, can fail, and its messages can be lost or repeated. The hold can also expire while a payment is in flight. We must never charge twice, never sell past stock, and never leave an order stuck.

## Decisions

### 1. Kafka between the order and payment services, not HTTP

| Option | Why not |
| --- | --- |
| Order calls payment over HTTP | A payment outage fails `/pay`. A timeout leaves the charge outcome unknown, and a retry risks a second charge. Request latency includes the gateway. |
| **Commands and results over Kafka** | Chosen. |

- `/pay` publishes `PaymentRequested` to `payments.commands` and returns 202. It never waits for the charge.
- The payment service publishes `PaymentProcessed` to `payments.events`. Both topics are keyed by order id.
- Delivery is at-least-once, so the payment service dedupes on a unique order id in its `payments` table and replays the stored result for a repeat request.

### 2. The `PAYMENT_PENDING` row is the outbox
- `/pay` is one guarded `UPDATE` (`HELD` to `PAYMENT_PENDING`, only if the hold is still valid), then a publish. There is no outbox table.
- If the publish is lost, the row still says `PAYMENT_PENDING`. A sweeper (every 30s) re-publishes the request for rows older than 60s.
- Re-publishing is safe because a repeat request returns the stored result and never charges again.
- Hold settlement works the same way: a terminal order whose `holdSettledAt` is empty is settled by a sweeper if the event was lost.

### 3. The timeout job touches `HELD` only
- `/pay` needs `state = 'HELD' AND expiresAt > now`. The timeout job needs `state = 'HELD' AND expiresAt < now`. Both are guarded updates on the same row, so exactly one wins.
- Once an order is `PAYMENT_PENDING`, a charge may be in flight. Expiring it then would charge a customer for a released hold.
- The cost: a pending order can outlive its hold. Its payment result still decides it, and a stuck one is handled by the sweeper, not by expiry.

### 4. The order row is the only place decisions are made
- Every change is `UPDATE ... WHERE id = ? AND state = <expected>`. Zero rows means the race was lost, and the caller handles it.
- The payment service owns the `payments` table and never touches an order. It only reports a result.
- Redis holds are settled only after the order reaches an outcome: `PAID` confirms (hold to sold), `EXPIRED` or `PAYMENT_FAILED` releases (hold to avail). Both Lua scripts act only if `ZREM` removed the hold, so a repeat does nothing.
- There is no distributed transaction. Messages are hints, and the row is the truth.

## Consequences
- Every consumer must be idempotent: processed-event table, unique payment row, guarded updates, `ZREM`-guarded Lua.
- A paid order appears seconds after `/pay`, not instantly (eventual consistency).
- Sweepers poll, and re-publishing creates duplicate requests that the payment service absorbs.
- **No refund path.** A payment that succeeds after its order expired is detected (`payment_state_mismatch_total`) but not refunded.
- Known and not fixed: `/pay` on a released order answers `NOT_PAYABLE` instead of `HOLD_EXPIRED`, and a crash between the Redis and database steps of settling a paid order raises a false `hold_missing_on_confirm_total`. The inventory itself stays correct.

## Evidence
Measured on one laptop: k6, all services and Docker together. 5,000 units, a 5,000 RPS reserve rush for 60s, 60s holds, 70% pay and succeed, 10% pay and fail, 20% never pay.

| | Result |
| --- | --- |
| Final orders | 1,944 `PAID`; 3,335 `RELEASED` (3,051 expired, 284 payment failed) |
| Invariants after the run | 8 of 8 pass: inventory, no oversell, one payment per order, nothing stuck, every hold settled |
| Oldest `PAYMENT_PENDING` | 3.7s peak (2.7 min peak with one charge at a time) |
| Payment sweeper re-publishes | 0 |
| Settlement sweeper settles | 16 of about 5,300 orders |
| Reserve p99 | about 160 ms |

- Payment throughput comes from partitions times concurrency. One consumer handling one message at a time did about 3 charges a second. 4 processes with 20 each over 80 partitions kept up.
- Crash tests (`tests/e2e/phase4`): payment service down, crash before publish, crash before the charge, crash after storing the result, duplicate messages, late result. Each ended with one charge and a settled hold.
