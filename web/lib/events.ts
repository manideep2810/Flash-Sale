"use client";

import { useEffect, useState } from "react";
import { type CatalogueEvent, type EventStatus, serverNow } from "./api";

/**
 * Where an event is right now. The server said where it was when it answered; between answers the
 * two openings are crossed by the clock (the server's: see serverNow), so a card flips to "Lobby
 * open" or "Live now" on the second, without waiting for the next refresh. Sold out is only ever the
 * server's word.
 */
export function statusNow(
  event: Pick<CatalogueEvent, "status" | "lobbyOpensAt" | "saleOpensAt">,
  now: number,
): EventStatus {
  if (now < event.lobbyOpensAt) {
    return "UPCOMING";
  }
  if (now < event.saleOpensAt) {
    return "LOBBY";
  }
  return event.status === "SOLD_OUT" ? "SOLD_OUT" : "LIVE";
}

export const STATUS_LABEL: Record<EventStatus, string> = {
  UPCOMING: "Coming soon",
  LOBBY: "Lobby open",
  LIVE: "Live now",
  SOLD_OUT: "Sold out",
};

/** The share of the stock that is gone (bought or in a checkout), 0 to 100. Null when unknown. */
export function claimedPercent(
  event: Pick<CatalogueEvent, "totalStock" | "available">,
): number | null {
  if (event.available === null || event.totalStock <= 0) {
    return null;
  }
  const claimed = Math.min(event.totalStock, Math.max(0, event.totalStock - event.available));
  return Math.round((claimed / event.totalStock) * 100);
}

/** True when so few are left that the page should say how many. */
export function isAlmostGone(event: Pick<CatalogueEvent, "totalStock" | "available">): boolean {
  return (
    event.available !== null &&
    event.available > 0 &&
    event.available <= Math.max(10, Math.floor(event.totalStock * 0.1))
  );
}

/** The server's time, re-read every `everyMs`: what makes countdowns and statuses move. */
export function useServerNow(everyMs = 1_000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
