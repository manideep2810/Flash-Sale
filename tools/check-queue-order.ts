// Was a waiting-room run fair, and is everybody accounted for?
//
//   pnpm -C tools exec tsx check-queue-order.ts --eventId load-small-mv3u9brd
//   pnpm -C tools exec tsx check-queue-order.ts --log ../loadtest/results/phase5/<eventId>.jsonl
//
// It reads what the simulator wrote (tools/load/waiting-room-sim.ts): the log, one line per user;
// the run's .meta.json; and .redis.json, what Redis held for the event the moment the run ended.
// (--live reads Redis as it is now instead. That is only as good as the picture is fresh: the
// admitter clears a user out of the admitted hash a minute after their turn expired.) It checks:
//
//   Admission order    nobody was served after someone with a HIGHER score who was let in on an
//                      earlier tick of the admitter. Order inside one tick does not count.
//   Lobby first        every user who drew a lottery number in the lobby was served before every
//                      user who joined after the sale opened (unless their turn expired and they
//                      came back, which puts them at the back like anyone else).
//   Conservation       joined = still queued + admitted (whatever they did next) + admitted after
//                      the simulator stopped watching. Anyone left over was lost.
//   Saga invariants    the Phase 4 checker (check-invariants.ts) for this event: stock adds up (I1),
//                      no oversell (I5), no double charge (I6), and the rest of its list.
//
// The rules themselves are in load/lib/order-check.ts, with tests that plant an inversion and a
// lost user to show the checker fails when it should. Prints a PASS/FAIL table and exits 0 or 1.
//
// When it is done it takes the event off the admitter's list (the event's keys all stay), because
// an event left listed costs the admitter a script call on every tick from then on. --keep leaves it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { checkInvariants } from "./check-invariants.js";
import {
  type ConservationVerdict,
  checkAdmissionOrder,
  checkConservation,
  type Inversion,
  type LoggedUser,
  type OrderVerdict,
} from "./load/lib/order-check.js";
import { type RedisState, readRedisState } from "./load/lib/redis-state.js";
import { unlistEvent } from "./load/lib/seed.js";

const { values: flags } = parseArgs({
  options: {
    eventId: { type: "string" },
    log: { type: "string" },
    dir: { type: "string" },
    redisUrl: { type: "string" },
    live: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    skipInvariants: { type: "boolean", default: false },
  },
});

const RESULTS = fileURLToPath(new URL("../loadtest/results/phase5/", import.meta.url));
const REDIS_URL = flags.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6380";
/** How many of the offenders to print; the count is always the whole number. */
const EXAMPLES = 8;

interface ClockReading {
  offsetMs: number;
  uncertaintyMs: number;
}

interface Meta {
  eventId: string;
  redisClock?: { atStart: ClockReading; atEnd: ClockReading };
}

interface Row {
  pass: boolean;
  name: string;
  detail: string[];
}

const count = (n: number) => n.toLocaleString("en-US");

/** The run's three files, by its event id or by its log's path. */
function locate(): { logPath: string; metaPath: string; statePath: string } {
  const stem = flags.log
    ? flags.log.replace(/\.jsonl$/, "")
    : flags.eventId
      ? join(flags.dir ?? RESULTS, flags.eventId)
      : null;
  if (stem === null) {
    throw new Error(
      "give --eventId <id> (a run in loadtest/results/phase5/) or --log <file.jsonl>",
    );
  }
  return {
    logPath: `${stem}.jsonl`,
    metaPath: `${stem}.meta.json`,
    statePath: `${stem}.redis.json`,
  };
}

function readUsers(logPath: string): LoggedUser[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as LoggedUser;
      } catch {
        throw new Error(`${logPath}: line ${index + 1} is not JSON`);
      }
    });
}

const describe = (found: Inversion): string =>
  `${found.userId} (score ${found.score}) ` +
  `${found.admittedAt === null ? "was never admitted" : `was admitted at ${found.admittedAt}`}, ` +
  `after ${found.aheadUserId} (score ${found.aheadScore}) at ${found.aheadAdmittedAt}`;

function orderRows(order: OrderVerdict): Row[] {
  const setAside = [
    order.concurrent > 0 ? `${count(order.concurrent)} joins still in flight at a tick` : "",
    order.unknownScore > 0
      ? `${count(order.unknownScore)} admitted before their score could be read`
      : "",
  ].filter(Boolean);
  return [
    {
      pass: order.inversions.length === 0,
      name: "Admission order",
      detail: [
        `${count(order.compared)} stays in the queue compared over ${count(order.ticks)} admitter ` +
          `ticks: ${count(order.inversions.length)} inversions (expected 0)`,
        ...(setAside.length > 0 ? [`not judged: ${setAside.join("; ")}`] : []),
        ...order.inversions.slice(0, EXAMPLES).map(describe),
      ],
    },
    {
      pass: order.lobby.servedAfterPostOpen.length === 0,
      name: "Lobby first",
      detail: [
        `${count(order.lobby.stays)} lobby stays (${count(order.lobby.admitted)} admitted), ` +
          `${count(order.lobby.postOpenAdmitted)} post-open stays admitted: ` +
          `${count(order.lobby.servedAfterPostOpen.length)} lobby users passed over by a post-open ` +
          "user (expected 0)",
        ...order.lobby.servedAfterPostOpen.slice(0, EXAMPLES).map(describe),
      ],
    },
  ];
}

function conservationRow(kept: ConservationVerdict): Row {
  const accounted = kept.stillQueued + kept.admitted + kept.admittedAfterRunStopped;
  const problems = [
    ...kept.missing.slice(0, EXAMPLES).map((userId) => `missing: ${userId}`),
    ...kept.inBoth.slice(0, EXAMPLES).map((userId) => `admitted AND still queued: ${userId}`),
    ...kept.stampMismatch
      .slice(0, EXAMPLES)
      .map((userId) => `Redis holds another admittedAt than they were told: ${userId}`),
  ];
  return {
    pass: kept.missing.length === 0 && kept.inBoth.length === 0 && kept.stampMismatch.length === 0,
    name: "Conservation",
    detail: [
      `${count(kept.joined)} joined = ${count(kept.stillQueued)} still queued + ` +
        `${count(kept.admitted)} admitted (${count(kept.leftAfterExpiry)} of them left after their ` +
        `turn expired) + ${count(kept.admittedAfterRunStopped)} admitted after the run stopped ` +
        `watching  [${count(accounted)} accounted for, ${count(kept.missing.length)} missing]`,
      ...(kept.unknownInQueue > 0
        ? [`also in the queue, not from this log: ${count(kept.unknownInQueue)}`]
        : []),
      ...problems,
    ],
  };
}

function print(eventId: string, rows: Row[]): boolean {
  const width = Math.max(...rows.map((row) => row.name.length));
  console.log(`QUEUE CHECK  ${eventId}`);
  for (const row of rows) {
    const [first, ...rest] = row.detail;
    console.log(`  ${row.pass ? "PASS" : "FAIL"}  ${row.name.padEnd(width)}  ${first ?? ""}`);
    for (const line of rest) {
      console.log(`        ${"".padEnd(width)}  ${line}`);
    }
  }
  const pass = rows.every((row) => row.pass);
  console.log("");
  console.log(`VERDICT  ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function main(): Promise<boolean> {
  const { logPath, metaPath, statePath } = locate();
  if (!existsSync(logPath)) {
    throw new Error(`no such log: ${logPath}`);
  }
  const users = readUsers(logPath);
  const meta: Meta | null = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as Meta)
    : null;
  const eventId = flags.eventId ?? meta?.eventId;
  if (!eventId) {
    throw new Error(`${metaPath} is missing: give --eventId as well`);
  }

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on("error", () => {});
  const rows: Row[] = [];
  try {
    const saved = !flags.live && existsSync(statePath);
    const state: RedisState = saved
      ? (JSON.parse(readFileSync(statePath, "utf8")) as RedisState)
      : await readRedisState(redis, eventId);
    // The clocks were compared at both ends of the run: the middle of the two, and a margin that
    // covers both readings and any drift between them.
    const start = meta?.redisClock?.atStart ?? { offsetMs: 0, uncertaintyMs: 50 };
    const end = meta?.redisClock?.atEnd ?? start;
    const facts = {
      users,
      queued: new Map(state.queued),
      admitted: new Map(state.admitted),
      clockOffsetMs: (start.offsetMs + end.offsetMs) / 2,
      clockUncertaintyMs:
        Math.max(start.uncertaintyMs, end.uncertaintyMs) +
        Math.abs(start.offsetMs - end.offsetMs) / 2,
    };
    console.log(
      `${count(users.length)} users in the log. Redis ` +
        `${saved ? "as the run ended" : "as it is NOW (no saved picture, or --live)"}: ` +
        `${count(state.queued.length)} queued, ${count(state.admitted.length)} in the admitted ` +
        `hash, state ${state.state ?? "not set"}, stock avail ${state.stock.avail} / held ` +
        `${state.stock.held} / sold ${state.stock.sold} of ${state.stock.total}.`,
    );
    console.log(
      `Redis's clock is ${Math.abs(facts.clockOffsetMs).toFixed(1)} ms ` +
        `${facts.clockOffsetMs < 0 ? "behind" : "ahead of"} the simulator's ` +
        `(+/- ${facts.clockUncertaintyMs.toFixed(1)} ms).`,
    );
    console.log("");

    rows.push(...orderRows(checkAdmissionOrder(facts)));
    rows.push(conservationRow(checkConservation(facts)));

    if (!flags.skipInvariants) {
      const report = await checkInvariants({ eventIds: [eventId] });
      for (const check of report.checks) {
        rows.push({ pass: check.pass, name: check.name, detail: [check.detail] });
      }
    }
    if (!flags.keep) {
      await unlistEvent(redis, eventId);
    }
  } finally {
    redis.disconnect();
  }
  const pass = print(eventId, rows);
  if (!flags.keep) {
    console.log(`(${eventId} is off the admitter's list now; its keys are still in Redis)`);
  }
  return pass;
}

main().then(
  (pass) => process.exit(pass ? 0 : 1),
  (error) => {
    console.error(`check failed to run: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  },
);
