"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CountdownTimer } from "@/components/Countdown";
import { EventCover } from "@/components/EventCover";
import { CardIcon, ClockIcon, LockIcon } from "@/components/Icons";
import { SignInPrompt } from "@/components/SignInPrompt";
import {
  type CatalogueEvent,
  getEvent,
  getOrder,
  type Order,
  payOrder,
  SETTLED_STATES,
  serverNow,
  toFailure,
} from "@/lib/api";
import { formatPrice, formatTime, segment } from "@/lib/format";
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

// ---- the card form -----------------------------------------------------------------------------------
//
// It looks like a card form and checks what is typed like one, and that is all it does: THE CARD
// DETAILS NEVER LEAVE THIS COMPONENT. They are not sent to our backend or anywhere else; the payment
// is made by a mock service that knows nothing but the order. The form comes filled in with a test
// card so that paying is one click, and the page says that it is a demo.

interface Card {
  number: string;
  name: string;
  expiry: string;
  cvc: string;
}

type CardProblems = Partial<Record<keyof Card, string>>;

const digitsOf = (value: string) => value.replace(/\D/g, "");

/** "4242424242424242" -> "4242 4242 4242 4242". */
const formatCardNumber = (value: string) =>
  digitsOf(value)
    .slice(0, 19)
    .replace(/(.{4})(?=.)/g, "$1 ");

/** "1230" -> "12/30". */
function formatExpiry(value: string): string {
  const digits = digitsOf(value).slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

function problemsOf(card: Card): CardProblems {
  const problems: CardProblems = {};
  const number = digitsOf(card.number);
  if (number.length < 12) {
    problems.number = "Enter the full card number.";
  }
  if (card.name.trim() === "") {
    problems.name = "Enter the name on the card.";
  }
  const [month, year] = card.expiry.split("/").map(Number);
  if (!month || year === undefined || month > 12 || card.expiry.length !== 5) {
    problems.expiry = "Enter the expiry as MM/YY.";
  } else {
    // A card is good through the last day of its month.
    const now = new Date(serverNow());
    const thisMonth = (now.getFullYear() % 100) * 12 + now.getMonth() + 1;
    if (year * 12 + month < thisMonth) {
      problems.expiry = "This card has expired.";
    }
  }
  if (!/^\d{3,4}$/.test(card.cvc)) {
    problems.cvc = "3 or 4 digits.";
  }
  return problems;
}

/** The hold: the order's summary, a countdown to the server's expiry time, and the way to pay. */
export default function CheckoutPage() {
  const orderId = segment(useParams().orderId);
  const router = useRouter();
  const { ready, session } = useSession();

  const [order, setOrder] = useState<Order | null>(null);
  const [step, setStep] = useState<Step>("confirming");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);

  const [card, setCard] = useState<Card>({
    number: "4242 4242 4242 4242",
    name: "",
    expiry: "12/30",
    cvc: "123",
  });
  const [cardProblems, setCardProblems] = useState<CardProblems>({});
  // The name on the test card is whoever is paying, until they type another.
  useEffect(() => {
    if (session) {
      setCard((current) => (current.name === "" ? { ...current, name: session.userId } : current));
    }
  }, [session]);

  const resultPath = `/orders/${encodeURIComponent(orderId)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // What the order is for. Display only; an order of an event with no catalogue entry still pays.
  const [event, setEvent] = useState<CatalogueEvent | null>(null);
  const eventId = order?.eventId;
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

  async function pay(submitted: FormEvent) {
    submitted.preventDefault();
    if (busy) {
      return;
    }
    // Checked like a real form, and then left where it is: none of it is sent.
    const found = problemsOf(card);
    setCardProblems(found);
    if (Object.keys(found).length > 0) {
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
    return <SignInPrompt what="to see your order" />;
  }

  // What will be charged: the order's own amount once payment has been asked for, and until then
  // the event's price for the tickets held (which is how the order service works it out).
  const total = order?.amount ?? (order && event ? event.price * order.qty : null);
  const canPay = step === "holding" || step === "confirming";
  const edit = (field: keyof Card, value: string) => {
    setCard((current) => ({ ...current, [field]: value }));
    setCardProblems((current) => ({ ...current, [field]: undefined }));
  };

  return (
    <section className="checkout">
      <h1>Checkout</h1>

      <div className="checkout__grid">
        <div className="checkout__pay">
          {order && canPay ? (
            <div className="hold-banner">
              <ClockIcon size={18} />
              <p>
                Your item is held until {formatTime(order.expiresAt)}
                <span className="visually-hidden">: </span>
              </p>
              <strong className="hold-banner__clock">
                <CountdownTimer to={order.expiresAt} onDone={onHoldOver} done="time is up" />
              </strong>
            </div>
          ) : null}

          {step === "processing" ? (
            <div className="panel panel--center panel--flat">
              <span className="spinner" aria-hidden="true" />
              <p className="big">Processing payment…</p>
              <p className="muted">Do not close this page. This usually takes a few seconds.</p>
            </div>
          ) : null}
          {step === "expired" ? (
            <div className="panel panel--center panel--flat">
              <p className="big">Your hold expired</p>
              <p className="muted">The tickets went back on sale.</p>
              <Link className="btn btn--ghost" href={resultPath}>
                See your order
              </Link>
            </div>
          ) : null}
          {step === "slow" ? (
            <div className="panel panel--center panel--flat">
              <p className="big">This is taking longer than usual.</p>
              <Link className="btn btn--ghost" href={resultPath}>
                See your order
              </Link>
            </div>
          ) : null}

          {canPay ? (
            <form className="pay-form" onSubmit={pay} noValidate>
              <div className="pay-form__head">
                <h2>
                  <CardIcon size={20} /> Pay by card
                </h2>
                <span className="pill">Demo</span>
              </div>
              <p className="pay-form__note">
                <LockIcon size={16} />
                This is a demo checkout. A test card is filled in, nothing you type here leaves your
                browser, and no card is charged.
              </p>

              <label className="field">
                <span className="field__label">Card number</span>
                <input
                  name="cardNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="1234 5678 9012 3456"
                  value={card.number}
                  onChange={(change) => edit("number", formatCardNumber(change.target.value))}
                  aria-invalid={cardProblems.number !== undefined}
                />
                {cardProblems.number ? (
                  <span className="field__error">{cardProblems.number}</span>
                ) : null}
              </label>

              <label className="field">
                <span className="field__label">Name on card</span>
                <input
                  name="cardName"
                  autoComplete="off"
                  placeholder="A. Cardholder"
                  value={card.name}
                  onChange={(change) => edit("name", change.target.value)}
                  aria-invalid={cardProblems.name !== undefined}
                />
                {cardProblems.name ? (
                  <span className="field__error">{cardProblems.name}</span>
                ) : null}
              </label>

              <div className="field-row">
                <label className="field">
                  <span className="field__label">Expiry</span>
                  <input
                    name="cardExpiry"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="MM/YY"
                    value={card.expiry}
                    onChange={(change) => edit("expiry", formatExpiry(change.target.value))}
                    aria-invalid={cardProblems.expiry !== undefined}
                  />
                  {cardProblems.expiry ? (
                    <span className="field__error">{cardProblems.expiry}</span>
                  ) : null}
                </label>
                <label className="field">
                  <span className="field__label">Security code</span>
                  <input
                    name="cardCvc"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="CVC"
                    value={card.cvc}
                    onChange={(change) => edit("cvc", digitsOf(change.target.value).slice(0, 4))}
                    aria-invalid={cardProblems.cvc !== undefined}
                  />
                  {cardProblems.cvc ? (
                    <span className="field__error">{cardProblems.cvc}</span>
                  ) : null}
                </label>
              </div>

              {step === "confirming" ? (
                <p className="muted pay-form__status">
                  <span className="spinner spinner--small" aria-hidden="true" /> Confirming your
                  reservation…
                </p>
              ) : null}
              {problem ? (
                <p className="alert" role="alert">
                  {problem}
                </p>
              ) : null}

              <button
                type="submit"
                className="btn btn--primary btn--block btn--large"
                disabled={busy || !order}
              >
                <LockIcon size={18} />
                {busy ? "Paying…" : total === null ? "Pay" : `Pay ${formatPrice(total)}`}
              </button>
            </form>
          ) : problem ? (
            <p className="alert" role="alert">
              {problem}
            </p>
          ) : null}
        </div>

        <aside className="summary" aria-label="Order summary">
          <h2>Order summary</h2>
          {order ? (
            <>
              <div className="summary__event">
                {event ? <EventCover event={event} className="cover--thumb" eager /> : null}
                <div>
                  <p className="summary__name">{event?.name ?? order.eventId}</p>
                  <p className="muted">
                    {order.qty} {order.qty === 1 ? "ticket" : "tickets"}
                  </p>
                </div>
              </div>
              <dl className="summary__lines">
                {event ? (
                  <div>
                    <dt>
                      {order.qty} × {formatPrice(event.price)}
                    </dt>
                    <dd>{formatPrice(event.price * order.qty)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Booking fee</dt>
                  <dd>Free</dd>
                </div>
                <div className="summary__total">
                  <dt>Total</dt>
                  <dd data-testid="total">{total === null ? "—" : formatPrice(total)}</dd>
                </div>
              </dl>
              <p className="summary__ref">
                Order <code>{order.id}</code>
              </p>
            </>
          ) : (
            <p className="muted">
              <span className="spinner spinner--small" aria-hidden="true" /> Finding your
              reservation…
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
