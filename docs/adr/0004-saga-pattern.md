# 0004. Orchestrated Saga with State in Postgres

**Status:** Accepted

**Date:** 2026-09-27

## Context
Payment takes 2–5 seconds. In that time, the hold might expire. We need a state machine to track:
- Reserved → Payment Started → Payment Succeeded → Order Confirmed

And handle failures:
- Payment Failed → Release Hold

## Options Considered

### Option A: Choreography (Services React to Events)
- Order service emits `reservation.created`
- Payment service listens, calls gateway, emits `payment.succeeded` or `payment.failed`
- Order service listens and confirms/releases
- Pros: Decoupled, no central orchestrator
- Cons: Hard to track state, hard to debug if something gets stuck

### Option B: Orchestration (Order Service Commands Other Services)
- Order service is the saga orchestrator
- Calls payment service: "charge this order"
- Payment service returns success/failure
- Order service decides: confirm or release
- Pros: Clear state machine, easy to debug, centralized
- Cons: Slightly more coupling, order service must handle timeouts

### Option C: Temporal (Temporal.io Workflow Engine)
- Define saga as a workflow in Temporal
- Automatic retries, durability, visibility
- Pros: Battle-tested, production-ready
- Cons: Another service to run, learning curve, overkill for Phase 0

## Decision
We choose **Option B (Orchestration) with state in Postgres**.

This is deliberate learning — Temporal is what production uses, but we hand-roll to understand failure modes.

## Consequences

### What Becomes Easier
- Order service owns the state machine (clear ownership)
- Easy to debug (query `orders` table, see the state)
- Can add compensations (refunds) easily

### What Becomes Harder
- Order service has more responsibility (calls payment service)
- Must handle timeouts (payment gateway might be slow)
- Must handle duplicate webhooks (idempotency keys)

### What We Must Do
- Write state machine with guarded transitions (UPDATE WHERE state = expected)
- Implement timeout handling (if stuck in PAYMENT_PENDING > 15 min, query gateway)
- Implement compensation (refund if payment succeeded but hold expired)

## Interview Note
- "Why not use Temporal?" → "We hand-rolled to learn the failure modes. In production, Temporal would be the choice. We proved we understand distributed transactions."
- "What happens if the webhook is lost?" → "Payment service retries. If it gives up, the order is stuck in PAYMENT_PENDING. Our timeout handler (Phase 4) queries the gateway to see what actually happened."