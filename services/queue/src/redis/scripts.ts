import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Logger } from "@flash/observability";
import { QueueUnavailableError, type Redis } from "./client.js";
import { admittedKey, availKey, holdsKey, queueKey, stateKey } from "./keys.js";

const SCRIPT_NAMES = ["join", "status", "admit"] as const;
type ScriptName = (typeof SCRIPT_NAMES)[number];

// The .lua files are runtime assets, not modules, so tsc does not emit them. lua/ sits beside both
// src/ and dist/, so this one relative path works under tsx (src/redis) and node (dist/redis).
function readScript(name: ScriptName): string {
  return readFileSync(new URL(`../../lua/${name}.lua`, import.meta.url), "utf8");
}

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

export type JoinReply =
  | { status: "QUEUED"; rank: number }
  | { status: "ADMITTED" }
  | { status: "SOLD_OUT" };

export type StatusReply =
  | { status: "ADMITTED"; admittedAt: number }
  | { status: "QUEUED"; rank: number; state: "OPEN" | "PAUSED" }
  | { status: "EXPIRED" }
  | { status: "SOLD_OUT" }
  | { status: "NOT_IN_QUEUE" };

export interface Scripts {
  /** SCRIPT LOAD for all three. Called once at startup; a script Redis later forgets is reloaded on use. */
  load(): Promise<void>;
  join(args: {
    eventId: string;
    userId: string;
    saleOpensAt: number;
    lotteryScore: number;
    admitTtlMs: number;
  }): Promise<JoinReply>;
  status(args: { eventId: string; userId: string; admitTtlMs: number }): Promise<StatusReply>;
  /**
   * Admits up to `n` from the front of the queue. Resolves to how many were admitted, or -1 when
   * admit.lua marked the event SOLD_OUT. 0 means either PAUSED or an open event with nobody waiting.
   */
  admit(eventId: string, n: number): Promise<number>;
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}

function unexpected(script: ScriptName, reply: unknown): Error {
  return new Error(`${script}.lua returned an unexpected reply: ${JSON.stringify(reply)}`);
}

// Lua hands back integers as numbers and everything it read from a key as a string, so each field is
// converted explicitly rather than trusted to be the type the caller wants.

function parseJoin(reply: unknown): JoinReply {
  const [status, rank] = Array.isArray(reply) ? reply : [];
  if (status === "QUEUED" && Number.isInteger(Number(rank))) {
    return { status, rank: Number(rank) };
  }
  if (status === "ADMITTED" || status === "SOLD_OUT") {
    return { status };
  }
  throw unexpected("join", reply);
}

function parseStatus(reply: unknown): StatusReply {
  const [status, second, third] = Array.isArray(reply) ? reply : [];
  if (status === "ADMITTED" && Number.isFinite(Number(second))) {
    return { status, admittedAt: Number(second) };
  }
  if (
    status === "QUEUED" &&
    Number.isInteger(Number(second)) &&
    (third === "OPEN" || third === "PAUSED")
  ) {
    return { status, rank: Number(second), state: third };
  }
  if (status === "EXPIRED" || status === "SOLD_OUT" || status === "NOT_IN_QUEUE") {
    return { status };
  }
  throw unexpected("status", reply);
}

function parseAdmit(reply: unknown): number {
  const admitted = Array.isArray(reply) ? Number(reply[0]) : Number.NaN;
  if (!Number.isInteger(admitted) || admitted < -1) {
    throw unexpected("admit", reply);
  }
  return admitted;
}

/**
 * The three waiting-room scripts in lua/, run by sha.
 *
 * The sha is computed locally, so nothing here depends on SCRIPT LOAD having succeeded: a Redis that
 * was down at boot, restarted, or ran SCRIPT FLUSH answers NOSCRIPT, and the script is loaded and the
 * call retried once. A second failure is a real fault and is thrown.
 */
export function createScripts(redis: Redis, logger: Logger): Scripts {
  const source = {} as Record<ScriptName, { text: string; sha: string }>;
  for (const name of SCRIPT_NAMES) {
    const text = readScript(name);
    source[name] = { text, sha: sha1(text) };
  }

  async function loadOne(name: ScriptName): Promise<void> {
    const { text, sha } = source[name];
    const reply = await redis.script("LOAD", text);
    if (reply !== sha) {
      throw new Error(`SCRIPT LOAD of ${name}.lua returned ${String(reply)}, expected ${sha}`);
    }
  }

  async function run(
    name: ScriptName,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    const { sha } = source[name];
    try {
      try {
        return await redis.evalsha(sha, keys.length, ...keys, ...args);
      } catch (error) {
        if (!isNoScript(error)) {
          throw error;
        }
        logger.warn("script missing from the redis script cache, reloading", { script: name, sha });
        await loadOne(name);
        return await redis.evalsha(sha, keys.length, ...keys, ...args);
      }
    } catch (error) {
      throw new QueueUnavailableError(error);
    }
  }

  const queueKeys = (eventId: string): string[] => [
    queueKey(eventId),
    admittedKey(eventId),
    stateKey(eventId),
  ];

  return {
    async load() {
      await Promise.all(SCRIPT_NAMES.map(loadOne));
    },
    async join({ eventId, userId, saleOpensAt, lotteryScore, admitTtlMs }) {
      return parseJoin(
        await run("join", queueKeys(eventId), [
          userId,
          String(saleOpensAt),
          String(lotteryScore),
          String(admitTtlMs),
        ]),
      );
    },
    async status({ eventId, userId, admitTtlMs }) {
      return parseStatus(await run("status", queueKeys(eventId), [userId, String(admitTtlMs)]));
    },
    async admit(eventId, n) {
      return parseAdmit(
        await run(
          "admit",
          [...queueKeys(eventId), availKey(eventId), holdsKey(eventId)],
          [String(n)],
        ),
      );
    },
  };
}
