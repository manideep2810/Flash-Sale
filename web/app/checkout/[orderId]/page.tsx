"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Countdown } from "@/components/Countdown";
import { getOrder, type Order, payOrder, SETTLED_STATES, toFailure } from "@/lib/api";
import { formatTime, segment } from "@/lib/format";
import { paymentFailedKey } from "@/lib/messages";
import { useSession } from "@/lib/session";

const POLL_MS = 1_000;
/** How long to wait for the order to exist: it is created from the reservation a moment after it. */
const ORDER_WAIT_MS = 30_000;
/** How long Pay keeps trying while the order is still being created. */
const PAY_NOT_READY_MS = 10_000;
/** How long to watch a payment before sending the user to the order page to look for themselves. */
const PAYMENT_WAIT_MS = 30_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step =
  | "confirming" // the order is not there yet
  | "holding" // on hold, waiting for Pay
  | "processing" // paid, waiting for the outcome
  | "expired"
  | "slow"; // still undecided after the wait

/** The hold: a countdown to the server's expiry time, and the Pay button. */
export default function CheckoutPage() {
  const orderId = segment(useParams().orderId);
  const router = useRouter();
  const { ready, session } = useSession();

  const [order, setOrder] = useState<Order | null>(null);
  const [step, setStep] = useState<Step>("confirming");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);

  const resultPath = `/orders/${encodeURIComponent(orderId)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Notes a failed payment for the result page, and reports whether the order is settled. */
  const settled = useCallback(
    (current: Order): boolean => {
      if (current.state === "PAYMENT_FAILED") {
        // For the result page: RELEASED does not say that a failed payment came before it.
        try {
          window.sessionStorage.setItem(paymentFailedKey(orderId), "1");
        } catch {
          // The result page will fall back to the neutral sentence.
        }
      }
      return SETTLED_STATES.includes(current.state);
    },
    [orderId],
  );

  /**
   * Reads the order once a second until `done` says to stop or the time runs out. Returns the last
   * order seen, or null if it never appeared. Each read follows the previous one's answer: a
   * setTimeout chain, not an interval.
   */
  const watch = useCallback(
    async (done: (current: Order) => boolean, forMs: number): Promise<Order | null> => {
      const deadline = Date.now() + forMs;
      let last: Order | null = null;
      while (alive.current) {
        try {
          last = await getOrder(orderId);
          if (!alive.current) {
            break;
          }
          setOrder(last);
          if (done(last)) {
            return last;
          }
        } catch (error) {
          const failure = toFailure(error);
          if (failure.unauthenticated) {
            return last;
          }
          // NOT_FOUND: not created yet. Unavailable or rate limited: try again. All wait a second.
        }
        if (Date.now() >= deadline) {
          break;
        }
        await wait(POLL_MS);
      }
      return last;
    },
    [orderId],
  );

  // On load, and so on refresh: find the order. It carries the hold's expiry time.
  useEffect(() => {
    if (!session) {
      return;
    }
    let current = true;
    watch(() => true, ORDER_WAIT_MS).then((found) => {
      if (!current) {
        return;
      }
      if (!found) {
        setProblem("Your reservation could not be confirmed. Check your order again in a moment.");
      } else if (settled(found)) {
        router.replace(resultPath);
      } else {
        setStep(found.state === "PAYMENT_PENDING" ? "processing" : "holding");
      }
    });
    return () => {
      current = false;
    };
  }, [session, watch, settled, router, resultPath]);

  /** Follows a payment to its outcome, then moves to the result page. */
  const follow = useCallback(async () => {
    setStep("processing");
    const last = await watch(settled, PAYMENT_WAIT_MS);
    if (!alive.current) {
      return;
    }
    if (last && settled(last)) {
      // Once a payment has started, the hold can no longer simply run out: the order ends PAID, or
      // the payment failed and the item is released. PAYMENT_FAILED may pass in under a second, so
      // RELEASED seen here means the same thing.
      if (last.state === "RELEASED") {
        try {
          window.sessionStorage.setItem(paymentFailedKey(orderId), "1");
        } catch {
          // The result page will fall back to the neutral sentence.
        }
      }
      router.replace(resultPath);
    } else {
      setStep("slow");
    }
  }, [watch, settled, router, resultPath, orderId]);

  // A refresh while the payment is in flight picks the watch up again.
  const following = useRef(false);
  useEffect(() => {
    if (step === "processing" && !following.current) {
      following.current = true;
      void follow();
    }
  }, [step, follow]);

  async function pay() {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    const giveUpAt = Date.now() + PAY_NOT_READY_MS;
    try {
      for (;;) {
        try {
          await payOrder(orderId);
          following.current = true;
          void follow();
          return;
        } catch (error) {
          const failure = toFailure(error);
          const notReady = failure.code === "NOT_FOUND";
          if ((notReady || failure.rateLimited) && Date.now() < giveUpAt) {
            // The order is still being created from the reservation. Ask again shortly.
            setStep("confirming");
            await wait(failure.retryAfterMs ?? POLL_MS);
            continue;
          }
          if (failure.code === "HOLD_EXPIRED") {
            setStep("expired");
          } else if (failure.code === "NOT_PAYABLE") {
            router.replace(resultPath);
          } else if (!failure.unauthenticated) {
            setStep(order ? "holding" : "confirming");
            setProblem(
              notReady
                ? "Your reservation is taking longer than usual to confirm. Try again."
                : failure.message,
            );
          }
          return;
        }
      }
    } finally {
      setBusy(false);
    }
  }

  /** The hold's time is up. The server decides what the order becomes; show it when it has. */
  const onHoldOver = useCallback(async () => {
    if (step !== "holding" && step !== "confirming") {
      return;
    }
    setStep("expired");
    const last = await watch(settled, PAYMENT_WAIT_MS);
    if (alive.current && last && settled(last)) {
      router.replace(resultPath);
    }
  }, [step, watch, settled, router, resultPath]);

  if (!ready) {
    return null;
  }
  if (!session) {
    return <p>Log in above to see your order.</p>;
  }

  return (
    <>
      <h1>Checkout</h1>
      {order && (step === "holding" || step === "confirming") ? (
        <p className="big">
          Your item is held until {formatTime(order.expiresAt)} (
          <Countdown to={order.expiresAt} onDone={onHoldOver} done="time is up" />)
        </p>
      ) : null}

      {step === "confirming" ? <p>Confirming your reservation…</p> : null}
      {step === "processing" ? <p className="big">Processing payment…</p> : null}
      {step === "expired" ? <p className="big">Your hold expired</p> : null}
      {step === "slow" ? (
        <p>
          This is taking longer than usual. <Link href={resultPath}>See your order</Link>
        </p>
      ) : null}

      {step === "holding" || step === "confirming" ? (
        <p>
          <button type="button" onClick={pay} disabled={busy || !order}>
            {busy ? "Paying…" : "Pay"}
          </button>
        </p>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {step === "expired" ? (
        <p>
          <Link href={resultPath}>See your order</Link>
        </p>
      ) : null}
    </>
  );
}
