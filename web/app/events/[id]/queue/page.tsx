"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useRef, useState } from "react";
import { useAdmission } from "@/lib/admission";
import { type ApiFailure, getQueueStatus, joinQueue, type Queued } from "@/lib/api";
import { formatDuration, formatTime, segment } from "@/lib/format";
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
      // A lost session is the login bar's to report.
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
    setView({ kind: "joining" });
  }

  if (!ready) {
    return null;
  }
  if (!session) {
    return <p>Log in above to join the queue.</p>;
  }

  const eventLink = <Link href={`/events/${encodeURIComponent(eventId)}`}>Back to the event</Link>;

  return (
    <>
      <h1>Waiting room</h1>
      {unavailable && waiting ? <p role="alert">{WAITING_ROOM_UNAVAILABLE}</p> : null}

      {view.kind === "joining" ? <p>Joining the queue…</p> : null}

      {view.kind === "queued" && view.place.phase === "LOBBY" ? (
        <p className="big" data-testid="lobby">
          You're in the lobby. When the sale opens, everyone here gets a random place.
        </p>
      ) : null}

      {view.kind === "queued" && view.place.phase === "OPEN" ? (
        <>
          {view.place.state === "PAUSED" ? (
            <p className="big">
              All items are currently held. You may still get one if holds expire.
            </p>
          ) : null}
          <dl>
            <dt>Your position</dt>
            <dd data-testid="position">{view.place.position}</dd>
            <dt>People ahead</dt>
            <dd data-testid="ahead">{view.place.peopleAhead}</dd>
            {view.place.state !== "PAUSED" && view.place.estWaitSec !== null ? (
              <>
                <dt>Estimated wait</dt>
                <dd>{formatDuration(view.place.estWaitSec)}</dd>
              </>
            ) : null}
          </dl>
          <p>Keep this page open. It moves on by itself when it is your turn.</p>
        </>
      ) : null}

      {view.kind === "expired" ? (
        <>
          <p className="big">Your turn expired.</p>
          <p>
            <button type="button" onClick={rejoin}>
              Rejoin
            </button>{" "}
            You go to the back of the line.
          </p>
        </>
      ) : null}

      {view.kind === "soldOut" ? (
        <>
          <p className="big">Sold out.</p>
          <p>{eventLink}</p>
        </>
      ) : null}

      {view.kind === "notOpen" ? (
        <>
          <p className="big">
            {view.lobbyOpensAt === null
              ? "The lobby is not open yet."
              : `Opens at ${formatTime(view.lobbyOpensAt)}`}
          </p>
          <p>{eventLink}</p>
        </>
      ) : null}

      {view.kind === "failed" ? (
        <>
          <p role="alert">{view.message}</p>
          <p>{eventLink}</p>
        </>
      ) : null}
    </>
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
