# Phase 4: screenshot checklist for the load runs

Keep this open next to Grafana and the terminal. Tick each box as you save the file.
Save every image under `docs/results/phase-4/` with the exact file name shown.

## Before you start

- Stop `make dev` (Ctrl+C). The load script starts its own copies of every service and refuses to start if ports 3001-3010 are in use.
- Keep the Docker stack from `make up` running.
- Run: `pnpm -C tests/e2e run load run1` (then `run2` for the chaos run).
- Defaults: 4 payment processes x 20 concurrency (80 partitions on `payments.commands`), 8 ticket workers, result consumers at concurrency 12.
- Grafana: open **Phase 4 - Saga** (`localhost:3000/d/phase4-saga`, admin/admin).

## How to set up Grafana for every screenshot

After each run, open `docs/results/raw/phase4-run1.json` (or `run2`) and look at the `window` block.

1. **Time range:** from one minute before `startedAt` to one minute after `quietAt`. Note the file shows UTC; Grafana shows your local time (UTC+5:30 on this machine).
2. **Refresh:** 5s.
3. **Sale dropdown:** `phase4-run1` (or `phase4-run2`). **Never "All"**: it adds your `demo` sale and other old sales to the totals.
4. If the sale isn't in the dropdown yet, reload the page once.
5. If you edit the dashboard file, restart Grafana: `docker compose -p flash-sale -f infra/docker/docker-compose.yml restart grafana`.

## Grafana: the core set, once per run

Replace `run1` with `run2` for the chaos run.

| Done | File | What to capture | The point you make |
|---|---|---|---|
| [ ] | `run1-01-safety-tiles-and-inventory.png` | The four tiles plus the Inventory I1 panel, taken **after** the run | Four green zeros and a stack that ends flat at the dashed total. "Zero oversell, zero double charge, and the inventory invariant held." Your best single image. |
| [ ] | `run1-02-inventory-I1-during.png` | The I1 panel only, zoomed to the rush | Colours shift (avail down, held up, then sold or back to avail) while the stack stays flat at the total. All three come from Redis: held is a counter the Lua scripts keep, so it is exact at every instant. |
| [ ] | `run1-02b-held-cross-check.png` | The small panel "Held: Redis counter vs Postgres orders" | The counter against the real orders in Postgres. The Postgres line trails during the rush (order-creation backlog) and then meets the counter: the independent proof that the counter is right. |
| [ ] | `run1-03-orders-by-state.png` | Orders by state | The funnel: HELD, PAYMENT_PENDING, PAID, with RELEASED for unpaid and failed. |
| [ ] | `run1-04-payment-outcomes-and-latency.png` | Payment outcomes per second plus /pay latency p50/p99 | The 70/10/20 mix of outcomes. Be honest about /pay latency: it is fast when idle (about 100 ms) and degraded under the 5K reserve load on one machine. |
| [ ] | `run1-05-reserve-rps-p99.png` | /reserve requests per second and p99 | The hot-path numbers. State the rate actually reached and why the p99 is what it is (everything shares one laptop). |
| [ ] | `run1-06-lag-and-oldest-pending.png` | Consumer lag per group plus Oldest PAYMENT_PENDING age | Lag rises under load and drains to 0: eventually consistent, but it settles. |
| [ ] | `run1-07-self-healing.png` | Self-healing activity | Republish and backstop rates. Near zero is good; non-zero shows the safety nets working. |

## Run 1 versus run 2: the extra screenshots for the chaos run

Chaos schedule: payment service killed about 20 s in and back at about 40 s; one order-worker replica killed and restarted at about 30 s.

| Done | File | What to capture | The point you make |
|---|---|---|---|
| [ ] | `run2-04-pending-age-recovery.png` | Oldest PAYMENT_PENDING age across the whole run | The spike when payment was killed, and the fall back under 10 s after it returned. Quote `recoverySec` from `phase4-run2.json`. |
| [ ] | `run2-06-lag.png` | Consumer lag | Lag climbs while payment is down and drains after. Degraded, not broken. |
| [ ] | `run2-01-safety-tiles-and-inventory.png` | Tiles plus I1 after the chaos | Still zeros and a flat stack: "killed the payment service and a worker mid-load and nothing was lost or double charged." |

Also capture `run2-02` ... `run2-07` as in the table above.

If a tile is not green after run 2, capture it anyway together with the invariant output, and explain it. An honest finding is worth more than a clean screenshot.

## Terminal captures

| Done | File | Where it comes from | Why it is useful |
|---|---|---|---|
| [ ] | `run1-invariants.png`, `run2-invariants.png` | The PASS/FAIL block `run-load.ts` prints at the end | Eight named invariants, I1 to I8, checked from the database and Redis, not from the app's own claims |
| [ ] | `run1-k6-summary.png` | The k6 end-of-run summary at the end of the terminal output | Reserve and pay latency percentiles, dropped iterations, virtual users |
| [ ] | `run1-final-counts.png` | The `counts` section of `docs/results/raw/phase4-run1.json` | PAID vs RELEASED, Redis `sold` equal to PAID quantity, oversell 0, double charges 0 |
| [ ] | `e2e-scenario-results.png` | `pnpm -C tests/e2e run test:phase4` (the scenario list) | Each failure mode proved: payment service down, crashes at four points, duplicate messages, late result |
| [ ] | `redis-before-after.png` | `docker exec flash-sale-redis-1 redis-cli get ev:<sale>:avail` (and `:sold`, `zcard ev:<sale>:holds`) before and after | Concrete numbers behind the I1 panel |
| [ ] | `db-state.png` | `SELECT state, count(*) FROM order_e2e."Order" GROUP BY state` and the same on `payment_e2e."Payment"` | Proof for the funnel |

## Kafka UI (localhost:8080)

| Done | File | What to capture | The point |
|---|---|---|---|
| [ ] | `kafka-topics.png` | Topic list: `reservations.events`, `orders.events`, `payments.events` at 12 partitions; `payments.commands` at **80** | The event-driven design, keyed by order id. Be ready to say why payments.commands has 80 (it sets how many charges can run at once). |
| [ ] | `kafka-consumer-groups.png` | Groups `order-service`, `payment-result-consumer`, `hold-settlement`, `payment-service` with lag 0 | Four independent consumers, drained |
| [ ] | `kafka-message-sample.png` | One `PaymentProcessed` and one `OrderPaid` message | Concrete event shapes with the fixed event id |

## One diagram to draw yourself

[ ] `architecture.png`

```
reserve -> Redis (hold + stream) -> relay -> Kafka -> order worker -> /pay -> payment service
        -> Kafka -> result consumer -> settle (confirm or release in Redis)
```

Interviewers will ask you to draw it anyway.

## What to say about the numbers

- Lead with the invariants (zero oversell, zero double charge, I1 flat), then the throughput.
- Be ready for these honest points:
  - **Two known issues, not yet fixed.**
    - `/pay` on an order that is already released answers `NOT_PAYABLE` where the spec says `HOLD_EXPIRED`.
    - A settlement crash on a paid order bumps `hold_missing_on_confirm_total` and logs CRITICAL by mistake. The inventory itself is correct.
  - **No refund path.** A payment that succeeds after its order expired is detected (the mismatch counter) but not refunded. You scoped that out; say how you would add it (`RefundRequested` and `PaymentRefunded` events).
  - **The payment ceiling you measured.** At concurrency 1 the payment service handled about 3 charges a second and the PAYMENT_PENDING backlog grew past 2.5 minutes. With 4 processes x 20 concurrency over 80 partitions, the oldest pending age peaked at about 8 seconds.
  - **Order creation is the first bottleneck** at a 5K spike (about 100-110 orders a second). You can see it in the cross-check panel, where the Postgres held line trails the Redis counter.
  - **How held works.** `reserve.lua` adds to a `held` counter in the same atomic step as the avail decrement; `confirm.lua` moves it to sold and `release.lua` back to avail, each only when it actually removes the hold. Say plainly that the I1 stack is flat by construction because of that atomicity, and that the Postgres cross-check and the invariant script are the independent evidence.
  - **Holds can run out before the user can pay.** With a 60 s hold, an order created 50 s late has almost no time left, so some pays are refused.
  - **Load-test limits.** k6 and every service share one laptop. A virtual user sleeps inside its iteration, so k6 ran out of users and dropped iterations; the 5K requests a second was only reached for part of the run.

## After the runs

Tell me what the dashboards show and I will help turn these screenshots and the two JSON files (`phase4-run1.json`, `phase4-run2.json`) into `docs/results/phase-4.md`.
