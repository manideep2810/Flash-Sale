"use client";

import { useCallback, useState } from "react";
import { EventCard } from "@/components/EventBits";
import { BoltIcon } from "@/components/Icons";
import { type ApiFailure, type CatalogueEvent, type EventStatus, listEvents } from "@/lib/api";
import { statusNow, useServerNow } from "@/lib/events";
import { usePolling } from "@/lib/usePolling";

/** How often the listing is read again: what moves between reads is the stock, not the events. */
const REFRESH_MS = 10_000;

type Filter = "ALL" | "LIVE" | "SOON" | "SOLD_OUT";

const FILTERS: { key: Filter; label: string; matches: (status: EventStatus) => boolean }[] = [
  { key: "ALL", label: "All events", matches: () => true },
  { key: "LIVE", label: "On sale", matches: (status) => status === "LIVE" },
  {
    key: "SOON",
    label: "Opening soon",
    matches: (status) => status === "LOBBY" || status === "UPCOMING",
  },
  { key: "SOLD_OUT", label: "Sold out", matches: (status) => status === "SOLD_OUT" },
];

/** What is on first: sales that are on, then lobbies, then what is coming, then what is gone. */
const ORDER: Record<EventStatus, number> = { LIVE: 0, LOBBY: 1, UPCOMING: 2, SOLD_OUT: 3 };

/** The front page: every event, with where it stands right now. Anyone can see it, logged in or not. */
export default function EventsPage() {
  const [events, setEvents] = useState<CatalogueEvent[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const now = useServerNow();

  const onResult = useCallback((loaded: CatalogueEvent[]) => {
    setEvents(loaded);
    setProblem(null);
  }, []);
  const onError = useCallback((failure: ApiFailure) => setProblem(failure.message), []);
  const { unavailable } = usePolling<CatalogueEvent[]>({
    enabled: true,
    firstDelayMs: 0,
    fetcher: listEvents,
    nextDelayMs: () => REFRESH_MS,
    onResult,
    onError,
  });

  const withStatus = (events ?? []).map((event) => ({ event, status: statusNow(event, now) }));
  const liveCount = withStatus.filter(({ status }) => status === "LIVE").length;
  const active = FILTERS.find(({ key }) => key === filter) ?? FILTERS[0];
  const shown = withStatus
    .filter(({ status }) => active?.matches(status))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.event.saleOpensAt - b.event.saleOpensAt);

  return (
    <>
      <section className="hero">
        <p className="hero__kicker">
          <BoltIcon size={14} />
          {liveCount > 0
            ? `${liveCount} ${liveCount === 1 ? "sale" : "sales"} live right now`
            : "Limited tickets. Fair queues."}
        </p>
        <h1 className="hero__title">
          Tickets drop fast.
          <br />
          <em>Be in line.</em>
        </h1>
        <p className="hero__lead">
          Join the lobby before a sale opens and you get a random place in the queue. When it is
          your turn, the tickets are held while you pay.
        </p>
      </section>

      <section aria-labelledby="events-heading">
        <div className="section-head">
          <h2 id="events-heading">Events</h2>
          <fieldset className="tabs" aria-label="Filter events">
            {FILTERS.map(({ key, label, matches }) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                className="tab"
                onClick={() => setFilter(key)}
              >
                {label}
                <span className="tab__count">
                  {withStatus.filter(({ status }) => matches(status)).length}
                </span>
              </button>
            ))}
          </fieldset>
        </div>

        {problem ? (
          <p className="alert" role="alert">
            {problem}
          </p>
        ) : null}
        {unavailable && !problem ? (
          <p className="alert" role="alert">
            {events
              ? "The server cannot be reached. These numbers may be out of date."
              : "The events cannot be loaded right now. Still trying…"}
          </p>
        ) : null}

        {events === null && !problem ? (
          <div className="event-grid" aria-hidden="true">
            {["a", "b", "c"].map((key) => (
              <div className="event-card event-card--skeleton" key={key} />
            ))}
          </div>
        ) : null}

        {events !== null && shown.length === 0 ? (
          <div className="empty">
            <p className="empty__title">
              {events.length === 0 ? "No events yet" : "Nothing here right now"}
            </p>
            <p className="muted">
              {events.length === 0
                ? "When a sale is announced it will show up here."
                : "Try another filter."}
            </p>
          </div>
        ) : null}

        <div className="event-grid">
          {shown.map(({ event }) => (
            <EventCard key={event.id} event={event} now={now} />
          ))}
        </div>
      </section>
    </>
  );
}
