import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import { config } from "../config.js";
import { ORDER_TABLE, prisma } from "../db.js";
import {
  connectOrdersProducer,
  ORDER_EXPIRED,
  orderEvent,
  type PublishOrderEvent,
  publishOrderEvent,
} from "../orderEvents.js";

const BATCH = 500;

// Timestamps are `timestamp(3)` holding UTC, so "now" is taken as UTC whatever the session time zone.

/**
 * HELD -> EXPIRED for orders past their hold. Only HELD: a PAYMENT_PENDING order is mid-payment and
 * is never touched here, which is what stops a customer being charged for an expired hold. `/pay` is
 * the mirror image (`state = 'HELD' AND expiresAt > now`), and both are guarded updates on the same
 * row, so Postgres lets exactly one of them win.
 */
export async function expireHeld(limit = BATCH): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    UPDATE ${ORDER_TABLE}
       SET state = 'EXPIRED', "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE id IN (SELECT id FROM ${ORDER_TABLE}
                   WHERE state = 'HELD' AND "expiresAt" < (now() AT TIME ZONE 'UTC')
                   ORDER BY "expiresAt"
                   LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED)
    RETURNING id`;
}

/**
 * One pass: expire what is due and publish OrderExpired for each (the fast path to hold settlement).
 *
 * A lost publish is covered by the settlement sweeper, which settles every EXPIRED order whose hold
 * is still unsettled; the order row is the record, not the event.
 */
export async function runTimeoutCycle(
  logger: Logger,
  publish: PublishOrderEvent = publishOrderEvent,
  batch = BATCH,
): Promise<{ expired: number }> {
  const orders = await expireHeld(batch);
  for (const { id } of orders) {
    const event = orderEvent(ORDER_EXPIRED, id);
    try {
      await publish(event);
      logger.info("order expired", { orderId: id, eventId: event.eventId });
    } catch (error) {
      logger.warn("publishing OrderExpired failed, the settlement sweeper will cover it", {
        orderId: id,
        eventId: event.eventId,
        error: String(error),
      });
    }
  }
  return { expired: orders.length };
}

/** Runs a cycle every TIMEOUT_JOB_INTERVAL_MS until the returned function is called. */
export async function startTimeoutJob(logger: Logger): Promise<() => Promise<void>> {
  await connectOrdersProducer();
  const abort = new AbortController();

  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        await runTimeoutCycle(logger);
      } catch (error) {
        logger.error("timeout cycle failed", { error: String(error) });
      }
      await sleep(config.TIMEOUT_JOB_INTERVAL_MS, undefined, { signal: abort.signal }).catch(
        () => {},
      );
    }
  })();

  logger.info("timeout job running", { intervalMs: config.TIMEOUT_JOB_INTERVAL_MS });

  return async () => {
    abort.abort();
    await loop;
  };
}
