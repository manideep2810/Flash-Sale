import type { PoolClient } from "pg";
import type { ReserveResult } from "./types.js";

/**
 * Variant: atomic conditional decrement.
 *
 * Expected shape: UPDATE inventory SET available = available - $qty WHERE event_id = $1 AND
 * available >= $qty RETURNING ...; rowCount 0 means SOLD_OUT; otherwise INSERT hold. The row lock
 * is held only for the duration of the single UPDATE.
 */
export async function reserve(
  _client: PoolClient,
  _eventId: string,
  _userId: string,
  _qty: number,
): Promise<ReserveResult> {
  const updatedResult = await _client.query<{ event_id: string }>(
    "UPDATE inventory SET available = available - $2 WHERE event_id = $1 AND available >= $2 RETURNING event_id",
    [_eventId, _qty],
  );

  if (updatedResult.rows.length === 0) {
    return { ok: false, reason: "SOLD_OUT" };
  }

  const insertedHold = await _client.query<{ id: string }>(
    "INSERT INTO holds (event_id , user_id , qty) VALUES ($1 , $2 , $3) returning id",
    [_eventId, _userId, _qty],
  );

  return { ok: true, holdId: insertedHold.rows[0]!.id };
}
