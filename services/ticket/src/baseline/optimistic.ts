import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import type { ReserveResult } from "./types.js";

/**
 * Upper bound on version-conflict retries per request. Only one writer wins each version, so with
 * PG_POOL_MAX (default 20) transactions contending for the same row a single request can lose many
 * rounds in a row; the budget is sized well above that so exhaustion means something is wrong,
 * not that the sale was merely busy.
 */
const MAX_ATTEMPTS = 200;

/** Short random pause between attempts so losers don't all re-read and collide on the same tick. */
const MAX_BACKOFF_MS = 2;

export class OptimisticRetryExhaustedError extends Error {
  constructor(eventId: string, attempts: number) {
    super(`baseline/optimistic: gave up on ${eventId} after ${attempts} version conflicts`);
    this.name = "OptimisticRetryExhaustedError";
  }
}

/**
 * Variant: optimistic concurrency control.
 *
 * SELECT available, version; check in application code; UPDATE guarded by `version = $expected`.
 * A rowCount of 0 means a concurrent writer bumped the version first, so re-read and try again.
 * No locks are held between statements; correctness comes from the version check alone.
 */
export async function reserve(
  client: PoolClient,
  eventId: string,
  userId: string,
  qty: number,
): Promise<ReserveResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { rows } = await client.query<{ available: number; version: number }>(
      "SELECT available, version FROM inventory WHERE event_id = $1",
      [eventId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error(`baseline/optimistic: unknown event ${eventId}`);
    }

    const retries = attempt - 1;

    if (current.available < qty) {
      return { ok: false, reason: "SOLD_OUT", retries };
    }

    const updated = await client.query(
      `UPDATE inventory
         SET available = available - $2, version = version + 1
       WHERE event_id = $1 AND version = $3`,
      [eventId, qty, current.version],
    );

    if (updated.rowCount === 1) {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO holds (event_id, user_id, qty) VALUES ($1, $2, $3) RETURNING id",
        [eventId, userId, qty],
      );
      const hold = inserted.rows[0];
      if (!hold) {
        throw new Error("baseline/optimistic: INSERT ... RETURNING id produced no row");
      }
      return { ok: true, holdId: hold.id, retries };
    }

    // Lost the race: someone else advanced `version` between our SELECT and UPDATE.
    await sleep(Math.random() * MAX_BACKOFF_MS);
  }

  throw new OptimisticRetryExhaustedError(eventId, MAX_ATTEMPTS);
}
