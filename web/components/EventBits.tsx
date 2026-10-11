"use client";

import Link from "next/link";
import type { CatalogueEvent, EventStatus } from "@/lib/api";
import { claimedPercent, isAlmostGone, STATUS_LABEL, statusNow } from "@/lib/events";
import { formatCount, formatDateTime, formatPrice } from "@/lib/format";
import { Countdown } from "./Countdown";
import { EventCover } from "./EventCover";
import { ArrowRightIcon } from "./Icons";

/** "Live now", "Lobby open", "Coming soon" or "Sold out", in the colour that goes with it. */
export function StatusBadge({ status }: { status: EventStatus }) {
  return (
    <span className={`badge badge--${status.toLowerCase().replace("_", "-")}`}>
      {status === "LIVE" ? <span className="badge__dot" aria-hidden="true" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * How much of an event is gone, once its sale is on: a bar and a sentence. Before the sale it says
 * how many tickets there will be; with the live numbers missing it says nothing.
 */
export function StockMeter({ event, status }: { event: CatalogueEvent; status: EventStatus }) {
  if (status === "UPCOMING" || status === "LOBBY") {
    return <p className="stock stock--plain">{formatCount(event.totalStock)} tickets</p>;
  }
  const claimed = claimedPercent(event);
  if (claimed === null || event.available === null) {
    return null;
  }
  const soldOut = status === "SOLD_OUT";
  const text = soldOut
    ? "All tickets are gone"
    : event.available === 0
      ? "All tickets are in checkouts right now"
      : isAlmostGone(event)
        ? `Only ${formatCount(event.available)} left`
        : claimed < 5
          ? // A sale that has barely started: the number left says more than "1% claimed".
            `${formatCount(event.available)} tickets available`
          : `${claimed}% claimed`;
  return (
    <div className={`stock${isAlmostGone(event) ? " stock--low" : ""}`}>
      <div
        className="meter"
        role="progressbar"
        aria-label="Tickets claimed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={soldOut ? 100 : claimed}
      >
        <span className="meter__fill" style={{ width: `${soldOut ? 100 : claimed}%` }} />
      </div>
      <p className="stock__text">{text}</p>
    </div>
  );
}

/** One event on the listing: its cover, where it stands, what it costs. The whole card is the link. */
export function EventCard({ event, now }: { event: CatalogueEvent; now: number }) {
  const status = statusNow(event, now);
  return (
    <Link
      className={`event-card${status === "SOLD_OUT" ? " event-card--gone" : ""}`}
      href={`/events/${encodeURIComponent(event.id)}`}
      data-testid="event-card"
    >
      <div className="event-card__media">
        <EventCover event={event} />
        <StatusBadge status={status} />
      </div>
      <div className="event-card__body">
        <h3 className="event-card__name">{event.name}</h3>
        <p className="event-card__when">
          {status === "UPCOMING" ? (
            <>
              Lobby opens in <Countdown to={event.lobbyOpensAt} />
            </>
          ) : status === "LOBBY" ? (
            <>
              Sale opens in <Countdown to={event.saleOpensAt} />
            </>
          ) : status === "LIVE" ? (
            "On sale now"
          ) : (
            `Sold ${formatDateTime(event.saleOpensAt)}`
          )}
        </p>
        <StockMeter event={event} status={status} />
        <div className="event-card__foot">
          <span className="price">
            <span className="price__label">per ticket</span>
            {formatPrice(event.price)}
          </span>
          <span className="event-card__go">
            {status === "LIVE"
              ? "Get tickets"
              : status === "LOBBY"
                ? "Enter lobby"
                : status === "UPCOMING"
                  ? "See details"
                  : "View"}
            <ArrowRightIcon size={16} />
          </span>
        </div>
      </div>
    </Link>
  );
}
