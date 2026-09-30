import type { PoolClient } from "pg";
import type { ReserveResult } from "./types.js";

/**
 * Variant: naive read-then-write.
 *
 * Expected shape: SELECT available, compare in application code, UPDATE, INSERT hold. No locking,
 * no atomic decrement. This is the control: under concurrency it oversells.
 */
export async function reserve(
  _client: PoolClient,
  _eventId: string,
  _userId: string,
  _qty: number,
): Promise<ReserveResult> {
  const { rows } = await _client.query<{ available: number }>(
    "SELECT available FROM inventory WHERE event_id = $1",
    [_eventId],
  );

  if (rows.length === 0) {
    throw new Error(`Baseline/Naive: unknown Event ${_eventId}`);
  }

  const available = rows[0]!.available;

  if (available < _qty) {
    return { ok: false, reason: "SOLD_OUT" };
  }

  await _client.query("UPDATE inventory SET available = available - $2 WHERE event_id = $1", [
    _eventId,
    _qty,
  ]);

  const insertedHold = await _client.query<{ id: string }>(
    "INSERT INTO holds (event_id , user_id , qty) VALUES ($1 , $2 , $3) returning id",
    [_eventId, _userId, _qty],
  );

  return { ok: true, holdId: insertedHold.rows[0]!.id };
}
