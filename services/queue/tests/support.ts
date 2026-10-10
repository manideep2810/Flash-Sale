import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { requireSession } from "@flash/auth";
import { createLogger } from "@flash/observability";
import type { Counter, Gauge } from "prom-client";
import { bearer, TEST_SESSION_SECRET } from "../../../tools/tokens.js";
import { type Admitter, createAdmitter } from "../src/admitter/loop.js";
import { createEventConfigs } from "../src/config/events.js";
import { createApp } from "../src/http/app.js";
import { createQueueRouter } from "../src/http/routes.js";
import { createQueueService } from "../src/queue/service.js";
import { createTokenMinter } from "../src/queue/token.js";
import { createRedis, type Redis } from "../src/redis/client.js";
import {
  admittedKey,
  availKey,
  configKey,
  holdsKey,
  queueKey,
  stateKey,
} from "../src/redis/keys.js";
import { createScripts, type Scripts } from "../src/redis/scripts.js";

// The Redis-backed tests need the local Redis: `make test-queue`, or
// `REDIS_URL=redis://localhost:6380 pnpm -C services/queue test`. They are skipped when REDIS_URL is
// unset so plain `pnpm test` stays green.
export const REDIS_URL = process.env.REDIS_URL;

export const ADMISSION_SECRET = "test-only-admission-secret-0123456789abcdef";

export const logger = createLogger({ service: "queue", level: "error" });

/** The fields of the service's replies the tests read. */
export interface Reply {
  status?: string;
  code?: string;
  message?: string;
  state?: string;
  position?: number;
  peopleAhead?: number;
  estWaitSec?: number | null;
  retryAfterMs?: number;
  phase?: string;
  token?: string;
  expiresAt?: string;
  lobbyOpensAt?: number;
}

export interface HttpResult {
  status: number;
  body: Reply;
}

export interface SeedOptions {
  /** Relative to now; negative is in the past. Default: opened an hour ago. */
  lobbyOpensInMs?: number;
  /** Relative to now. Default: opened an hour ago, so joins go to the back of the line. */
  saleOpensInMs?: number;
  admitRatePerSec?: number;
  admitTtlSec?: number;
  /** The Phase 2 avail counter. Null leaves the key absent. Default: plenty. */
  stock?: number | null;
}

export interface SeededEvent {
  eventId: string;
  lobbyOpensAt: number;
  saleOpensAt: number;
}

export interface Harness {
  redis: Redis;
  scripts: Scripts;
  /** queue-svc. A call made as a user carries that user's session. */
  baseUrl: string;
  /** Redis's clock in ms: the one join.lua, status.lua and admit.lua read. */
  redisNow(): Promise<number>;
  seedEvent(options?: SeedOptions): Promise<SeededEvent>;
  join(eventId: string, userId?: string): Promise<HttpResult>;
  status(eventId: string, userId?: string): Promise<HttpResult>;
  /** A new admitter, as a restarted process would be: no memory of the last one. Stopped on close. */
  newAdmitter(): Admitter;
  close(): Promise<void>;
}

/** As `userId`, logged in. With no userId the request carries no session, unless `headers` adds one. */
export async function request(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  userId?: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(userId === undefined ? {} : { authorization: await bearer(userId) }),
      ...headers,
    },
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

/**
 * queue-svc and admitters wired exactly as the two entrypoints wire them, against the real Redis.
 *
 * Nothing here touches another run's data: every event gets a fresh id, the admitters iterate a set
 * of their own rather than queue:events (so an admitter left running by `make dev` never sees a test
 * event), and close() deletes only the keys this harness created.
 */
export async function createHarness(): Promise<Harness> {
  if (!REDIS_URL) {
    throw new Error("REDIS_URL is not set");
  }
  const runId = randomUUID().slice(0, 8);
  const eventsKey = `queue:events:test:${runId}`;
  const redis = createRedis(REDIS_URL);
  // The client sends nothing until it is connected; this rejects if the connection fails instead.
  await once(redis, "ready");
  const scripts = createScripts(redis, logger);
  await scripts.load();
  const events = createEventConfigs(redis);
  const service = createQueueService({
    events,
    scripts,
    mintToken: createTokenMinter(ADMISSION_SECRET),
  });

  const servers: Server[] = [];
  const admitters: Admitter[] = [];
  const eventIds: string[] = [];

  async function serve(): Promise<string> {
    const app = createApp({
      logger,
      routes: createQueueRouter({ service, authenticate: requireSession(TEST_SESSION_SECRET) }),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const baseUrl = await serve();

  return {
    redis,
    scripts,
    baseUrl,

    async redisNow() {
      const [seconds, micros] = await redis.time();
      return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    },

    async seedEvent({
      lobbyOpensInMs = -3_600_000,
      saleOpensInMs = -3_600_000,
      admitRatePerSec = 500,
      admitTtlSec = 120,
      stock = 1_000_000,
    } = {}) {
      const eventId = `t-${runId}-${eventIds.length}`;
      eventIds.push(eventId);
      const now = Date.now();
      const lobbyOpensAt = now + lobbyOpensInMs;
      const saleOpensAt = now + saleOpensInMs;
      await redis.hset(configKey(eventId), {
        lobbyOpensAt: String(lobbyOpensAt),
        saleOpensAt: String(saleOpensAt),
        admitRatePerSec: String(admitRatePerSec),
        admitTtlSec: String(admitTtlSec),
      });
      await redis.sadd(eventsKey, eventId);
      if (stock !== null) {
        await redis.set(availKey(eventId), String(stock));
      }
      return { eventId, lobbyOpensAt, saleOpensAt };
    },

    join: (eventId, userId) => request(baseUrl, "POST", `/queue/${eventId}/join`, userId),
    status: (eventId, userId) => request(baseUrl, "GET", `/queue/${eventId}/status`, userId),

    newAdmitter() {
      const admitter = createAdmitter({ redis, scripts, events, logger, eventsKey });
      admitters.push(admitter);
      return admitter;
    },

    async close() {
      await Promise.all(admitters.map((admitter) => admitter.stop()));
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
      const keys = eventIds.flatMap((eventId) => [
        configKey(eventId),
        queueKey(eventId),
        admittedKey(eventId),
        stateKey(eventId),
        availKey(eventId),
        holdsKey(eventId),
      ]);
      await redis.del(eventsKey, ...keys);
      await redis.quit();
    },
  };
}

/** Polls until `check` returns something other than undefined/false, or fails after `timeoutMs`. */
export async function until<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(20);
  }
}

/** The current value of one labelled series, or undefined when it has never been set. */
export async function metricValue(
  metric: Counter | Gauge,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const { values } = await metric.get();
  return values.find((sample) =>
    Object.entries(labels).every(([name, value]) => sample.labels[name] === value),
  )?.value;
}

/** user-000, user-001, ... Zero-padded so the order of names is the order they were made in. */
export function userIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
}
