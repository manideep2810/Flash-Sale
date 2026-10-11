"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CountdownTimer } from "@/components/Countdown";
import { EventCover } from "@/components/EventCover";
import { ArrowLeftIcon, MinusIcon, PlusIcon, ShieldIcon } from "@/components/Icons";
import { SignInPrompt } from "@/components/SignInPrompt";
import { type Turn, useAdmission } from "@/lib/admission";
import { type CatalogueEvent, getEvent, getQueueStatus, reserve, toFailure } from "@/lib/api";
import { formatPrice, formatTime, segment } from "@/lib/format";
import { useSession } from "@/lib/session";

/** There is no per-user limit in the backend to read; the selector simply stops here. */
const MAX_QTY = 4;
const MAX_RATE_LIMIT_RETRIES = 3;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Your turn: a short window, kept by the server, in which you may reserve. */
export default function BuyPage() {
  const eventId = segment(useParams().id);
  const router = useRouter();
  const { ready, session } = useSession();
  const admission = useAdmission();

  const [turn, setTurn] = useState<Turn | null>(() => admission.get(eventId));
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [soldOut, setSoldOut] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const eventPath = `/events/${encodeURIComponent(eventId)}`;
  const queuePath = `${eventPath}/queue`;

  // What is being bought, and for how much. Display only: reserving needs the id and nothing else.
  const [event, setEvent] = useState<CatalogueEvent | null>(null);
  useEffect(() => {
    let current = true;
    getEvent(eventId).then(
      (loaded) => current && setEvent(loaded),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [eventId]);

  /**
   * Asks the server whether it is still this user's turn. ADMITTED returns the token again (it is
   * the same turn, not a new one); anything else means the turn is over or never was.
   */
  const checkTurn = useCallback(async (): Promise<Turn | "over" | "unknown"> => {
    try {
      const status = await getQueueStatus(eventId);
      if (status.status === "ADMITTED") {
        const current = { token: status.token, expiresAt: status.expiresAt };
        admission.set(eventId, current);
        return current;
      }
      admission.clear(eventId);
      return "over";
    } catch {
      // A lost session has already brought the login prompt back; anything else is not an answer.
      return "unknown";
    }
  }, [admission, eventId]);

  // After a refresh the token is gone from memory, by design. Get it again, once.
  useEffect(() => {
    if (!session || turn) {
      return;
    }
    let current = true;
    checkTurn().then((result) => {
      if (!current) {
        return;
      }
      if (result === "over") {
        router.replace(queuePath);
      } else if (result === "unknown") {
        setProblem("Your turn could not be confirmed. Go back to the queue.");
      } else {
        setTurn(result);
      }
    });
    return () => {
      current = false;
    };
  }, [session, turn, checkTurn, router, queuePath]);

  const turnOver = useCallback(() => {
    admission.clear(eventId);
    router.replace(`${queuePath}?expired=1`);
  }, [admission, eventId, router, queuePath]);

  /**
   * The countdown reached the server's expiry time. Whether the turn is over is still the server's
   * to say, and this clock may be a little ahead of it, so ask, and ask again for a few seconds.
   */
  const onCountdownDone = useCallback(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = await checkTurn();
      if (now === "over") {
        turnOver();
        return;
      }
      if (now === "unknown") {
        return;
      }
      await wait(1_000);
    }
  }, [checkTurn, turnOver]);

  async function submit() {
    if (!turn || busy) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const { holdId } = await reserve(eventId, qty, turn.token);
          router.push(`/checkout/${encodeURIComponent(holdId)}`);
          return;
        } catch (error) {
          const failure = toFailure(error);
          if (failure.rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
            await wait(failure.retryAfterMs ?? 1_000);
            continue;
          }
          if (failure.code === "SOLD_OUT") {
            setSoldOut(true);
            return;
          }
          if (failure.status === 401 && failure.code !== "TOKEN_INVALID") {
            // UNAUTHENTICATED (the gateway), TOKEN_EXPIRED or ADMISSION_REQUIRED (the service).
            // Through the gateway an expired turn and an expired session look the same, so ask:
            // a status call fails too if it was the session, and the login prompt takes over.
            const now = await checkTurn();
            if (now === "over") {
              turnOver();
            } else if (now === "unknown") {
              setProblem("Your turn could not be confirmed. Go back to the queue.");
            } else {
              setTurn(now);
              setProblem("That did not go through. Try again.");
            }
            return;
          }
          // 403 TOKEN_MISMATCH, 401 TOKEN_INVALID, and anything unexpected.
          setProblem(failure.message);
          return;
        }
      }
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return null;
  }
  if (!session) {
    return <SignInPrompt what="to continue" />;
  }
  if (soldOut) {
    return (
      <section className="panel panel--center">
        <h1 className="panel__title">Sold out.</h1>
        <p className="muted">The last tickets were taken a moment before you reserved.</p>
        <Link className="back-link" href={eventPath}>
          <ArrowLeftIcon size={16} /> Back to the event
        </Link>
      </section>
    );
  }

  return (
    <section className="buy">
      <h1 className="visually-hidden">It's your turn</h1>
      {turn ? (
        <>
          <div className="turn-banner">
            <div>
              <p className="eyebrow">You're in</p>
              <p className="turn-banner__text">
                It's your turn — you have until {formatTime(turn.expiresAt)}
              </p>
            </div>
            <p className="turn-banner__clock">
              <CountdownTimer to={turn.expiresAt} onDone={onCountdownDone} done="time is up" />
            </p>
          </div>

          <div className="buy__card">
            <div className="buy__event">
              {event ? <EventCover event={event} className="cover--thumb" eager /> : null}
              <div>
                <p className="buy__name">{event?.name ?? "Your tickets"}</p>
                {event ? <p className="muted">{formatPrice(event.price)} per ticket</p> : null}
              </div>
            </div>

            <div className="buy__row">
              <span id="qty-label" className="field__label">
                Tickets
              </span>
              <fieldset className="stepper" aria-labelledby="qty-label">
                <button
                  type="button"
                  aria-label="One ticket fewer"
                  onClick={() => setQty((value) => Math.max(1, value - 1))}
                  disabled={busy || qty <= 1}
                >
                  <MinusIcon size={18} />
                </button>
                <output className="stepper__value" aria-live="polite" data-testid="qty">
                  {qty}
                </output>
                <button
                  type="button"
                  aria-label="One ticket more"
                  onClick={() => setQty((value) => Math.min(MAX_QTY, value + 1))}
                  disabled={busy || qty >= MAX_QTY}
                >
                  <PlusIcon size={18} />
                </button>
              </fieldset>
            </div>

            {event ? (
              <div className="buy__row buy__row--total">
                <span>Total</span>
                <strong data-testid="total">{formatPrice(event.price * qty)}</strong>
              </div>
            ) : null}

            <button
              type="button"
              className="btn btn--primary btn--block btn--large"
              onClick={submit}
              disabled={busy}
            >
              {busy ? "Reserving…" : qty === 1 ? "Reserve 1 ticket" : `Reserve ${qty} tickets`}
            </button>
            <p className="buy__small">
              <ShieldIcon size={16} /> Reserving holds your tickets while you pay. Nothing is
              charged yet.
            </p>
          </div>
        </>
      ) : problem ? null : (
        <div className="panel panel--center">
          <span className="spinner" aria-hidden="true" />
          <p className="muted">Checking your turn…</p>
        </div>
      )}
      {problem ? (
        <div className="panel panel--center">
          <p className="alert" role="alert">
            {problem}
          </p>
          <Link className="back-link" href={queuePath}>
            <ArrowLeftIcon size={16} /> Back to the queue
          </Link>
        </div>
      ) : null}
    </section>
  );
}
