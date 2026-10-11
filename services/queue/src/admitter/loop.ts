// Single instance by design. Running two would briefly double the admit rate (never admit a user
// twice: ZPOPMIN is atomic). In Kubernetes (Phase 6) use replicas: 1 and strategy: Recreate.

import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@flash/observability";
import type { EventConfig, EventConfigs } from "../config/events.js";
import {
  admitterTickDuration,
  admitterTicksSkipped,
  EVENT_STATES,
  type EventState,
  eventState,
  queueAdmitted,
  queueDepth,
} from "../metrics.js";
import type { Redis } from "../redis/client.js";
import { admittedKey, availKey, QUEUE_EVENTS, queueKey, stateKey } from "../redis/keys.js";
import type { Scripts } from "../redis/scripts.js";

const TICK_MS = 100;
const DEPTH_SAMPLE_MS = 1_000;
const CLEANUP_MS = 30_000;
/** How often an event's state key and stock are re-read to decide whether to admit at all. */
const GATE_CHECK_MS = 1_000;
/** An admitted entry is deleted this long after its turn expired. */
const CLEANUP_GRACE_MS = 60_000;
const HSCAN_COUNT = 500;
const STOP_TIMEOUT_MS = 2_000;
/** A failure that repeats every tick is logged this often, not ten times a second. */
const FAILURE_LOG_MS = 5_000;

/** What the loop remembers about one event between ticks. Lost on restart, by design. */
interface Track {
  /** Admissions earned and not yet spent. Fractional. */
  allowance: number;
  /** performance.now() at the previous rate step; undefined while the event is not admitting. */
  lastStepAt: number | undefined;
  gateCheckedAt: number;
  soldOut: boolean;
  stockMissing: boolean;
  /** Last state reported, so a change is logged once and not every tick. */
  state: EventState | undefined;
}

export interface AdmitterOptions {
  redis: Redis;
  scripts: Scripts;
  events: EventConfigs;
  logger: Logger;
  /** The set of event ids to admit for. Tests point this at a set of their own. */
  eventsKey?: string;
}

export interface Admitter {
  /** Starts the 100ms tick and the 1s depth sample. */
  start(): void;
  /** Stops both timers and waits for the tick in flight, for at most `timeoutMs`. */
  stop(timeoutMs?: number): Promise<void>;
  /** One pass over every event. start() runs this on a timer. */
  tick(): Promise<void>;
  /** Deletes admitted entries whose turn expired over a minute ago. Resolves to how many. */
  cleanup(): Promise<number>;
  sampleDepth(): Promise<void>;
}

function isEventState(value: unknown): value is EventState {
  return (EVENT_STATES as readonly unknown[]).includes(value);
}

export function createAdmitter({
  redis,
  scripts,
  events,
  logger,
  eventsKey = QUEUE_EVENTS,
}: AdmitterOptions): Admitter {
  const tracks = new Map<string, Track>();
  const failureLoggedAt = new Map<string, number>();

  let tickTimer: NodeJS.Timeout | undefined;
  let depthTimer: NodeJS.Timeout | undefined;
  let running = false;
  let sampling = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastCleanupAt = performance.now();

  function trackOf(eventId: string): Track {
    let track = tracks.get(eventId);
    if (!track) {
      track = {
        allowance: 0,
        lastStepAt: undefined,
        gateCheckedAt: Number.NEGATIVE_INFINITY,
        soldOut: false,
        stockMissing: false,
        state: undefined,
      };
      tracks.set(eventId, track);
    }
    return track;
  }

  function logFailure(key: string, message: string, meta: Record<string, unknown>): void {
    const now = performance.now();
    if (now - (failureLoggedAt.get(key) ?? Number.NEGATIVE_INFINITY) < FAILURE_LOG_MS) {
      return;
    }
    failureLoggedAt.set(key, now);
    logger.error(message, meta);
  }

  function report(eventId: string, track: Track, state: EventState): void {
    for (const candidate of EVENT_STATES) {
      eventState.set({ event: eventId, state: candidate }, candidate === state ? 1 : 0);
    }
    if (track.state !== state) {
      logger.info("event state changed", { event: eventId, from: track.state ?? null, to: state });
      track.state = state;
    }
  }

  /**
   * Whether to admit for this event at all, re-read at most once a second.
   *
   * SOLD_OUT is final for a run: admit.lua is the only writer of the state key, so an event skipped
   * here stays SOLD_OUT until its state key is deleted (the seed script does that).
   *
   * An event with no avail key has no stock seeded. admit.lua reads a missing avail as 0 and would
   * mark the event SOLD_OUT, so the admitter waits for the key instead. Reading it is all this does;
   * the Phase 2 keys are never written here.
   */
  async function gate(eventId: string, track: Track): Promise<boolean> {
    const now = performance.now();
    if (now - track.gateCheckedAt >= GATE_CHECK_MS) {
      const [state, availExists] = await Promise.all([
        redis.get(stateKey(eventId)),
        redis.exists(availKey(eventId)),
      ]);
      track.gateCheckedAt = now;
      track.soldOut = state === "SOLD_OUT";
      const stockMissing = availExists === 0;
      if (stockMissing !== track.stockMissing) {
        if (stockMissing) {
          logger.warn("event has no stock key, not admitting until it is seeded", {
            event: eventId,
            key: availKey(eventId),
          });
        } else {
          logger.info("event stock key found, admitting", { event: eventId });
        }
        track.stockMissing = stockMissing;
      }
    }
    if (track.soldOut) {
      report(eventId, track, "SOLD_OUT");
    }
    return !track.soldOut && !track.stockMissing;
  }

  async function admitFor(eventId: string): Promise<void> {
    const config = await events.get(eventId);
    if (!config) {
      // Listed in the set but never seeded, or its config hash was deleted.
      return;
    }
    const track = trackOf(eventId);

    if (Date.now() < config.saleOpensAt || !(await gate(eventId, track))) {
      // Not admitting: the rate clock restarts when it does, so no allowance builds up meanwhile.
      track.lastStepAt = undefined;
      return;
    }

    // Allowance is earned from the time that actually passed, not from an assumed 100ms, so the rate
    // holds when ticks run late or are skipped. It is capped at one second's worth: a long stall is
    // followed by at most a one-second burst.
    const now = performance.now();
    const elapsedSec = (now - (track.lastStepAt ?? now)) / 1000;
    track.lastStepAt = now;
    track.allowance = Math.min(
      track.allowance + config.admitRatePerSec * elapsedSec,
      config.admitRatePerSec,
    );
    const n = Math.floor(track.allowance);
    if (n === 0) {
      return;
    }
    track.allowance -= n;

    const admitted = await scripts.admit(eventId, n);
    if (admitted === -1) {
      track.soldOut = true;
      report(eventId, track, "SOLD_OUT");
      return;
    }
    if (admitted > 0) {
      queueAdmitted.inc({ event: eventId }, admitted);
    }
    if (admitted === n) {
      report(eventId, track, "OPEN");
      return;
    }

    // Fewer than asked for. admit.lua answers 0 both when it paused the event (no stock, holds
    // outstanding) and when the event is open with nobody waiting, so the state key says which; this
    // process is the only one that runs admit.lua, so the key still holds what that call wrote. The
    // unused admissions are handed back only while people are waiting: an empty queue must not bank
    // them, and a paused one resumes with what it was owed.
    const [state, depth] = await Promise.all([
      redis.get(stateKey(eventId)),
      redis.zcard(queueKey(eventId)),
    ]);
    if (depth > 0) {
      track.allowance += n - admitted;
    }
    if (isEventState(state)) {
      report(eventId, track, state);
    }
  }

  async function tick(): Promise<void> {
    const eventIds = await redis.smembers(eventsKey);
    await Promise.all(
      eventIds.map(async (eventId) => {
        try {
          await admitFor(eventId);
        } catch (error) {
          logFailure(`admit:${eventId}`, "admitting failed", {
            event: eventId,
            error: String(error),
          });
        }
      }),
    );
  }

  /**
   * Walks each admitted hash with HSCAN (never HGETALL: the hash holds every user admitted in the
   * last few minutes) and deletes entries whose turn expired more than a minute ago.
   *
   * It runs between ticks, under the same no-overlap guard, and that is what makes HSCAN-then-HDEL
   * safe: only admit.lua adds to the hash, so with no tick in flight nobody can be re-admitted
   * between the scan that read their old entry and the delete that removes it.
   */
  async function cleanup(): Promise<number> {
    let removed = 0;
    for (const eventId of await redis.smembers(eventsKey)) {
      const config: EventConfig | null = await events.get(eventId);
      if (!config) {
        continue;
      }
      // admittedAt was stamped with Redis's clock (admit.lua), so age is measured on the same clock.
      const [seconds, micros] = await redis.time();
      const nowMs = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
      const cutoff = nowMs - (config.admitTtlSec * 1000 + CLEANUP_GRACE_MS);

      const key = admittedKey(eventId);
      let cursor = "0";
      do {
        const [next, entries] = await redis.hscan(key, cursor, "COUNT", HSCAN_COUNT);
        const expired: string[] = [];
        for (let i = 0; i + 1 < entries.length; i += 2) {
          const userId = entries[i];
          if (userId !== undefined && Number(entries[i + 1]) < cutoff) {
            expired.push(userId);
          }
        }
        if (expired.length > 0) {
          removed += await redis.hdel(key, ...expired);
        }
        cursor = next;
      } while (cursor !== "0");
    }
    return removed;
  }

  async function sampleDepth(): Promise<void> {
    const eventIds = await redis.smembers(eventsKey);
    const depths = await Promise.all(eventIds.map((eventId) => redis.zcard(queueKey(eventId))));
    eventIds.forEach((eventId, i) => {
      queueDepth.set({ event: eventId }, depths[i] ?? 0);
    });

    // An event taken out of the set stops being reported instead of freezing at its last value.
    const listed = new Set(eventIds);
    for (const eventId of tracks.keys()) {
      if (!listed.has(eventId)) {
        tracks.delete(eventId);
        queueDepth.remove({ event: eventId });
        for (const state of EVENT_STATES) {
          eventState.remove({ event: eventId, state });
        }
      }
    }
  }

  async function runTick(): Promise<void> {
    const done = admitterTickDuration.startTimer();
    try {
      await tick();
    } catch (error) {
      logFailure("tick", "admitter tick failed", { error: String(error) });
    } finally {
      done();
    }

    if (performance.now() - lastCleanupAt >= CLEANUP_MS) {
      lastCleanupAt = performance.now();
      try {
        const removed = await cleanup();
        if (removed > 0) {
          logger.info("expired admissions removed", { removed });
        }
      } catch (error) {
        logFailure("cleanup", "admitted cleanup failed", { error: String(error) });
      }
    }
  }

  return {
    start() {
      if (tickTimer) {
        return;
      }
      lastCleanupAt = performance.now();
      tickTimer = setInterval(() => {
        if (running) {
          // No overlapping ticks. Nothing is lost: the next one earns allowance for the time skipped.
          admitterTicksSkipped.inc();
          return;
        }
        running = true;
        inFlight = runTick().finally(() => {
          running = false;
        });
      }, TICK_MS);

      depthTimer = setInterval(async () => {
        if (sampling) {
          return;
        }
        sampling = true;
        try {
          await sampleDepth();
        } catch (error) {
          logFailure("depth", "queue depth sample failed", { error: String(error) });
        } finally {
          sampling = false;
        }
      }, DEPTH_SAMPLE_MS);
    },

    async stop(timeoutMs = STOP_TIMEOUT_MS) {
      clearInterval(tickTimer);
      clearInterval(depthTimer);
      tickTimer = undefined;
      depthTimer = undefined;
      await Promise.race([inFlight, sleep(timeoutMs, undefined, { ref: false })]);
    },

    tick,
    cleanup,
    sampleDepth,
  };
}
