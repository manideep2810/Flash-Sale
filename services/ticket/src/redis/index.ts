import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "@flash/observability";
import type { RedisPool } from "./client.js";

export { createRedisPool, getRedisPool, type Redis, type RedisPool } from "./client.js";

/**
 * reserve.lua is a runtime asset, not a module, so tsc does not emit it into dist/. The first
 * candidate covers `pnpm dev` (tsx, running out of src/) and a dist/ that a build step copied it
 * into; the second is the fallback from dist/redis/ back to src/redis/ so `pnpm start` works without
 * one. Shipping dist/ without src/ (a slim container image) needs the copy added to the build script.
 */
const SCRIPT_CANDIDATES = [
  new URL("reserve.lua", import.meta.url),
  new URL("../../src/redis/reserve.lua", import.meta.url),
];

function readReserveLua(): string {
  const failures: string[] = [];
  for (const url of SCRIPT_CANDIDATES) {
    try {
      return readFileSync(url, "utf8");
    } catch (error) {
      failures.push(`${fileURLToPath(url)} (${(error as Error).message})`);
    }
  }
  throw new Error(`reserve.lua not found. Tried:\n  ${failures.join("\n  ")}`);
}

export const RESERVE_LUA: string = readReserveLua();

/** Local digest of the script text, used only to sanity-check what SCRIPT LOAD hands back. */
export const RESERVE_LUA_SHA1: string = createHash("sha1").update(RESERVE_LUA).digest("hex");

/** How long a hold stays valid; becomes the ZSET score as `now + ttl`. */
const DEFAULT_HOLD_TTL_MS = 120_000;

export type RedisReserveResult = { ok: true; holdId: string } | { ok: false; reason: "SOLD_OUT" };

/**
 * The three keys the script operates on: avail, holds, stream.
 *
 * Untagged names. A standalone Redis or a Sentinel primary/replica set has one keyspace and no slots,
 * so nothing here needs a hash tag. Redis CLUSTER would reject the script with CROSSSLOT, because
 * these three keys hash to different slots and a script may only touch one. Moving to Cluster means
 * wrapping the id in a shared tag -- `ev:{${eventId}}:avail` -- here, in reserve.lua's header, and in
 * infra/redis/init.sh, together.
 */
export function reserveKeys(eventId: string): [string, string, string] {
  return [`ev:${eventId}:avail`, `ev:${eventId}:holds`, `ev:${eventId}:stream`];
}

/** Seeded alongside avail for reconciliation; the hot path never reads it. */
export function totalKey(eventId: string): string {
  return `ev:${eventId}:total`;
}

/**
 * SCRIPT LOAD caches server-side rather than per connection, so loading on one client of the pool is
 * enough for a standalone Redis. A Cluster would need this run against every master.
 */
export async function loadReserveScript(pool: RedisPool): Promise<string> {
  const reply = await pool.next().script("LOAD", RESERVE_LUA);
  if (typeof reply !== "string") {
    throw new Error(`SCRIPT LOAD returned ${typeof reply}, expected the script sha`);
  }
  if (reply !== RESERVE_LUA_SHA1) {
    throw new Error(`SCRIPT LOAD sha ${reply} does not match local digest ${RESERVE_LUA_SHA1}`);
  }
  return reply;
}

export interface ReserveScript {
  /** Current sha. Changes if Redis forgot the script and it had to be reloaded. */
  readonly sha: string;
  reserve(eventId: string, userId: string, qty: number): Promise<RedisReserveResult>;
}

/**
 * Returns one event to a pre-sale state: inventory back to `total`, holds and stream emptied.
 *
 * One MULTI rather than a sequence of awaits, so a reset is atomic and costs one round trip instead of
 * five -- a k6 setup() that resets between runs should not be able to leave half-cleared state behind
 * if the connection drops mid-way.
 */
export async function resetEvent(pool: RedisPool, eventId: string, total: number): Promise<void> {
  const [availKey, holdsKey, streamKey] = reserveKeys(eventId);
  const totals = totalKey(eventId);

  const replies = await pool
    .next()
    .multi()
    .del(availKey, holdsKey, streamKey, totals)
    .set(availKey, String(total))
    .set(totals, String(total))
    // Recreate the stream empty: XADD makes the key, MAXLEN 0 trims the entry straight back out, so a
    // relay can XREAD before the first reserve lands. Drop this line if you would rather the stream
    // only appear with its first real entry.
    .xadd(streamKey, "MAXLEN", "0", "*", "init", "1")
    .exec();

  if (!replies) {
    throw new Error("reset transaction was aborted");
  }
  for (const [error] of replies) {
    if (error) {
      throw error;
    }
  }
}

export interface ReserveScriptOptions {
  pool: RedisPool;
  logger: Logger;
  /** Defaults to HOLD_TTL_MS from the environment, then to two minutes. */
  holdTtlMs?: number;
}

/**
 * Loads reserve.lua into Redis and returns a handle that runs it.
 *
 * The evalsha call lives here rather than in the route because the sha is mutable state: a Redis
 * restart or SCRIPT FLUSH empties the script cache, and whoever owns the sha has to own the reload.
 */
export async function createReserveScript({
  pool,
  logger,
  holdTtlMs = Number.parseInt(process.env.HOLD_TTL_MS ?? String(DEFAULT_HOLD_TTL_MS), 10),
}: ReserveScriptOptions): Promise<ReserveScript> {
  if (!Number.isInteger(holdTtlMs) || holdTtlMs < 1) {
    throw new Error(`HOLD_TTL_MS must be a positive integer, got "${process.env.HOLD_TTL_MS}"`);
  }

  let sha = await loadReserveScript(pool);

  async function run(sha1: string, eventId: string, userId: string, qty: number): Promise<unknown> {
    const [availKey, holdsKey, streamKey] = reserveKeys(eventId);
    // Milliseconds: Lua 5.1 stringifies numbers with %.14g, and a 13-digit epoch survives that
    // intact, which matters because holdId concatenates `now` directly.
    const argv: [string, string, string, string] = [
      eventId,
      userId,
      String(qty),
      String(holdTtlMs),
    ];
    return pool.next().evalsha(sha1, 3, availKey, holdsKey, streamKey, ...argv, String(Date.now()));
  }

  return {
    get sha() {
      return sha;
    },
    async reserve(eventId, userId, qty) {
      try {
        return parseReply(await run(sha, eventId, userId, qty));
      } catch (error) {
        if (!isNoScript(error)) {
          throw error;
        }
        // Redis restarted or SCRIPT FLUSH ran. Reload and retry once; a second NOSCRIPT is a real fault.
        logger.warn("reserve.lua missing from the redis script cache, reloading", { sha });
        sha = await loadReserveScript(pool);
        return parseReply(await run(sha, eventId, userId, qty));
      }
    },
  };
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}

/** Reply contract is `{1, holdId}` or `{0, 'SOLD_OUT'}`; see the header of reserve.lua. */
function parseReply(reply: unknown): RedisReserveResult {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error(`reserve.lua returned ${JSON.stringify(reply)}, expected [status, payload]`);
  }
  const [status, payload] = reply as [unknown, unknown];
  if (status === 0) {
    return { ok: false, reason: "SOLD_OUT" };
  }
  if (status === 1) {
    if (typeof payload !== "string") {
      throw new Error(`reserve.lua returned a ${typeof payload} holdId, expected a string`);
    }
    return { ok: true, holdId: payload };
  }
  throw new Error(`reserve.lua returned status ${JSON.stringify(status)}, expected 0 or 1`);
}
