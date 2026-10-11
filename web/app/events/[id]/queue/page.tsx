"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CountdownClock } from "@/components/Countdown";
import { EventCover } from "@/components/EventCover";
import { AlertIcon, ArrowLeftIcon, ClockIcon, UsersIcon } from "@/components/Icons";
import { SignInPrompt } from "@/components/SignInPrompt";
import { useAdmission } from "@/lib/admission";
import {
  type ApiFailure,
  type CatalogueEvent,
  getEvent,
  getQueueStatus,
  joinQueue,
  type Queued,
} from "@/lib/api";
import { formatCount, formatDuration, formatTime, segment } from "@/lib/format";
import { WAITING_ROOM_UNAVAILABLE } from "@/lib/messages";
import { useSession } from "@/lib/session";
import { usePolling } from "@/lib/usePolling";

/** What one call to the waiting room came back with, whichever endpoint answered. */
type Answer =
  | Queued
  | { status: "ADMITTED"; token?: string; expiresAt?: string }
  | { status: "EXPIRED" }
  | { status: "SOLD_OUT" }
  | { status: "NOT_IN_QUEUE" };

type View =
  | { kind: "joining" }
  | { kind: "queued"; place: Queued }
  | { kind: "expired" }
  | { kind: "soldOut" }
  | { kind: "notOpen"; lobbyOpensAt: number | null }
  | { kind: "failed"; message: string };

/**
 * The waiting room. On load it joins (which is safe to repeat: a refresh keeps your place) and then
 * asks for its status at the pace the server sets, until it is this user's turn.
 */
function WaitingRoom() {
  const eventId = segment(useParams().id);
  const router = useRouter();
  const { ready, session } = useSession();
  const admission = useAdmission();
  // Sent here by the buy page when the turn ran out: say so and let the user decide to rejoin.
  const turnExpired = useSearchParams().get("expired") === "1";

  const [view, setView] = useState<View>(turnExpired ? { kind: "expired" } : { kind: "joining" });
  /** The next call is a join, not a status. True on load, after Rejoin, and once after NOT_IN_QUEUE. */
  const mustJoin = useRef(true);
  const rejoinedAfterMissing = useRef(false);
  /** The most people this user has had ahead of them: where the progress bar starts from. */
  const [startedBehind, setStartedBehind] = useState(0);

  // What the page is the waiting room of. Display only: the line works without it.
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

  const fetcher = useCallback(async (): Promise<Answer> => {
    if (mustJoin.current) {
      const joined = await joinQueue(eventId);
      mustJoin.current = false;
      return joined;
    }
    return getQueueStatus(eventId);
  }, [eventId]);

  const nextDelayMs = useCallback((answer: Answer): number | null => {
    switch (answer.status) {
      case "QUEUED":
        return answer.retryAfterMs;
      case "ADMITTED":
        // join says ADMITTED without the token; status has it, and is asked at once.
        return answer.token ? null : 0;
      case "NOT_IN_QUEUE":
        // onResult (which runs first) has decided whether to join once more.
        return mustJoin.current ? 0 : null;
      default:
        // EXPIRED and SOLD_OUT carry no retryAfterMs: stop.
        return null;
    }
  }, []);

  const onResult = useCallback(
    (answer: Answer) => {
      switch (answer.status) {
        case "QUEUED":
          rejoinedAfterMissing.current = false;
          setStartedBehind((most) => Math.max(most, answer.peopleAhead));
          setView({ kind: "queued", place: answer });
          break;
        case "ADMITTED":
          if (answer.token && answer.expiresAt) {
            // Memory only: the admission context never touches storage.
            admission.set(eventId, { token: answer.token, expiresAt: answer.expiresAt });
            document.title = "It's your turn!";
            router.push(`/events/${encodeURIComponent(eventId)}/buy`);
          }
          break;
        case "EXPIRED":
          setView({ kind: "expired" });
          break;
        case "SOLD_OUT":
          setView({ kind: "soldOut" });
          break;
        case "NOT_IN_QUEUE":
          // Join once more, then carry on. NOT_IN_QUEUE again straight after that join is a fault.
          if (rejoinedAfterMissing.current) {
            setView({
              kind: "failed",
              message: "You are not in the queue. Go back and join again.",
            });
          } else {
            rejoinedAfterMissing.current = true;
            mustJoin.current = true;
          }
          break;
      }
    },
    [admission, eventId, router],
  );

  const onError = useCallback((failure: ApiFailure) => {
    if (failure.code === "NOT_OPEN") {
      const opensAt = Number(failure.body.lobbyOpensAt);
      setView({ kind: "notOpen", lobbyOpensAt: Number.isFinite(opensAt) ? opensAt : null });
    } else if (!failure.unauthenticated) {
      // A lost session is the login prompt's to report.
      setView({ kind: "failed", message: failure.message });
    }
  }, []);

  const waiting = view.kind === "joining" || view.kind === "queued";
  const { unavailable } = usePolling<Answer>({
    enabled: ready && session !== null && waiting,
    firstDelayMs: 0,
    fetcher,
    nextDelayMs,
    onResult,
    onError,
  });

  function rejoin() {
    mustJoin.current = true;
    rejoinedAfterMissing.current = false;
    setStartedBehind(0);
    setView({ kind: "joining" });
  }

  if (!ready) {
    return null;
  }
  if (!session) {
    return <SignInPrompt what="to join the queue" />;
  }

  const eventHref = `/events/${encodeURIComponent(eventId)}`;
  const eventLink = (
    <Link className="back-link" href={eventHref}>
      <ArrowLeftIcon size={16} /> Back to the event
    </Link>
  );
  const place = view.kind === "queued" ? view.place : null;
  // How far through the line: from the furthest back this user has been, to the front.
  const progress =
    place && startedBehind > 0
      ? Math.round(((startedBehind - place.peopleAhead) / startedBehind) * 100)
      : 0;

  return (
    <section className="queue">
      <header className="queue__event">
        {event ? <EventCover event={event} className="cover--thumb" eager /> : null}
        <div>
          <p className="eyebrow">Waiting room</p>
          <h1>{event?.name ?? "Waiting room"}</h1>
        </div>
      </header>

      {unavailable && waiting ? (
        <p className="alert" role="alert">
          {WAITING_ROOM_UNAVAILABLE}
        </p>
      ) : null}

      {view.kind === "joining" ? (
        <div className="queue__card">
          <span className="spinner" aria-hidden="true" />
          <p className="big">Joining the queue…</p>
        </div>
      ) : null}

      {place?.phase === "LOBBY" ? (
        <div className="queue__card">
          <p className="eyebrow">You are in</p>
          <p className="queue__headline" data-testid="lobby">
            You're in the lobby.
          </p>
          <p className="muted">When the sale opens, everyone here gets a random place.</p>
          {event ? (
            <>
              <p className="eyebrow">Sale opens in</p>
              <CountdownClock to={event.saleOpensAt} />
            </>
          ) : null}
          <p className="queue__hint">
            <ClockIcon size={16} /> Keep this page open. Arriving earlier in the lobby makes no
            difference: the draw is the same for everyone.
          </p>
        </div>
      ) : null}

      {place?.phase === "OPEN" ? (
        <div className="queue__card">
          {place.state === "PAUSED" ? (
            <p className="alert alert--warn">
              <AlertIcon size={18} />
              All items are currently held. You may still get one if holds expire.
            </p>
          ) : null}
          <p className="eyebrow">Your position</p>
          <p className="queue__position">
            <span className="queue__pulse" aria-hidden="true" />
            <span data-testid="position">{place.position}</span>
          </p>
          <div
            className="meter meter--tall"
            role="progressbar"
            aria-label="Progress through the line"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span className="meter__fill" style={{ width: `${progress}%` }} />
          </div>
          <dl className="stats">
            <div>
              <dt>
                <UsersIcon size={16} /> People ahead
              </dt>
              <dd data-testid="ahead">{formatCount(place.peopleAhead)}</dd>
            </div>
            {place.state !== "PAUSED" && place.estWaitSec !== null ? (
              <div>
                <dt>
                  <ClockIcon size={16} /> Estimated wait
                </dt>
                <dd>{formatDuration(place.estWaitSec)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="queue__hint">
            Keep this page open. It moves on by itself when it is your turn.
          </p>
        </div>
      ) : null}

      {view.kind === "expired" ? (
        <div className="queue__card">
          <p className="queue__headline">Your turn expired.</p>
          <p className="muted">
            A turn lasts a short while so the line keeps moving. You can join again: you go to the
            back of the line.
          </p>
          <button type="button" className="btn btn--primary" onClick={rejoin}>
            Rejoin
          </button>
        </div>
      ) : null}

      {view.kind === "soldOut" ? (
        <div className="queue__card">
          <p className="queue__headline">Sold out.</p>
          <p className="muted">Every ticket was taken before your turn came.</p>
          {eventLink}
        </div>
      ) : null}

      {view.kind === "notOpen" ? (
        <div className="queue__card">
          <p className="queue__headline">
            {view.lobbyOpensAt === null
              ? "The lobby is not open yet."
              : `Opens at ${formatTime(view.lobbyOpensAt)}`}
          </p>
          {eventLink}
        </div>
      ) : null}

      {view.kind === "failed" ? (
        <div className="queue__card">
          <p className="alert" role="alert">
            {view.message}
          </p>
          {eventLink}
        </div>
      ) : null}
    </section>
  );
}

export default function QueuePage() {
  // useSearchParams needs a Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <WaitingRoom />
    </Suspense>
  );
}
