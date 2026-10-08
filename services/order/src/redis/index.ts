import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";

/**
 * Key names owned by the ticket service (reserveKeys() in services/ticket/src/redis/index.ts). They
 * have to be kept in step with it by hand; the three below are the only ones this service touches.
 */
export const availKey = (eventId: string): string => `ev:${eventId}:avail`;
export const holdsKey = (eventId: string): string => `ev:${eventId}:holds`;
export const soldKey = (eventId: string): string => `ev:${eventId}:sold`;
export const heldKey = (eventId: string): string => `ev:${eventId}:held`;

/**
 * The .lua files are runtime assets, not modules, so tsc does not emit them into dist/. The first
 * candidate covers `pnpm dev` (tsx, out of src/) and a dist/ the build copied them into; the second
 * falls back from dist/redis/ to src/redis/.
 */
function readScript(name: string): string {
  const failures: string[] = [];
  for (const url of [
    new URL(name, import.meta.url),
    new URL(`../../src/redis/${name}`, import.meta.url),
  ]) {
    try {
      return readFileSync(url, "utf8");
    } catch (error) {
      failures.push(`${fileURLToPath(url)} (${(error as Error).message})`);
    }
  }
  throw new Error(`${name} not found. Tried:\n  ${failures.join("\n  ")}`);
}

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

const RELEASE_LUA = readScript("release.lua");
const CONFIRM_LUA = readScript("confirm.lua");

/** The two hold-settlement operations; each returns true when this call changed Redis. */
export interface HoldStore {
  /** hold -> avail. False when the hold was already gone. */
  release(hold: { eventId: string; holdId: string; qty: number }): Promise<boolean>;
  /** hold -> sold. False when the hold was already gone. */
  confirm(hold: { eventId: string; holdId: string; qty: number }): Promise<boolean>;
}

/** EVALSHA, falling back to EVAL (which also caches the script) when Redis has forgotten it. */
async function run(redis: Redis, script: string, keys: string[], args: string[]): Promise<number> {
  try {
    return Number(await redis.evalsha(sha1(script), keys.length, ...keys, ...args));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
      throw error;
    }
    return Number(await redis.eval(script, keys.length, ...keys, ...args));
  }
}

export function createHoldStore(redis: Redis): HoldStore {
  return {
    async release({ eventId, holdId, qty }) {
      return (
        (await run(
          redis,
          RELEASE_LUA,
          [availKey(eventId), holdsKey(eventId), heldKey(eventId)],
          [holdId, String(qty)],
        )) === 1
      );
    },
    async confirm({ eventId, holdId, qty }) {
      return (
        (await run(
          redis,
          CONFIRM_LUA,
          [soldKey(eventId), holdsKey(eventId), heldKey(eventId)],
          [holdId, String(qty)],
        )) === 1
      );
    },
  };
}

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3 });
}
