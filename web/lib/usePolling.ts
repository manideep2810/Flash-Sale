"use client";

import { useEffect, useRef, useState } from "react";
import { type ApiFailure, toFailure } from "./api";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
/** What to wait after a 429 that names no Retry-After. */
const RATE_LIMIT_FALLBACK_MS = 1_000;

export interface PollingOptions<T> {
  /** Polling runs while this is true. Turning it off cancels the call that is waiting. */
  enabled: boolean;
  /** How long to wait before the first call: 0, or what the previous response asked for. */
  firstDelayMs: number;
  /** One call. */
  fetcher: () => Promise<T>;
  /** What the server said to wait before the next call. Null or undefined ends the polling. */
  nextDelayMs: (result: T) => number | null | undefined;
  onResult: (result: T) => void;
  /** A failure that is neither "unavailable" nor a 429. Polling stops. */
  onError: (failure: ApiFailure) => void;
}

/**
 * Calls `fetcher` again and again at the pace the server sets.
 *
 * - The next call is scheduled with setTimeout for exactly the delay the last response asked for,
 *   counted from when that response arrived. Never setInterval, and never sooner than asked.
 * - A response that asks for no delay ends the polling.
 * - When the server cannot be reached the hook reports `unavailable` and retries after 1s, 2s, 4s...
 *   up to 15s. It never gives up and never does anything else on the user's behalf.
 * - A 429 waits out its Retry-After and carries on, without reporting anything.
 * - Browsers slow timers down in background tabs. When the tab becomes visible again, a call that is
 *   already due is made at once, and one that is not is rearmed for what is left of its wait.
 */
export function usePolling<T>(options: PollingOptions<T>): { unavailable: boolean } {
  const latest = useRef(options);
  latest.current = options;
  const [unavailable, setUnavailable] = useState(false);
  const { enabled, firstDelayMs } = options;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** When the waiting call may be made. */
    let dueAt = 0;
    let inFlight = false;
    let backoffMs = BACKOFF_START_MS;

    const schedule = (delayMs: number) => {
      dueAt = Date.now() + delayMs;
      clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    };

    const run = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      clearTimeout(timer);
      timer = undefined;
      try {
        const result = await latest.current.fetcher();
        if (cancelled) {
          return;
        }
        backoffMs = BACKOFF_START_MS;
        setUnavailable(false);
        latest.current.onResult(result);
        const delayMs = latest.current.nextDelayMs(result);
        if (typeof delayMs === "number") {
          schedule(delayMs);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const failure = toFailure(error);
        if (failure.rateLimited) {
          schedule(failure.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS);
        } else if (failure.unavailable) {
          setUnavailable(true);
          schedule(backoffMs);
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        } else {
          latest.current.onError(failure);
        }
      } finally {
        inFlight = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || inFlight || timer === undefined) {
        return;
      }
      const leftMs = dueAt - Date.now();
      if (leftMs <= 0) {
        void run();
      } else {
        schedule(leftMs);
      }
    };

    schedule(firstDelayMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, firstDelayMs]);

  return { unavailable };
}
