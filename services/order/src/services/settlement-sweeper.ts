import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import { config } from "../config.js";
import { ORDER_TABLE, prisma } from "../db.js";
import { holdSettlementBackstop } from "../metrics.js";
import type { HoldStore } from "../redis/index.js";
import { settle } from "./settle.js";

const BATCH = 500;
/** An order has to be unsettled this long before the sweeper takes it, so the fast path gets first go. */
export const SETTLE_AFTER_MS = 30_000;

// Timestamps are `timestamp(3)` holding UTC, so "now" is taken as UTC whatever the session time zone.

/**
 * Orders in PAID, EXPIRED or PAYMENT_FAILED whose hold is still unsettled. Bumping `updatedAt` in the
 * same statement hands each order to one sweeper and gives it a full window before anyone retries
 * it, so several instances never settle the same order at once.
 */
export async function claimUnsettled(
  afterMs = SETTLE_AFTER_MS,
  limit = BATCH,
): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    UPDATE ${ORDER_TABLE}
       SET "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE id IN (SELECT id FROM ${ORDER_TABLE}
                   WHERE "holdSettledAt" IS NULL
                     AND state IN ('PAID', 'EXPIRED', 'PAYMENT_FAILED')
                     AND "updatedAt" < (now() AT TIME ZONE 'UTC') - ${afterMs} * interval '1 millisecond'
                   ORDER BY "updatedAt"
                   LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED)
    RETURNING id`;
}

/**
 * One sweep: settles whatever the event-driven path missed (a lost OrderExpired / OrderPaid /
 * OrderPaymentFailed, or a crash between Redis and Postgres).
 */
export async function sweepUnsettled(
  logger: Logger,
  holds: HoldStore,
  afterMs = SETTLE_AFTER_MS,
  batch = BATCH,
): Promise<{ settled: number }> {
  let settled = 0;
  for (const { id } of await claimUnsettled(afterMs, batch)) {
    try {
      await settle(id, holds, logger);
      settled++;
      holdSettlementBackstop.inc();
      logger.info("hold settled by the sweeper", { orderId: id });
    } catch (error) {
      logger.warn("sweeper could not settle a hold, will retry", {
        orderId: id,
        error: String(error),
      });
    }
  }
  return { settled };
}

/** Sweeps every SWEEPER_INTERVAL_MS until the returned function is called. */
export async function startSettlementSweeper(
  logger: Logger,
  holds: HoldStore,
): Promise<() => Promise<void>> {
  const abort = new AbortController();

  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        await sweepUnsettled(logger, holds);
      } catch (error) {
        logger.error("settlement sweep failed", { error: String(error) });
      }
      await sleep(config.SWEEPER_INTERVAL_MS, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();

  logger.info("settlement sweeper running", { intervalMs: config.SWEEPER_INTERVAL_MS });

  return async () => {
    abort.abort();
    await loop;
  };
}
