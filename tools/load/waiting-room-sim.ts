// The crowd: tens of thousands of simulated users going through the waiting room the way the web app
// does, from one Node process, through the gateway.
//
//   pnpm -C tools exec tsx load/waiting-room-sim.ts --label small --lobbyUsers 500 \
//     --joinRatePerSec 250 --joinDurationSec 20 --admitRate 50 --stock 100000
//   make load-small        (switches the gateway to the load profile first, and checks the run after)
//
// Why Node and not k6: almost every user is waiting almost all of the time. Here a waiting user is a
// pending timer and a few hundred bytes; in k6 it would be a whole virtual user.
//
// What it does:
//   1. Seeds a fresh event: the waiting room straight into Redis (lobby open now, sale opening
//      --lobbySec from now) and --stock tickets through the ticket service's /redis/reset.
//   2. Plays the users. --lobbyUsers join during the lobby; then --joinRatePerSec more a second for
//      --joinDurationSec. Each one, with a session minted here (no login call):
//        join -> GET status, wait exactly retryAfterMs, again
//          QUEUED    keep waiting
//          ADMITTED  a no-show stops there (--noShowPct). Anyone else waits 0-5s, reserves with both
//                    tokens, pays, and reads the order once a second until it is settled (30s at most).
//          EXPIRED, SOLD_OUT, NOT_IN_QUEUE   recorded, and the user stops
//        A 429 waits out its Retry-After. A network error or a 5xx backs off 1, 2, 4... 15s.
//   3. Writes one JSON line per user to loadtest/results/phase5/<eventId>.jsonl, the run's settings
//      to <eventId>.meta.json, the summary to <eventId>.summary.json (and prints it), and what
//      Redis held for the event as the run ended to <eventId>.redis.json, for the order checker.
//
// With --rejoinAfterExpiry a no-show keeps polling until the server says EXPIRED, then joins again
// (at the back) and this time buys; so does a buyer whose turn ran out before the reserve.
//
// Every request goes through ONE keep-alive pool of at most --maxSockets connections. Every pending
// wait is in one set and can be cancelled, so --maxRunSec (or Ctrl-C) ends the run cleanly, and the
// process has to exit by itself afterwards: if anything is still holding it open five seconds
// later, it says what and exits 1.
//
// Two things it reads from Redis directly, for the order checker (tools/check-queue-order.ts) and
// for nothing else: each user's score in the queue right after their join (the API does not return
// it), and how far Redis's clock is from this machine's.

import { once } from "node:events";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { Pool } from "undici";
import { ADMISSION_HEADER, mintSessionToken } from "../tokens.js";
import { readRedisState } from "./lib/redis-state.js";
import { keysOf, redisClockOffset, seedStock, seedWaitingRoom } from "./lib/seed.js";
import { LatencyHistogram, PerSecond, seededRandom } from "./lib/stats.js";

// ---- settings ----------------------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    label: { type: "string" },
    eventId: { type: "string" },
    lobbyUsers: { type: "string" },
    lobbySec: { type: "string" },
    joinRatePerSec: { type: "string" },
    joinDurationSec: { type: "string" },
    admitRate: { type: "string" },
    admitTtlSec: { type: "string" },
    stock: { type: "string" },
    noShowPct: { type: "string" },
    failPct: { type: "string" },
    payAfterReserve: { type: "string" },
    rejoinAfterExpiry: { type: "string" },
    reserveDelayMaxSec: { type: "string" },
    maxRunSec: { type: "string" },
    maxSockets: { type: "string" },
    seed: { type: "string" },
    skipPreflight: { type: "string" },
    gateway: { type: "string" },
    ticketUrl: { type: "string" },
    redisUrl: { type: "string" },
    out: { type: "string" },
  },
});

/** A flag, or the same name in SCREAMING_SNAKE_CASE from the environment, or the default. */
function setting(name: keyof typeof flags, fallback: string): string {
  const fromEnv = process.env[name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()];
  return flags[name] ?? (fromEnv === undefined || fromEnv === "" ? fallback : fromEnv);
}

function numberSetting(name: keyof typeof flags, fallback: number, min = 0): number {
  const raw = setting(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`--${name} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

const yes = (name: keyof typeof flags, fallback: boolean) =>
  ["1", "true", "yes"].includes(setting(name, String(fallback)).toLowerCase());

const LABEL = setting("label", "run").replace(/[^a-zA-Z0-9-]/g, "-");
/** Short and unique per run: in the event id and in every user id. */
const RUN_TAG = Date.now().toString(36);
const config = {
  label: LABEL,
  eventId: setting("eventId", `load-${LABEL}-${RUN_TAG}`),
  lobbyUsers: Math.round(numberSetting("lobbyUsers", 0)),
  /** How long the lobby is open before the sale: the lobby users join during it. */
  lobbySec: numberSetting("lobbySec", 15),
  joinRatePerSec: numberSetting("joinRatePerSec", 0),
  joinDurationSec: numberSetting("joinDurationSec", 0),
  /** Written to the event's config, where the admitter reads it; here it is otherwise only logged. */
  admitRate: numberSetting("admitRate", 50, 1),
  admitTtlSec: Math.round(numberSetting("admitTtlSec", 120, 1)),
  stock: Math.round(numberSetting("stock", 100_000)),
  noShowPct: numberSetting("noShowPct", 10),
  /** These users get a "fail-" id; the mock payment declines them when it runs with NODE_ENV=test. */
  failPct: numberSetting("failPct", 0),
  payAfterReserve: yes("payAfterReserve", true),
  rejoinAfterExpiry: yes("rejoinAfterExpiry", false),
  reserveDelayMaxSec: numberSetting("reserveDelayMaxSec", 5),
  maxRunSec: numberSetting("maxRunSec", 600, 1),
  maxSockets: Math.round(numberSetting("maxSockets", 256, 1)),
  seed: Math.round(numberSetting("seed", 1)),
  gateway: setting("gateway", "http://localhost:8080"),
  ticketUrl: setting("ticketUrl", "http://localhost:3001"),
  redisUrl: setting("redisUrl", "redis://localhost:6380"),
  out: setting("out", fileURLToPath(new URL("../../loadtest/results/phase5/", import.meta.url))),
};

const POST_OPEN_USERS = Math.round(config.joinRatePerSec * config.joinDurationSec);
const TOTAL_USERS = config.lobbyUsers + POST_OPEN_USERS;
if (TOTAL_USERS === 0) {
  throw new Error(
    "nobody to simulate: set --lobbyUsers, or --joinRatePerSec and --joinDurationSec",
  );
}

/** What the order ends as; nothing more happens to it after one of these. */
const SETTLED = new Set(["PAID", "CONFIRMED", "PAYMENT_FAILED", "RELEASED", "EXPIRED", "REFUNDED"]);
/** How long to wait for the order to exist and be payable, and then for the payment's outcome. */
const ORDER_WAIT_MS = 30_000;
const ORDER_POLL_MS = 1_000;
/** An admitted no-show waiting for its turn to expire asks this often (ADMITTED names no interval). */
const ADMITTED_POLL_MS = 2_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
/** What a 429 without a Retry-After waits. */
const RATE_LIMIT_FALLBACK_MS = 1_000;

// ---- what is recorded --------------------------------------------------------------------------------

type Route = "join" | "status" | "reserve" | "pay" | "order";
const ROUTES: Route[] = ["join", "status", "reserve", "pay", "order"];

/** One stay in the queue. A user has one, or two when their turn expired and they joined again. */
interface Cycle {
  /** This machine's clock, ms: when the join was sent and when its answer arrived. */
  joinSentAt: number;
  joinedAt: number;
  /** The user's score in the queue, read from Redis after the join. Null when already admitted by then. */
  score: number | null;
  /** Redis's clock, ms, exactly as admit.lua stamped it (the turn's end minus its length). */
  admittedAt: number | null;
  expiredAt: number | null;
}

interface User {
  userId: string;
  /** "lobby" joined before the sale opened, "open" after. */
  kind: "lobby" | "open";
  noShow: boolean;
  cycles: Cycle[];
  polls: number;
  status429s: number;
  reservedAt: number | null;
  reserveResult: string | null;
  payResult: string | null;
  orderId: string | null;
  finalState: string;
  /** Network errors and 5xx answers this user backed off from. */
  errors: number;
}

const started = Date.now();
const latency = Object.fromEntries(
  ROUTES.map((route) => [route, new LatencyHistogram()]),
) as Record<Route, LatencyHistogram>;
const answers = Object.fromEntries(
  ROUTES.map((route) => [route, new Map<number, number>()]),
) as Record<Route, Map<number, number>>;
const timeline = {
  joins: new PerSecond(started),
  admitted: new PerSecond(started),
  reserves: new PerSecond(started),
  polls: new PerSecond(started),
};
const waitingBySecond: number[] = [];
const gauges = { waiting: 0, peakWaiting: 0, inFlight: 0, peakInFlight: 0, done: 0, peakHeapMb: 0 };

// ---- plumbing ---------------------------------------------------------------------------------------

const pool = new Pool(config.gateway, {
  connections: config.maxSockets,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: 15_000,
  bodyTimeout: 15_000,
});
// Instrumentation only: scores and the clock. Auto-pipelining folds the reads of one tick into one write.
const redis = new Redis(config.redisUrl, { enableAutoPipelining: true, maxRetriesPerRequest: 3 });
redis.on("error", () => {});
const keys = keysOf(config.eventId);

/** The request did not get an answer at all. */
class NetworkError extends Error {}
/** The run is over: every wait and every request in flight ends with this. */
class Stopped extends Error {}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  retryAfterMs: number | null;
}

// Stopping. One abort signal shared by every wait would mean one listener per waiting user on a
// single object; a set of cancel functions costs the same to add to and to remove from whatever
// its size.
let stopped = false;
const sleepers = new Set<() => void>();

function wait(ms: number): Promise<void> {
  if (stopped) {
    return Promise.reject(new Stopped());
  }
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new Stopped());
    };
    const timer = setTimeout(() => {
      sleepers.delete(cancel);
      resolve();
    }, ms);
    sleepers.add(cancel);
  });
}

/** Ends the run now: every pending wait is cancelled and every request in flight is dropped. */
function stopRun(): void {
  if (stopped) {
    return;
  }
  stopped = true;
  for (const cancel of sleepers) {
    cancel();
  }
  sleepers.clear();
  void pool.destroy();
}

/** One request through the pool, timed and counted. */
async function call(
  route: Route,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  if (stopped) {
    throw new Stopped();
  }
  gauges.inFlight++;
  gauges.peakInFlight = Math.max(gauges.peakInFlight, gauges.inFlight);
  const sentAt = performance.now();
  try {
    const res = await pool.request({
      method,
      path,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Always read to the end: an unread body keeps its connection out of the pool.
    const text = await res.body.text();
    latency[route].record(performance.now() - sentAt);
    answers[route].set(res.statusCode, (answers[route].get(res.statusCode) ?? 0) + 1);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Not JSON: the status is the answer.
    }
    const retryAfterSec = Number(res.headers["retry-after"]);
    return {
      status: res.statusCode,
      body: parsed,
      retryAfterMs:
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : null,
    };
  } catch (error) {
    if (stopped) {
      throw new Stopped();
    }
    answers[route].set(0, (answers[route].get(0) ?? 0) + 1);
    throw new NetworkError(String(error));
  } finally {
    gauges.inFlight--;
  }
}

/**
 * A request that is repeated until it gets a real answer: a 429 waits out its Retry-After, and a
 * network error or a 502/503/504 backs off 1, 2, 4... 15 seconds.
 */
async function insist(user: User, route: Route, send: () => Promise<Reply>): Promise<Reply> {
  let backoffMs = BACKOFF_START_MS;
  for (;;) {
    let reply: Reply;
    try {
      reply = await send();
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }
      user.errors++;
      await wait(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      continue;
    }
    if (reply.status === 429) {
      if (route === "status") {
        user.status429s++;
      }
      await wait(reply.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS);
      continue;
    }
    if (reply.status === 502 || reply.status === 503 || reply.status === 504) {
      user.errors++;
      await wait(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      continue;
    }
    return reply;
  }
}

// ---- one user ----------------------------------------------------------------------------------------

const random = seededRandom(config.seed);
const queuePath = `/api/queue/${encodeURIComponent(config.eventId)}`;

function setWaiting(delta: 1 | -1): void {
  gauges.waiting += delta;
  gauges.peakWaiting = Math.max(gauges.peakWaiting, gauges.waiting);
}

/** The server's retryAfterMs, or two seconds if an answer ever came without a usable one. */
const delayOf = (body: Record<string, unknown>): number => {
  const ms = Number(body.retryAfterMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 2_000;
};

/** How a stay in the queue ended: admitted, with the admission token, or the name of anything else. */
type QueueEnd =
  | { admission: string }
  | { ended: "EXPIRED" | "SOLD_OUT" | "NOT_IN_QUEUE" | `ERROR_${string}` };

/** Joins and waits in line, asking again exactly as often as the server says. */
async function queueUp(user: User, auth: Record<string, string>): Promise<QueueEnd> {
  const joinSentAt = Date.now();
  const joined = await insist(user, "join", () => call("join", "POST", `${queuePath}/join`, auth));
  if (joined.status !== 200) {
    return { ended: `ERROR_JOIN_${joined.body.code ?? joined.status}` };
  }
  if (joined.body.status === "SOLD_OUT") {
    return { ended: "SOLD_OUT" };
  }
  const cycle: Cycle = {
    joinSentAt,
    joinedAt: Date.now(),
    score: null,
    admittedAt: null,
    expiredAt: null,
  };
  user.cycles.push(cycle);
  timeline.joins.add(cycle.joinedAt);
  const score = await redis.zscore(keys.queue, user.userId).catch(() => null);
  cycle.score = score === null ? null : Number(score);

  setWaiting(1);
  try {
    // join answers ADMITTED without the token; status has it, and is asked at once.
    let delayMs = joined.body.status === "QUEUED" ? delayOf(joined.body) : 0;
    for (;;) {
      // Exactly what the server asked for, counted from when its answer arrived.
      await wait(delayMs);
      const status = await insist(user, "status", () =>
        call("status", "GET", `${queuePath}/status`, auth),
      );
      user.polls++;
      timeline.polls.add();
      if (status.status !== 200) {
        return { ended: `ERROR_STATUS_${status.body.code ?? status.status}` };
      }
      switch (status.body.status) {
        case "QUEUED":
          delayMs = delayOf(status.body);
          break;
        case "ADMITTED":
          // The turn's end minus its length is the instant admit.lua stamped, to the millisecond.
          cycle.admittedAt = Date.parse(String(status.body.expiresAt)) - config.admitTtlSec * 1000;
          timeline.admitted.add();
          return { admission: String(status.body.token) };
        case "EXPIRED":
          cycle.expiredAt = Date.now();
          return { ended: "EXPIRED" };
        case "SOLD_OUT":
          return { ended: "SOLD_OUT" };
        case "NOT_IN_QUEUE":
          return { ended: "NOT_IN_QUEUE" };
        default:
          return { ended: `ERROR_STATUS_${String(status.body.status)}` };
      }
    }
  } finally {
    setWaiting(-1);
  }
}

/** Whether it is still the user's turn, by the server's word. */
async function stillAdmitted(user: User, auth: Record<string, string>): Promise<boolean> {
  const status = await insist(user, "status", () =>
    call("status", "GET", `${queuePath}/status`, auth),
  );
  user.polls++;
  timeline.polls.add();
  return status.status === 200 && status.body.status === "ADMITTED";
}

/** Reserves, pays and follows the order. Returns the user's final state, or "EXPIRED" to rejoin. */
async function buy(user: User, auth: Record<string, string>, admission: string): Promise<string> {
  await wait(random() * config.reserveDelayMaxSec * 1000);
  const reserved = await insist(user, "reserve", () =>
    call(
      "reserve",
      "POST",
      "/api/reserve",
      { ...auth, [ADMISSION_HEADER]: admission },
      { eventId: config.eventId, qty: 1 },
    ),
  );
  user.reservedAt = Date.now();
  timeline.reserves.add(user.reservedAt);
  if (reserved.status === 409) {
    user.reserveResult = "SOLD_OUT";
    return "SOLD_OUT";
  }
  if (reserved.status === 401) {
    // The turn ran out before the reserve (the gateway and the service both answer 401 for that).
    user.reserveResult = "TURN_EXPIRED";
    return "EXPIRED";
  }
  if (reserved.status !== 201) {
    user.reserveResult = `REFUSED_${reserved.body.code ?? reserved.body.error ?? reserved.status}`;
    return `ERROR_RESERVE_${reserved.status}`;
  }
  user.reserveResult = "RESERVED";
  user.orderId = String(reserved.body.holdId);
  if (!config.payAfterReserve) {
    return "RESERVED";
  }

  const orderPath = `/api/orders/${encodeURIComponent(user.orderId)}`;
  // The order is created from the reservation a moment later; until then /pay answers 404. (The
  // API has no ORDER_NOT_READY code: a 404 here is that, and a Retry-After is honoured if one comes.)
  const giveUpAt = Date.now() + ORDER_WAIT_MS;
  for (;;) {
    const paid = await insist(user, "pay", () => call("pay", "POST", `${orderPath}/pay`, auth));
    if (paid.status === 202 || paid.status === 200) {
      break;
    }
    if (paid.status === 404 && Date.now() < giveUpAt) {
      await wait(paid.retryAfterMs ?? ORDER_POLL_MS);
      continue;
    }
    user.payResult =
      paid.status === 404 ? "ORDER_NOT_READY" : String(paid.body.error ?? `HTTP_${paid.status}`);
    return paid.status === 404 ? "PAY_TIMEOUT" : `PAY_REFUSED_${user.payResult}`;
  }

  const settleBy = Date.now() + ORDER_WAIT_MS;
  for (;;) {
    const order = await insist(user, "order", () => call("order", "GET", orderPath, auth));
    const state = order.status === 200 ? String(order.body.state) : "";
    if (SETTLED.has(state)) {
      user.payResult = state === "PAID" || state === "CONFIRMED" ? "PAID" : "FAILED";
      return state === "CONFIRMED" ? "PAID" : state;
    }
    if (Date.now() >= settleBy) {
      user.payResult = "UNDECIDED";
      return "PAY_TIMEOUT";
    }
    await wait(ORDER_POLL_MS);
  }
}

async function play(user: User, startAt: number): Promise<void> {
  await wait(Math.max(0, startAt - Date.now()));
  const auth = { authorization: `Bearer ${await mintSessionToken(user.userId)}` };

  for (;;) {
    const turn = await queueUp(user, auth);
    if ("ended" in turn) {
      user.finalState = turn.ended;
      return;
    }
    user.finalState = "ADMITTED";

    if (user.noShow) {
      if (!config.rejoinAfterExpiry) {
        user.finalState = "NO_SHOW";
        return;
      }
      // Lets the turn run out, as someone who walked away from the page would, then comes back.
      do {
        await wait(ADMITTED_POLL_MS);
      } while (await stillAdmitted(user, auth));
      const cycle = user.cycles.at(-1);
      if (cycle) {
        cycle.expiredAt = Date.now();
      }
      user.noShow = false;
      continue;
    }

    const result = await buy(user, auth, turn.admission);
    if (result === "EXPIRED" && config.rejoinAfterExpiry && user.cycles.length < 2) {
      const cycle = user.cycles.at(-1);
      if (cycle) {
        cycle.expiredAt = Date.now();
      }
      continue;
    }
    user.finalState = result;
    return;
  }
}

// ---- the run -----------------------------------------------------------------------------------------

mkdirSync(config.out, { recursive: true });
const base = join(config.out, config.eventId);
const log = createWriteStream(`${base}.jsonl`, { encoding: "utf8" });
/** One waiter for "drain", shared: thousands of users can finish in the same instant. */
let draining: Promise<void> | null = null;

async function record(user: User): Promise<void> {
  const last = user.cycles.at(-1);
  const line = JSON.stringify({
    userId: user.userId,
    kind: user.kind,
    joinedAt: last?.joinedAt ?? null,
    score: last?.score ?? null,
    admittedAt: last?.admittedAt ?? null,
    reservedAt: user.reservedAt,
    reserveResult: user.reserveResult,
    payResult: user.payResult,
    finalState: user.finalState,
    status429s: user.status429s,
    polls: user.polls,
    orderId: user.orderId,
    errors: user.errors,
    cycles: user.cycles,
  });
  if (!log.write(`${line}\n`)) {
    draining ??= once(log, "drain").then(() => {
      draining = null;
    });
    await draining;
  }
}

/** Fewer answers a second than this from a short burst, and the stack cannot take a load run. */
const PREFLIGHT_MIN_RPS = 100;

/**
 * A short burst of status calls before anything is seeded: 200 of them, 20 at a time, each from a
 * user of its own. A stack that is ready answers thousands a second. One that answers a handful is
 * almost always logging every request to a terminal (`make dev` on Windows blocks on that), and a
 * run against it would measure the terminal. Better to say so than to produce numbers.
 */
async function preflight(): Promise<void> {
  const total = 200;
  const tokens = await Promise.all(
    Array.from({ length: total }, (_, i) => mintSessionToken(`preflight-${RUN_TAG}-${i}`)),
  );
  const probe = new LatencyHistogram();
  const statuses = new Map<number, number>();
  let next = 0;
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (next < total) {
        const token = tokens[next++];
        const sentAt = performance.now();
        let status = 0;
        try {
          const res = await pool.request({
            method: "GET",
            path: `${queuePath}/status`,
            headers: { authorization: `Bearer ${token}` },
          });
          await res.body.text();
          status = res.statusCode;
        } catch {
          // Counted as status 0.
        }
        probe.record(performance.now() - sentAt);
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      }
    }),
  );
  const rps = Math.round((total / (performance.now() - startedAt)) * 1000);
  // 404 EVENT_NOT_FOUND is the expected answer: the event is seeded after this.
  const answered = (statuses.get(404) ?? 0) + (statuses.get(200) ?? 0);
  const seen = [...statuses].map(([status, n]) => `${status || "no answer"} x${n}`).join(", ");
  console.log(
    `preflight    ${rps} status calls/s, p50 ${probe.summary().p50} ms, p99 ${probe.summary().p99} ms (${seen})`,
  );
  if (answered < total || rps < PREFLIGHT_MIN_RPS) {
    throw new Error(
      `preflight: the stack answered ${answered} of ${total} status calls, ${rps} a second ` +
        `(${seen}). A load run needs thousands a second. If the services are running under ` +
        "`make dev`, they are logging every request to the terminal, and on Windows that blocks " +
        "them: start them with `make dev-loadtest` (LOG_LEVEL=warn). Otherwise check that the " +
        "stack is up (`make up`) and the gateway is on the load profile (`make load-profile`). " +
        "--skipPreflight true runs anyway.",
    );
  }
}

const count = (n: number) => n.toLocaleString("en-US");

async function main(): Promise<void> {
  if (!yes("skipPreflight", false)) {
    await preflight();
  }

  // 1. The event.
  const clockAtStart = await redisClockOffset(redis);
  await seedStock(config.ticketUrl, config.eventId, config.stock);
  const seededAt = Date.now();
  const saleOpensAt = seededAt + Math.round(config.lobbySec * 1000);
  await seedWaitingRoom(redis, {
    eventId: config.eventId,
    // A second ago, so that it is open by every clock involved.
    lobbyOpensAt: seededAt - 1_000,
    saleOpensAt,
    admitRatePerSec: config.admitRate,
    admitTtlSec: config.admitTtlSec,
    name: `Load run ${config.label}`,
    price: 1_999,
  });
  const meta = {
    ...config,
    users: TOTAL_USERS,
    postOpenUsers: POST_OPEN_USERS,
    startedAt: started,
    saleOpensAt,
    redisClock: { atStart: clockAtStart, atEnd: clockAtStart },
    endedAt: null as number | null,
  };
  writeFileSync(`${base}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);

  console.log(`event        ${config.eventId}`);
  console.log(
    `users        ${count(TOTAL_USERS)}: ${count(config.lobbyUsers)} in the lobby, then ` +
      `${config.joinRatePerSec}/s for ${config.joinDurationSec}s`,
  );
  console.log(
    `sale         opens in ${config.lobbySec}s, admits ${config.admitRate}/s, a turn lasts ` +
      `${config.admitTtlSec}s, ${count(config.stock)} tickets`,
  );
  console.log(
    `behaviour    ${config.noShowPct}% no-shows, ${config.failPct}% "fail-" ids, ` +
      `${config.payAfterReserve ? "pay after reserving" : "reserve only"}` +
      `${config.rejoinAfterExpiry ? ", rejoin after an expired turn" : ""}`,
  );
  console.log(`limits       ${config.maxSockets} sockets, stops after ${config.maxRunSec}s`);
  console.log("");

  // 2. The users. Lobby users are spread over the lobby, ending well before the sale opens, so that
  //    every one of them is in the queue when the draw is made.
  const lobbyWindowMs = Math.max(
    0,
    config.lobbySec * 1000 - Math.min(3_000, config.lobbySec * 300),
  );
  const users: { user: User; startAt: number }[] = [];
  const newUser = (kind: User["kind"], index: number): User => ({
    userId: `${random() * 100 < config.failPct ? "fail" : "ok"}-${RUN_TAG}-${kind === "lobby" ? "L" : "J"}${index}`,
    kind,
    noShow: random() * 100 < config.noShowPct,
    cycles: [],
    polls: 0,
    status429s: 0,
    reservedAt: null,
    reserveResult: null,
    payResult: null,
    orderId: null,
    finalState: "NOT_STARTED",
    errors: 0,
  });
  for (let i = 0; i < config.lobbyUsers; i++) {
    users.push({
      user: newUser("lobby", i),
      startAt: seededAt + (lobbyWindowMs * i) / Math.max(1, config.lobbyUsers),
    });
  }
  for (let i = 0; i < POST_OPEN_USERS; i++) {
    users.push({
      user: newUser("open", i),
      startAt: saleOpensAt + (i / config.joinRatePerSec) * 1000,
    });
  }

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const everySecond = setInterval(() => {
    waitingBySecond[Math.floor((Date.now() - started) / 1000)] = gauges.waiting;
    gauges.peakHeapMb = Math.max(gauges.peakHeapMb, process.memoryUsage().heapUsed / 1_048_576);
  }, 1_000);
  const progress = setInterval(() => {
    const second = Math.floor((Date.now() - started) / 1000);
    console.log(
      `  t+${String(second).padStart(3)}s  waiting ${count(gauges.waiting).padStart(7)}  ` +
        `done ${count(gauges.done).padStart(7)}/${count(TOTAL_USERS)}  ` +
        `in flight ${String(gauges.inFlight).padStart(4)}  ` +
        `polls/s ${count(timeline.polls.series(second).at(-1) ?? 0).padStart(6)}`,
    );
  }, 5_000);
  const deadline = setTimeout(stopRun, config.maxRunSec * 1000);
  process.once("SIGINT", stopRun);

  await Promise.all(
    users.map(async ({ user, startAt }) => {
      try {
        await play(user, startAt);
      } catch (error) {
        if (error instanceof Stopped) {
          // Stopped mid-way: what the user had reached is what is recorded.
          const last = user.cycles.at(-1);
          user.finalState =
            user.finalState === "ADMITTED"
              ? "ADMITTED_AT_STOP"
              : last && last.admittedAt === null
                ? "QUEUED_AT_STOP"
                : `${user.finalState}_AT_STOP`;
        } else {
          user.finalState = `ERROR_${error instanceof Error ? error.message : String(error)}`;
        }
      }
      gauges.done++;
      await record(user);
    }),
  );

  // 3. Nothing may be left running: timers, the pool, Redis, the log.
  const stoppedEarly = stopped;
  clearTimeout(deadline);
  clearInterval(everySecond);
  clearInterval(progress);
  process.removeListener("SIGINT", stopRun);
  loopDelay.disable();
  // Redis as the run ends: the queue, the admitted hash, the stock. The order checker judges the
  // run against this picture, however much later it is run.
  writeFileSync(`${base}.redis.json`, JSON.stringify(await readRedisState(redis, config.eventId)));
  const clockAtEnd = await redisClockOffset(redis);
  log.end();
  await once(log, "finish");
  // close() lets what is in flight finish, and nothing is; a stopped run destroyed the pool already.
  await (stopped ? pool.destroy() : pool.close());
  await redis.quit();

  const ended = Date.now();
  const seconds = Math.ceil((ended - started) / 1000);
  const final = (state: string) => users.filter(({ user }) => user.finalState === state).length;
  const reached = (test: (user: User) => boolean) => users.filter(({ user }) => test(user)).length;
  const errors = users.filter(({ user }) => user.finalState.startsWith("ERROR")).length;
  const pollsTotal = users.reduce((sum, { user }) => sum + user.polls, 0);
  const statusCounts = (route: Route) =>
    Object.fromEntries([...answers[route]].sort(([a], [b]) => a - b));
  const summary = {
    eventId: config.eventId,
    label: config.label,
    durationSec: seconds,
    stoppedEarly,
    users: {
      planned: TOTAL_USERS,
      joined: reached((user) => user.cycles.length > 0),
      admitted: reached((user) => user.cycles.some((cycle) => cycle.admittedAt !== null)),
      noShow: final("NO_SHOW"),
      reserved: reached((user) => user.reserveResult === "RESERVED"),
      paid: final("PAID"),
      paymentFailed: reached((user) => user.payResult === "FAILED"),
      soldOut: final("SOLD_OUT"),
      expired: final("EXPIRED"),
      expiredAndRejoined: reached((user) => user.cycles.length > 1),
      notInQueue: final("NOT_IN_QUEUE"),
      payTimeout: final("PAY_TIMEOUT"),
      stillQueuedAtStop: final("QUEUED_AT_STOP"),
      errors,
    },
    peakConcurrentWaiting: gauges.peakWaiting,
    polls: {
      total: pollsTotal,
      perSecondAverage: Math.round(pollsTotal / Math.max(1, seconds)),
      perSecondPeak: timeline.polls.peak,
    },
    rateLimited429: Object.fromEntries(
      ROUTES.map((route) => [route, answers[route].get(429) ?? 0]),
    ),
    networkErrors: Object.fromEntries(ROUTES.map((route) => [route, answers[route].get(0) ?? 0])),
    answersByStatus: Object.fromEntries(ROUTES.map((route) => [route, statusCounts(route)])),
    latencyMs: Object.fromEntries(ROUTES.map((route) => [route, latency[route].summary()])),
    client: {
      peakRequestsInFlight: gauges.peakInFlight,
      maxSockets: config.maxSockets,
      eventLoopDelayP99Ms: Math.round(loopDelay.percentile(99) / 1e4) / 100,
      peakHeapMb: Math.round(gauges.peakHeapMb),
    },
    timeline: {
      // One number per second since the start.
      joins: timeline.joins.series(seconds),
      admitted: timeline.admitted.series(seconds),
      reserves: timeline.reserves.series(seconds),
      polls: timeline.polls.series(seconds),
      waiting: Array.from({ length: seconds }, (_, second) => waitingBySecond[second] ?? 0),
    },
  };
  writeFileSync(`${base}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    `${base}.meta.json`,
    `${JSON.stringify({ ...meta, redisClock: { atStart: clockAtStart, atEnd: clockAtEnd }, endedAt: ended }, null, 2)}\n`,
  );

  const u = summary.users;
  const ms = (route: Route) =>
    `p50 ${summary.latencyMs[route]?.p50} ms, p99 ${summary.latencyMs[route]?.p99} ms ` +
    `(${count(summary.latencyMs[route]?.count ?? 0)} requests)`;
  console.log("");
  console.log(
    `SUMMARY  ${config.eventId}  (${seconds}s${stoppedEarly ? ", STOPPED at --maxRunSec" : ""})`,
  );
  console.log(`  joined            ${count(u.joined)} of ${count(u.planned)}`);
  console.log(`  admitted          ${count(u.admitted)}`);
  console.log(`  no-show           ${count(u.noShow)}`);
  console.log(`  reserved          ${count(u.reserved)}`);
  console.log(`  paid              ${count(u.paid)}   (payment failed: ${count(u.paymentFailed)})`);
  console.log(`  sold out          ${count(u.soldOut)}`);
  console.log(
    `  expired           ${count(u.expired)}   (expired and rejoined: ${count(u.expiredAndRejoined)})`,
  );
  console.log(
    `  other             not in queue ${u.notInQueue}, pay timeout ${u.payTimeout}, ` +
      `still queued at stop ${count(u.stillQueuedAtStop)}, errors ${u.errors}`,
  );
  console.log(`  peak waiting      ${count(summary.peakConcurrentWaiting)}`);
  console.log(
    `  polls             ${count(summary.polls.total)} total, ${count(summary.polls.perSecondAverage)}/s ` +
      `average, ${count(summary.polls.perSecondPeak)}/s peak`,
  );
  console.log(
    `  429s by route     ${ROUTES.map((route) => `${route} ${summary.rateLimited429[route]}`).join(", ")}`,
  );
  console.log(`  join              ${ms("join")}`);
  console.log(`  status            ${ms("status")}`);
  console.log(`  reserve           ${ms("reserve")}`);
  console.log(
    `  this client       ${summary.client.peakRequestsInFlight} requests in flight at most ` +
      `(${config.maxSockets} sockets allowed), event-loop delay p99 ` +
      `${summary.client.eventLoopDelayP99Ms} ms, heap ${summary.client.peakHeapMb} MB at most`,
  );
  console.log("");
  const shown = (file: string) =>
    relative(fileURLToPath(new URL("../../", import.meta.url)), file).replaceAll("\\", "/");
  console.log(`  log       ${shown(`${base}.jsonl`)}`);
  console.log(`  summary   ${shown(`${base}.summary.json`)}`);
}

main().then(
  () => {
    // The process must now end by itself. If it has not in five seconds something leaked: say what.
    setTimeout(() => {
      console.error("LEAK: the process is still held open by", process.getActiveResourcesInfo());
      process.exit(1);
    }, 5_000).unref();
  },
  (error) => {
    console.error(`the run failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);
