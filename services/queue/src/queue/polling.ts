const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 15_000;
const LOBBY_RETRY_MS = 5_000;
/** Each client's interval is spread by +/-20% so polls do not arrive in step. */
const JITTER = 0.2;

export interface Polling {
  /** Seconds until this user's turn at the configured rate. Null in the lobby. */
  estWaitSec: number | null;
  /** When the client should ask again. */
  retryAfterMs: number;
}

function jittered(ms: number, random: () => number): number {
  return Math.round(ms * (1 - JITTER + 2 * JITTER * random()));
}

/**
 * How long a queued user should expect to wait and when to poll next.
 *
 * After the sale opens a user polls about four times over their expected wait, never more often than
 * every 2s and never less often than every 15s. In the lobby the order is not final until the sale
 * opens (later joiners can still draw a lower number), so there is no estimate and a flat 5s poll.
 */
export function pollingFor(
  rank: number,
  admitRatePerSec: number,
  inLobby: boolean,
  random: () => number = Math.random,
): Polling {
  if (inLobby) {
    return { estWaitSec: null, retryAfterMs: jittered(LOBBY_RETRY_MS, random) };
  }
  const waitMs = (rank / admitRatePerSec) * 1000;
  const base = Math.min(Math.max(waitMs / 4, MIN_RETRY_MS), MAX_RETRY_MS);
  return {
    estWaitSec: Math.ceil(rank / admitRatePerSec),
    retryAfterMs: jittered(base, random),
  };
}
