"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Countdown } from "@/components/Countdown";
import { type Turn, useAdmission } from "@/lib/admission";
import { getQueueStatus, reserve, toFailure } from "@/lib/api";
import { formatTime, segment } from "@/lib/format";
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

  const queuePath = `/events/${encodeURIComponent(eventId)}/queue`;

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
      // A lost session has already brought the login bar back; anything else is not an answer.
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
            // a status call fails too if it was the session, and the login bar takes over.
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
    return <p>Log in above to continue.</p>;
  }
  if (soldOut) {
    return (
      <>
        <p className="big">Sold out.</p>
        <p>
          <Link href={`/events/${encodeURIComponent(eventId)}`}>Back to the event</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>It's your turn</h1>
      {turn ? (
        <>
          <p className="big">
            It's your turn — you have until {formatTime(turn.expiresAt)} (
            <Countdown to={turn.expiresAt} onDone={onCountdownDone} done="time is up" />)
          </p>
          <p>
            <label>
              Quantity{" "}
              <select
                value={qty}
                onChange={(event) => setQty(Number(event.target.value))}
                disabled={busy}
              >
                {Array.from({ length: MAX_QTY }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>{" "}
            <button type="button" onClick={submit} disabled={busy}>
              {busy ? "Reserving…" : "Reserve"}
            </button>
          </p>
        </>
      ) : problem ? null : (
        <p>Checking your turn…</p>
      )}
      {problem ? (
        <>
          <p role="alert">{problem}</p>
          <p>
            <Link href={queuePath}>Back to the queue</Link>
          </p>
        </>
      ) : null}
    </>
  );
}
