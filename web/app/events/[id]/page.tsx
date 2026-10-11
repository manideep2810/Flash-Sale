"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Countdown } from "@/components/Countdown";
import { type EventInfo, getEventInfo, toFailure } from "@/lib/api";
import { formatPrice, formatTime, segment } from "@/lib/format";
import { useSession } from "@/lib/session";

/** The event: what it is, when the sale opens, and the way into its waiting room. */
export default function EventPage() {
  const eventId = segment(useParams().id);
  const { ready, session } = useSession();
  const [info, setInfo] = useState<EventInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Ticks once a second so the button enables itself the moment the lobby opens.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }
    let current = true;
    setProblem(null);
    getEventInfo(eventId).then(
      (loaded) => current && setInfo(loaded),
      (error) => current && setProblem(toFailure(error).message),
    );
    return () => {
      current = false;
    };
  }, [eventId, session]);

  if (!ready) {
    return null;
  }
  if (!session) {
    return <p>Log in above to see this event.</p>;
  }
  if (problem) {
    return <p role="alert">{problem}</p>;
  }
  if (!info) {
    return <p>Loading…</p>;
  }

  const lobbyOpen = now >= info.lobbyOpensAt;
  const saleOpen = now >= info.saleOpensAt;
  const soldOut = info.state === "SOLD_OUT";

  return (
    <>
      <h1>{info.name}</h1>
      <dl>
        {info.price === null ? null : (
          <>
            <dt>Price</dt>
            <dd>{formatPrice(info.price)}</dd>
          </>
        )}
        <dt>Sale opens</dt>
        <dd>
          {saleOpen ? (
            "The sale is open"
          ) : (
            <>
              in <Countdown to={info.saleOpensAt} done="now" /> (at {formatTime(info.saleOpensAt)})
            </>
          )}
        </dd>
      </dl>

      {soldOut ? (
        <p className="big">Sold out.</p>
      ) : lobbyOpen ? (
        <p>
          <Link href={`/events/${encodeURIComponent(eventId)}/queue`}>
            <button type="button">Join queue</button>
          </Link>
        </p>
      ) : (
        <p>
          <button type="button" disabled>
            Join queue
          </button>{" "}
          Opens at {formatTime(info.lobbyOpensAt)}
        </p>
      )}
      {lobbyOpen && !saleOpen && !soldOut ? (
        <p>The lobby is open: join now and you get a random place in line when the sale opens.</p>
      ) : null}
    </>
  );
}
