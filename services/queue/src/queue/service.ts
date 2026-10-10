import { randomInt } from "node:crypto";
import type { EventConfig, EventConfigs } from "../config/events.js";
import type { Scripts } from "../redis/scripts.js";
import { type Polling, pollingFor } from "./polling.js";
import type { MintToken } from "./token.js";

/** LOBBY until saleOpensAt (joiners draw a lottery number), OPEN after it (joiners go to the back). */
export type Phase = "LOBBY" | "OPEN";

interface Queued extends Polling {
  status: "QUEUED";
  /** 1-based place in line. */
  position: number;
  peopleAhead: number;
  phase: Phase;
}

export type JoinResponse =
  | Queued
  // No token here: the client calls status to get it.
  | { status: "ADMITTED" }
  | { status: "SOLD_OUT" };

export type StatusResponse =
  | { status: "ADMITTED"; token: string; expiresAt: string }
  | (Queued & { state: "OPEN" | "PAUSED" })
  | { status: "EXPIRED" }
  // SOLD_OUT carries no retryAfterMs: the client stops polling.
  | { status: "SOLD_OUT" }
  | { status: "NOT_IN_QUEUE" };

export class EventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`event "${eventId}" has no waiting room`);
    this.name = "EventNotFoundError";
  }
}

export class NotOpenError extends Error {
  constructor(readonly lobbyOpensAt: number) {
    super("the lobby is not open yet");
    this.name = "NotOpenError";
  }
}

const LOTTERY_RANGE = 2 ** 48;

/**
 * A lobby joiner's place in line: uniform in [0, 1), from the OS's CSPRNG. Drawn here, never in Lua,
 * whose math.random is seeded predictably. crypto.randomInt allows a range of at most 2^48 - 1, so
 * the largest draw is 2^48 - 2 and the quotient stays below 1.
 */
export function drawLotteryScore(): number {
  return randomInt(0, LOTTERY_RANGE - 1) / LOTTERY_RANGE;
}

export interface QueueService {
  join(eventId: string, userId: string): Promise<JoinResponse>;
  status(eventId: string, userId: string): Promise<StatusResponse>;
}

export interface QueueServiceOptions {
  events: EventConfigs;
  scripts: Scripts;
  mintToken: MintToken;
}

export function createQueueService({
  events,
  scripts,
  mintToken,
}: QueueServiceOptions): QueueService {
  async function configOf(eventId: string): Promise<EventConfig> {
    const config = await events.get(eventId);
    if (!config) {
      throw new EventNotFoundError(eventId);
    }
    return config;
  }

  function queued(rank: number, config: EventConfig, now: number): Queued {
    const inLobby = now < config.saleOpensAt;
    const { estWaitSec, retryAfterMs } = pollingFor(rank, config.admitRatePerSec, inLobby);
    return {
      status: "QUEUED",
      position: rank + 1,
      peopleAhead: rank,
      estWaitSec,
      retryAfterMs,
      phase: inLobby ? "LOBBY" : "OPEN",
    };
  }

  return {
    async join(eventId, userId) {
      const config = await configOf(eventId);
      const now = Date.now();
      if (now < config.lobbyOpensAt) {
        throw new NotOpenError(config.lobbyOpensAt);
      }
      const reply = await scripts.join({
        eventId,
        userId,
        saleOpensAt: config.saleOpensAt,
        // Always drawn; join.lua uses it only for a join that lands before saleOpensAt.
        lotteryScore: drawLotteryScore(),
        admitTtlMs: config.admitTtlSec * 1000,
      });
      return reply.status === "QUEUED" ? queued(reply.rank, config, now) : reply;
    },

    async status(eventId, userId) {
      const config = await configOf(eventId);
      const reply = await scripts.status({
        eventId,
        userId,
        admitTtlMs: config.admitTtlSec * 1000,
      });
      switch (reply.status) {
        case "ADMITTED": {
          const { token, expiresAt } = await mintToken({
            userId,
            eventId,
            admittedAt: reply.admittedAt,
            admitTtlSec: config.admitTtlSec,
          });
          return { status: "ADMITTED", token, expiresAt };
        }
        case "QUEUED": {
          const { status, ...rest } = queued(reply.rank, config, Date.now());
          return { status, state: reply.state, ...rest };
        }
        default:
          return reply;
      }
    },
  };
}
