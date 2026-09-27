# 0001. General Admission First; Assigned Seating is a Stretch Goal

**Status:** Accepted

**Date:** 2026-09-27

## Context
A flash sale can work two ways:
1. General admission: inventory is a counter (100 tickets), users buy what they want
2. Assigned seating: each seat is tracked individually (Seat 1A, Seat 1B, etc.)

We have ~14 weeks. Assigned seating is more complex (per-seat Redis structure, per-seat Postgres rows).

## Options Considered

### Option A: General Admission (Counter-Based)
- Redis: `ev:SALE:avail` is a string integer
- Lua script: `DECR ev:SALE:avail` if > 0
- Pros: Simple, fast, scales to 50k RPS
- Cons: No seat assignment, users don't know which seat they get

### Option B: Assigned Seating (Bitmap/Set-Based)
- Redis: `ev:SALE:seats` is a BITMAP or SET of available seat IDs
- Lua script: check if seat exists, remove it
- Pros: Know exactly which seat you're in
- Cons: Slower (set operations on 100k seats), more complex Postgres schema, 5–10x more code

## Decision
We choose **Option A (General Admission) for Phase 0–7**.

Assigned seating is a Phase 9+ stretch goal, only if time permits and Phase 8 is done.

## Consequences

### What Becomes Easier
- Lua scripts are simpler: one `DECR` vs. set membership checks
- Postgres schema simpler: no per-seat rows
- Testing faster: don't need seat availability data

### What Becomes Harder
- Users don't know their seat until after purchase
- Can't say "Seat A1 is unavailable" to the next buyer
- UI is simpler (just qty picker, not seat map)

### What We Must Do
- Document that seats are assigned post-purchase (in email/confirmation)
- In Phase 9, if we add seating, migrate to per-seat structure (rewrite Lua, schema, tests)

## Questions This Answers in Interviews
- "Why not assigned seating?" → "Time budget. With 14 weeks, general admission lets us focus on the core hard problem: zero oversells under failure. Seating is a nice-to-have."
- "How would you add seating later?" → "Redesign Redis structure, add Seat model to Postgres, rewrite Lua script. Doable in Phase 9."