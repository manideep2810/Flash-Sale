import type { PoolClient } from "pg";
import type { ReserveResult } from "./types.js";

/**
 * Variant: pessimistic locking.
 *
 * Expected shape: BEGIN; SELECT ... FOR UPDATE on the inventory row; check; UPDATE; INSERT hold;
 * COMMIT. Correct, but every request for the same event serializes on the row lock.
 */
export async function reserve(
  _client: PoolClient,
  _eventId: string,
  _userId: string,
  _qty: number,
): Promise<ReserveResult> {
  await _client.query("BEGIN");
  try {
    const { rows } = await _client.query<{ available: number }>(
      "SELECT available FROM inventory WHERE event_id = $1 FOR UPDATE",
      [_eventId],
    );

    if (rows.length === 0) {
      await _client.query("ROLLBACK");
      throw new Error(`Baseline/Naive: unknown Event ${_eventId}`);
    }

    const available = rows[0]!.available;

    if (available < _qty) {
      await _client.query("ROLLBACK");
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

    await _client.query("COMMIT");
    return { ok: true, holdId: insertedHold.rows[0]!.id };
  } catch (error) {
    await _client.query("ROLLBACK");
    throw error;
  }
}
