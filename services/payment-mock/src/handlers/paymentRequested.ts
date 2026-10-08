import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { faultPoint } from "@flash/config";
import type { Logger } from "@flash/observability";
import { paymentsDecided } from "../metrics.js";
import type { PaymentStore } from "../paymentStore.js";

export const PAYMENT_PROCESSED = "PaymentProcessed";

/** A PROCESSING row nobody has written to for this long belongs to a worker that died mid-charge. */
export const STALE_PROCESSING_MS = 30_000;

export interface ChargeOutcome {
  status: "SUCCEEDED" | "FAILED";
  chargeId: string;
}

export interface PaymentProcessedEvent {
  type: typeof PAYMENT_PROCESSED;
  /** Fixed per order, so the order service dedupes a re-published result. */
  eventId: string;
  orderId: string;
  status: "SUCCEEDED" | "FAILED";
  chargeId: string;
  timestamp: string;
}

/** The two things the handler does outside the database; swapped out in tests. */
export interface PaymentRequestedDeps {
  store: PaymentStore;
  charge(orderId: string, amount: number, userId?: string): Promise<ChargeOutcome>;
  publish(event: PaymentProcessedEvent): Promise<void>;
  staleMs?: number;
}

/** The mock gateway: 100-500ms of latency, then success or failure by FAIL_RATE. Internal, so safe to re-run. */
export function createMockCharge(
  failRate: number,
  random: () => number = Math.random,
): PaymentRequestedDeps["charge"] {
  return async (_orderId, _amount, userId) => {
    await sleep(100 + random() * 400);
    // Test-only determinism: a userId prefix picks the result. Ignored outside NODE_ENV=test.
    const forced =
      process.env.NODE_ENV === "test" && userId?.startsWith("fail-")
        ? "FAILED"
        : process.env.NODE_ENV === "test" && userId?.startsWith("ok-")
          ? "SUCCEEDED"
          : undefined;
    return {
      status: forced ?? (random() < failRate ? "FAILED" : "SUCCEEDED"),
      chargeId: `ch_${randomUUID()}`,
    };
  };
}

/**
 * - `charged`    new order: this call charged it and published the result
 * - `replayed`   already decided: the stored result was published again, no charge
 * - `recharged`  a worker died mid-charge: this call re-ran the mock charge, stored it and published
 * - `in_flight`  another worker is charging right now; nothing to do (the order service asks again
 *                if no answer ever comes)
 */
export type PaymentRequestResult = "charged" | "replayed" | "recharged" | "in_flight";

/**
 * PaymentRequested -> a payments row and one PaymentProcessed.
 *
 * Two steps so a crash is recoverable: insert the row as PROCESSING, then (after the charge) update
 * it with the result. The insert is ON CONFLICT DO NOTHING on the order, so the first request wins
 * and every repeat takes the replay path. The caller commits the Kafka offset only after this
 * resolves, which is after the database write and the publish; if either throws, the message comes
 * again and lands on `replayed` or `recharged`.
 */
export async function handlePaymentRequested(
  request: { orderId: string; amount: number; userId?: string },
  deps: PaymentRequestedDeps,
  logger: Logger,
): Promise<PaymentRequestResult> {
  const { orderId, amount, userId } = request;
  const { store, staleMs = STALE_PROCESSING_MS } = deps;

  const publishStored = async (): Promise<boolean> => {
    const row = await store.find(orderId);
    if (!row || row.status === "PROCESSING" || !row.chargeId) {
      return false;
    }
    await deps.publish(event(orderId, row.status, row.chargeId));
    return true;
  };

  const chargeAndPublish = async (): Promise<void> => {
    const outcome = await deps.charge(orderId, amount, userId);
    if (await store.complete(orderId, outcome.status, outcome.chargeId)) {
      paymentsDecided.inc({ status: outcome.status });
      faultPoint("after_payment_store_before_publish");
      await deps.publish(event(orderId, outcome.status, outcome.chargeId));
    } else {
      // Someone else finished it first; their stored result is the answer.
      await publishStored();
    }
  };

  if (await store.insertProcessing(orderId, amount)) {
    faultPoint("after_payment_insert_before_charge");
    await chargeAndPublish();
    logger.info("payment charged", { orderId });
    return "charged";
  }

  if (await publishStored()) {
    logger.info("payment already decided, stored result re-published", { orderId });
    return "replayed";
  }

  // Still PROCESSING: the row exists but has no result.
  if (await store.claimStale(orderId, staleMs)) {
    await chargeAndPublish();
    logger.warn("payment was stuck PROCESSING, charged again", { orderId });
    return "recharged";
  }

  logger.info("payment in flight elsewhere, skipped", { orderId });
  return "in_flight";
}

function event(
  orderId: string,
  status: "SUCCEEDED" | "FAILED",
  chargeId: string,
): PaymentProcessedEvent {
  return {
    type: PAYMENT_PROCESSED,
    eventId: `${orderId}-payment-v1`,
    orderId,
    status,
    chargeId,
    timestamp: new Date().toISOString(),
  };
}
