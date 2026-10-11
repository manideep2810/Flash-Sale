"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { EventCover } from "@/components/EventCover";
import { ArrowLeftIcon, CheckIcon, ClockIcon, CrossIcon } from "@/components/Icons";
import { SignInPrompt } from "@/components/SignInPrompt";
import { type CatalogueEvent, getEvent, getOrder, type Order, toFailure } from "@/lib/api";
import { eventOfOrder, formatPrice, segment } from "@/lib/format";
import { paymentFailedKey, sentenceForOrder } from "@/lib/messages";
import { useSession } from "@/lib/session";

type Outcome = "good" | "bad" | "pending";

function outcomeOf(state: string): Outcome {
  if (state === "PAID" || state === "CONFIRMED") {
    return "good";
  }
  return state === "HELD" || state === "PAYMENT_PENDING" ? "pending" : "bad";
}

/** What to add under the headline: what happened to the money and the tickets. */
function detailFor(state: string, sawPaymentFail: boolean): string {
  switch (state) {
    case "PAID":
    case "CONFIRMED":
      return "You're going. Keep this page for your order reference.";
    case "PAYMENT_FAILED":
      return "Nothing was charged, and the tickets went back on sale. You can join the queue again.";
    case "RELEASED":
      return sawPaymentFail
        ? "Nothing was charged, and the tickets went back on sale. You can join the queue again."
        : "The tickets went back on sale. Nothing was charged.";
    case "EXPIRED":
      return "The checkout clock ran out before the payment. Nothing was charged.";
    case "HELD":
      return "The tickets are still yours for a little while: finish at the checkout.";
    case "PAYMENT_PENDING":
      return "This usually takes a few seconds. Refresh to see the outcome.";
    case "REFUNDED":
      return "The amount is on its way back to you.";
    default:
      return "";
  }
}

/** The result: one sentence for what became of the order, and the order itself as a ticket stub. */
export default function OrderPage() {
  const orderId = segment(useParams().orderId);
  const { ready, session } = useSession();
  const [order, setOrder] = useState<Order | null>(null);
  const [event, setEvent] = useState<CatalogueEvent | null>(null);
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

  // What the order was for. Display only.
  const eventId = order?.eventId ?? eventOfOrder(orderId);
  useEffect(() => {
    if (!eventId) {
      return;
    }
    let current = true;
    getEvent(eventId).then(
      (loaded) => current && setEvent(loaded),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [eventId]);

  if (!ready) {
    return null;
  }
  if (!session) {
    return <SignInPrompt what="to see your order" />;
  }

  const outcome = order ? outcomeOf(order.state) : "pending";
  const unfinished = order && (order.state === "HELD" || order.state === "PAYMENT_PENDING");
  const eventHref = eventId ? `/events/${encodeURIComponent(eventId)}` : "/";

  return (
    <section className={`result result--${outcome}`}>
      <p className="eyebrow">Your order</p>
      {problem ? (
        <p className="alert" role="alert">
          {problem}
        </p>
      ) : null}
      {!order && !problem ? (
        <p className="muted">
          <span className="spinner spinner--small" aria-hidden="true" /> Loading…
        </p>
      ) : null}

      {order ? (
        <>
          <span className="result__icon" aria-hidden="true">
            {outcome === "good" ? (
              <CheckIcon size={32} />
            ) : outcome === "bad" ? (
              <CrossIcon size={32} />
            ) : (
              <ClockIcon size={32} />
            )}
          </span>
          <h1 className="result__title" data-testid="result">
            {sentenceForOrder(order.state, sawPaymentFail)}
          </h1>
          <p className="muted">{detailFor(order.state, sawPaymentFail)}</p>

          <div className="stub">
            <div className="stub__main">
              {event ? <EventCover event={event} className="cover--thumb" eager /> : null}
              <div>
                <p className="stub__name">{event?.name ?? order.eventId}</p>
                <p className="muted">
                  {order.qty} {order.qty === 1 ? "ticket" : "tickets"}
                </p>
              </div>
            </div>
            <dl className="stub__side">
              <div>
                <dt>{outcome === "good" ? "Paid" : "Amount"}</dt>
                <dd>
                  {order.amount !== null
                    ? formatPrice(order.amount)
                    : event
                      ? formatPrice(event.price * order.qty)
                      : "—"}
                </dd>
              </div>
              <div>
                <dt>Order</dt>
                <dd>
                  <code>{order.id}</code>
                </dd>
              </div>
            </dl>
          </div>
        </>
      ) : null}

      <div className="result__actions">
        {unfinished ? (
          <Link className="btn btn--primary" href={`/checkout/${encodeURIComponent(orderId)}`}>
            Go to checkout
          </Link>
        ) : null}
        <Link className="back-link" href={eventHref}>
          <ArrowLeftIcon size={16} /> Back to the event
        </Link>
        <Link className="back-link" href="/">
          Browse all events
        </Link>
      </div>
    </section>
  );
}
