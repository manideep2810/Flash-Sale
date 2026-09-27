# Invariants

Six rules that define "correct." If any fails, there is a bug. The Phase 8 checker (`tools/check-invariants.ts`) runs all six after every test.

| ID | Rule | How to check | Checked in |
| --- | --- | --- | --- |
| I1 | `avail + held + sold == total` per event | Redis: read `avail`, `sold`, `total`; sum `qty` across the holds ZSET | Phase 2 tests after every Lua call; reconciler |
| I2 | Redis `sold` == Postgres `CONFIRMED` qty | Compare `GET ev:{id}:sold` with `SUM(qty) WHERE state='CONFIRMED'` | Phase 3+ integration; after chaos recovery |
| I3 | Every `SUCCEEDED` payment has one `CONFIRMED` order or one refund | Join `payments` to `orders`; cross-check the mock gateway ledger | Phase 4 scenario tests; reconciler |
| I4 | No user holds or buys more than `perUserLimit` | `SUM(qty) GROUP BY userId WHERE state IN ('HELD','CONFIRMED')` | Enforced in `reserve.lua`; verified in tests |
| I5 | No order stuck in `HELD` or `PAYMENT_PENDING` past TTL + 5 s + slack | Count orders in those states older than ~10 min 35 s; must be 0 | Phase 4+; after every chaos scenario |
| I6 | Repeating a request or event changes nothing | Send the same request or event twice; response and row counts stay identical | Every mutating endpoint and consumer |

## Core checks

```sql
-- I2 (compare with Redis GET ev:{id}:sold)
SELECT COALESCE(SUM(qty), 0) FROM orders WHERE event_id = $1 AND state = 'CONFIRMED';

-- I3: must return 0 rows
SELECT p.id FROM payments p
LEFT JOIN orders o ON o.id = p.order_id AND o.state = 'CONFIRMED'
WHERE p.status = 'SUCCEEDED' AND o.id IS NULL
  AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.order_id = p.order_id AND r.status = 'REFUNDED');

-- I5: must return 0
SELECT COUNT(*) FROM orders
WHERE state IN ('HELD','PAYMENT_PENDING') AND created_at < NOW() - INTERVAL '10 minutes 35 seconds';
```

## What a failure usually means

- **I1:** oversell or a leaked hold, usually a non-atomic Redis update.
- **I2:** lost write after a Redis failover, or an order confirmed twice.
- **I3:** a charge without a ticket, or a missing refund.
- **I5:** the sweeper or payment-timeout handler is not running.
- **I6:** a missing idempotency key or unique constraint.