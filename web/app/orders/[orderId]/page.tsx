"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getOrder, type Order, toFailure } from "@/lib/api";
import { eventOfOrder, segment } from "@/lib/format";
import { paymentFailedKey, sentenceForOrder } from "@/lib/messages";
import { useSession } from "@/lib/session";

/** The result: one sentence for what became of the order. */
export default function OrderPage() {
  const orderId = segment(useParams().orderId);
  const { ready, session } = useSession();
  const [order, setOrder] = useState<Order | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sawPaymentFail, setSawPaymentFail] = useState(false);

  useEffect(() => {
    if (!session) {
      return;
    }
    let current = true;
    try {
      // Set by the checkout page when it watched the payment fail (see sentenceForOrder).
      setSawPaymentFail(window.sessionStorage.getItem(paymentFailedKey(orderId)) === "1");
    } catch {
      // No storage: the neutral sentence.
    }
    getOrder(orderId).then(
      (loaded) => current && setOrder(loaded),
      (error) => {
        const failure = toFailure(error);
        if (current && !failure.unauthenticated) {
          setProblem(failure.code === "NOT_FOUND" ? "There is no such order." : failure.message);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [orderId, session]);

  if (!ready) {
    return null;
  }
  if (!session) {
    return <p>Log in above to see your order.</p>;
  }

  const eventId = eventOfOrder(orderId);
  const unfinished = order && (order.state === "HELD" || order.state === "PAYMENT_PENDING");

  return (
    <>
      <h1>Your order</h1>
      {problem ? <p role="alert">{problem}</p> : null}
      {!order && !problem ? <p>Loading…</p> : null}
      {order ? (
        <p className="big" data-testid="result">
          {sentenceForOrder(order.state, sawPaymentFail)}
        </p>
      ) : null}
      {unfinished ? (
        <p>
          <Link href={`/checkout/${encodeURIComponent(orderId)}`}>Go to checkout</Link>
        </p>
      ) : null}
      <p>
        <Link href={eventId ? `/events/${encodeURIComponent(eventId)}` : "/"}>
          Back to the event
        </Link>
      </p>
    </>
  );
}
