import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import { config } from "../config.js";
import { ORDER_TABLE, prisma } from "../db.js";
import { oldestPaymentPendingAge, paymentRequestRepublished } from "../metrics.js";
import {
  type PublishPaymentRequested,
  paymentProducer,
  publishPaymentRequested,
} from "./payment-requests.js";

const BATCH = 500;
/** A PAYMENT_PENDING order whose request is older than this has probably lost it or its answer. */
export const STALE_AFTER_MS = config.PAYMENT_STALE_SEC * 1000;

// Timestamps are `timestamp(3)` holding UTC, so "now" is taken as UTC whatever the session time zone.

/** Seconds since the oldest PAYMENT_PENDING order was last (re)requested; 0 when there is none. */
export async function measureOldestPending(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ age: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - min("paymentStartedAt")))::float8 AS age
      FROM ${ORDER_TABLE} WHERE state = 'PAYMENT_PENDING'`;
  return row?.age ?? 0;
}

/**
 * Picks up PAYMENT_PENDING orders whose request is older than `staleMs`. Refreshing
 * `paymentStartedAt` in the same statement hands each order to one sweeper and spaces its next
 * re-publish a full window away, so an unanswered order is re-asked about once a minute, not on
 * every tick.
 */
export async function claimStale(
  staleMs = STALE_AFTER_MS,
  limit = BATCH,
): Promise<{ id: string; userId: string }[]> {
  return prisma.$queryRaw<{ id: string; userId: string }[]>`
    UPDATE ${ORDER_TABLE}
       SET "paymentStartedAt" = (now() AT TIME ZONE 'UTC'),
           "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE id IN (SELECT id FROM ${ORDER_TABLE}
                   WHERE state = 'PAYMENT_PENDING'
                     AND "paymentStartedAt" < (now() AT TIME ZONE 'UTC') - ${staleMs} * interval '1 millisecond'
                   ORDER BY "paymentStartedAt"
                   LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED)
    RETURNING id, "userId"`;
}

export interface SweepOptions {
  staleMs?: number;
  batch?: number;
}

/**
 * One sweep: re-publishes PaymentRequested (new eventId, same order) for every stale PAYMENT_PENDING
 * order. This covers a crash between `/pay`'s UPDATE and its publish, a lost request, and a lost
 * PaymentProcessed (the payment service answers a repeat request with its stored result, never a
 * second charge).
 */
export async function sweepStalePayments(
  logger: Logger,
  publish: PublishPaymentRequested = publishPaymentRequested,
  { staleMs = STALE_AFTER_MS, batch = BATCH }: SweepOptions = {},
): Promise<{ republished: number }> {
  // Measured before the claim below refreshes the clocks it reads.
  oldestPaymentPendingAge.set(await measureOldestPending());

  let republished = 0;
  for (const order of await claimStale(staleMs, batch)) {
    try {
      await publish(order);
      republished++;
      paymentRequestRepublished.inc();
      logger.info("payment request re-published", { orderId: order.id });
    } catch (error) {
      // Its clock was refreshed, so it is tried again after the next window.
      logger.warn("re-publishing PaymentRequested failed", {
        orderId: order.id,
        error: String(error),
      });
    }
  }
  return { republished };
}

/** Sweeps every config.SWEEPER_INTERVAL_MS until the returned function is called. */
export async function startPaymentSweeper(logger: Logger): Promise<() => Promise<void>> {
  await paymentProducer.connect();
  const abort = new AbortController();

  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        await sweepStalePayments(logger);
      } catch (error) {
        logger.error("payment sweep failed", { error: String(error) });
      }
      await sleep(config.SWEEPER_INTERVAL_MS, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();

  logger.info("payment sweeper running", {
    intervalMs: config.SWEEPER_INTERVAL_MS,
    staleMs: STALE_AFTER_MS,
  });

  return async () => {
    abort.abort();
    await loop;
    await paymentProducer.disconnect();
  };
}
