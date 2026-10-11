"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { CountdownClock } from "@/components/Countdown";
import { StatusBadge, StockMeter } from "@/components/EventBits";
import { EventCover } from "@/components/EventCover";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  CardIcon,
  ClockIcon,
  UsersIcon,
} from "@/components/Icons";
import { type ApiFailure, type CatalogueEvent, getEvent } from "@/lib/api";
import { statusNow, useServerNow } from "@/lib/events";
import { formatDateTime, formatPrice, segment } from "@/lib/format";
import { useSession } from "@/lib/session";
import { usePolling } from "@/lib/usePolling";

/** How often the event is read again while the page is open: for the stock, and a sold-out. */
const REFRESH_MS = 10_000;

/** The event: what it is, when the sale opens, and the way into its waiting room. Public. */
export default function EventPage() {
  const eventId = segment(useParams().id);
  const { ready, session } = useSession();
  const [event, setEvent] = useState<CatalogueEvent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useServerNow();

  const fetcher = useCallback(() => getEvent(eventId), [eventId]);
  const onResult = useCallback((loaded: CatalogueEvent) => {
    setEvent(loaded);
    setProblem(null);
  }, []);
  const onError = useCallback((failure: ApiFailure) => setProblem(failure.message), []);
  const { unavailable } = usePolling<CatalogueEvent>({
    enabled: true,
    firstDelayMs: 0,
    fetcher,
    nextDelayMs: () => REFRESH_MS,
    onResult,
    onError,
  });

  /** A clock on the page reached zero: read the event again now, not at the next refresh. */
  const refresh = useCallback(() => {
    getEvent(eventId).then(setEvent, () => {});
  }, [eventId]);

  const back = (
    <Link className="back-link" href="/">
      <ArrowLeftIcon size={16} /> All events
    </Link>
  );

  if (problem) {
    return (
      <section className="panel panel--center">
        <h1 className="panel__title">{problem}</h1>
        {back}
      </section>
    );
  }
  if (!event) {
    return (
      <section className="panel panel--center">
        <p className="muted" role={unavailable ? "alert" : undefined}>
          {unavailable ? "The server cannot be reached. Still trying…" : "Loading…"}
        </p>
      </section>
    );
  }

  const status = statusNow(event, now);
  const queueHref = `/events/${encodeURIComponent(eventId)}/queue`;
  const loginHref = `/login?next=${encodeURIComponent(`/events/${encodeURIComponent(eventId)}`)}`;

  return (
    <article className="event">
      {back}
      <header className="event__hero">
        <EventCover event={event} eager />
        <div className="event__hero-text">
          <StatusBadge status={status} />
          <h1>{event.name}</h1>
          <p className="event__meta">
            <CalendarIcon size={16} />
            {status === "UPCOMING" || status === "LOBBY"
              ? `Sale opens ${formatDateTime(event.saleOpensAt)}`
              : `On sale since ${formatDateTime(event.saleOpensAt)}`}
          </p>
        </div>
      </header>

      <div className="event__layout">
        <div className="event__main">
          <section>
            <h2>About this event</h2>
            <p className="event__description">
              {event.description || "Details will be announced soon."}
            </p>
          </section>

          <section>
            <h2>How the sale works</h2>
            <ol className="steps">
              <li>
                <span className="steps__icon">
                  <UsersIcon size={20} />
                </span>
                <div>
                  <h3>Join the line</h3>
                  <p>
                    Arrive while the lobby is open and you draw a random place when the sale starts.
                    After that, it is first come, first served.
                  </p>
                </div>
              </li>
              <li>
                <span className="steps__icon">
                  <ClockIcon size={20} />
                </span>
                <div>
                  <h3>Wait for your turn</h3>
                  <p>
                    Keep the page open. It shows your place and moves on by itself when you are in.
                  </p>
                </div>
              </li>
              <li>
                <span className="steps__icon">
                  <CardIcon size={20} />
                </span>
                <div>
                  <h3>Reserve, then pay</h3>
                  <p>
                    Your tickets are held for you from the moment you reserve until the checkout
                    clock runs out.
                  </p>
                </div>
              </li>
            </ol>
          </section>
        </div>

        <aside className="ticket-panel" aria-label="Tickets">
          <p className="price price--large">
            <span className="price__label">per ticket</span>
            {formatPrice(event.price)}
          </p>

          {status === "UPCOMING" ? (
            <div className="ticket-panel__block">
              <p className="eyebrow">Lobby opens in</p>
              <CountdownClock to={event.lobbyOpensAt} onDone={refresh} />
              <p className="muted">Opens {formatDateTime(event.lobbyOpensAt)}</p>
            </div>
          ) : null}
          {status === "LOBBY" ? (
            <div className="ticket-panel__block">
              <p className="eyebrow">Sale opens in</p>
              <CountdownClock to={event.saleOpensAt} onDone={refresh} />
              <p className="muted">
                The lobby is open: join now and you get a random place in line when the sale opens.
              </p>
            </div>
          ) : null}
          {status === "LIVE" ? (
            <div className="ticket-panel__block">
              <p className="eyebrow eyebrow--live">The sale is open</p>
              <StockMeter event={event} status={status} />
            </div>
          ) : null}
          {status === "SOLD_OUT" ? (
            <div className="ticket-panel__block">
              <p className="big">Sold out.</p>
              <p className="muted">Every ticket for this event has been bought.</p>
            </div>
          ) : null}

          {status === "SOLD_OUT" ? (
            <Link className="btn btn--ghost btn--block" href="/">
              Browse other events
            </Link>
          ) : status === "UPCOMING" ? (
            <button type="button" className="btn btn--primary btn--block" disabled>
              Join queue
            </button>
          ) : !ready ? null : session ? (
            <Link className="btn btn--primary btn--block" href={queueHref}>
              Join queue <ArrowRightIcon size={18} />
            </Link>
          ) : (
            <Link className="btn btn--primary btn--block" href={loginHref}>
              Log in to join the queue
            </Link>
          )}
          <p className="ticket-panel__small">Up to 4 tickets per order.</p>
        </aside>
      </div>
    </article>
  );
}
