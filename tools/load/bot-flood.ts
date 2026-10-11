// The bot flood, start to verdict: seeds an event, reads the counters that matter, runs the k6
// script (loadtest/bot-flood.js) against the gateway on its NORMAL limits, reads the counters again
// and says what the flood got.
//
//   make bot-flood                                                   (10,000 req/s for 60s)
//   pnpm -C tools exec tsx load/bot-flood.ts --totalRate 1000 --durationSec 15
//
// What it reads, before and after:
//   the gateway      envoy_gateway_requests{route, code, reason} from Envoy's admin port: what each
//                    request on a route was answered with, and by whom (reason "via_upstream" is a
//                    service; anything else is Envoy itself)
//   the ticket API   admission_accepted_total and admission_rejected_total{reason} from its /metrics:
//                    every reserve that got as far as the service
//   Redis            the event's stock, its holds and its stream: what a reserve would have changed
//
// What must hold, and is checked:
//   1. no reserve got a 2xx
//   2. every reserve that was answered got 401, 403 or 429
//   3. the four scenarios with no usable admission token never reached the ticket service; the only
//      reserves it saw were the "somebody else's token" ones, which it refused
//   4. Redis holds exactly what it held before: no hold, no stock moved, nothing on the stream
//   5. the join flood was cut off: 429s, and no more joins let through than the per-address limit
//      allows for the minutes the run touched
//   6. the flood was delivered: k6 got an answer to (all but a thousandth of) what it sent. When it
//      did not, the run proves nothing about the gateway, whatever the other five say. The usual
//      cause is this machine running out of outgoing ports: see the note on bodies in
//      loadtest/bot-flood.js, and --withBody below.
//
// --withBody sends the real reserve body on the four scenarios the gateway refuses. The gateway
// then closes the connection after each refusal, so every one costs a new outgoing port; before
// such a run this prints how long the machine's ports will last.
//
// Exits 0 when all six hold, 1 otherwise.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { TEST_ADMISSION_SECRET, TEST_SESSION_SECRET } from "../tokens.js";
import { readRedisState } from "./lib/redis-state.js";
import { keysOf, seedStock, seedWaitingRoom, unlistEvent } from "./lib/seed.js";

const { values: flags } = parseArgs({
  options: {
    eventId: { type: "string" },
    totalRate: { type: "string", default: "10000" },
    durationSec: { type: "string", default: "60" },
    stock: { type: "string", default: "1000" },
    gateway: { type: "string", default: "http://localhost:8080" },
    envoyAdmin: { type: "string", default: "http://127.0.0.1:9901" },
    ticketUrl: { type: "string", default: "http://localhost:3001" },
    ticketMetrics: { type: "string", default: "http://localhost:9464/metrics" },
    redisUrl: { type: "string", default: process.env.REDIS_URL ?? "redis://localhost:6380" },
    anyProfile: { type: "boolean", default: false },
    withBody: { type: "boolean", default: false },
  },
});

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EVENT_ID = flags.eventId ?? `bot-flood-${Date.now().toString(36)}`;
const TOTAL_RATE = Number(flags.totalRate);
const DURATION_SEC = Number(flags.durationSec);
const OUT = join(ROOT, "loadtest/results/phase5", `${EVENT_ID}.json`);
/** The normal profile's limit on joins from one address (infra/ratelimit/config/flashsale.yaml). */
const JOINS_PER_ADDRESS_PER_MINUTE = 600;
const RESERVE_SCENARIOS = [
  "no_token",
  "session_only",
  "forged_admission",
  "expired_admission",
  "other_users_admission",
];
/** The ticket service's reasons for a reserve that carried no usable admission token. */
const TOKENLESS_REASONS = ["ADMISSION_REQUIRED", "TOKEN_INVALID", "TOKEN_EXPIRED"];

type Labels = Record<string, string>;
interface Sample {
  labels: Labels;
  value: number;
}

/** The samples of one metric in a Prometheus text page. */
function samplesOf(text: string, metric: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(metric) || line.startsWith("#")) {
      continue;
    }
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!match || match[1] !== metric) {
      continue;
    }
    const labels: Labels = {};
    for (const pair of (match[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[String(pair[1])] = String(pair[2]);
    }
    samples.push({ labels, value: Number(match[3]) });
  }
  return samples;
}

const total = (samples: Sample[], where: (labels: Labels) => boolean = () => true): number =>
  samples.filter((sample) => where(sample.labels)).reduce((sum, sample) => sum + sample.value, 0);

async function page(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`${url} answered ${res.status}`);
  }
  return res.text();
}

interface Snapshot {
  gateway: Sample[];
  /** Requests the gateway let through although the rate-limit service did not answer in time. */
  failedOpen: number;
  accepted: number;
  rejected: Sample[];
  stock: { avail: number | null; held: number; sold: number; holds: number };
  stream: number;
  queued: number;
}

async function snapshot(redis: Redis): Promise<Snapshot> {
  const [envoy, ticket, state, stream] = await Promise.all([
    page(`${flags.envoyAdmin}/stats/prometheus`),
    page(String(flags.ticketMetrics)),
    readRedisState(redis, EVENT_ID),
    redis.xlen(keysOf(EVENT_ID).stream),
  ]);
  return {
    gateway: samplesOf(envoy, "envoy_gateway_requests"),
    failedOpen: total(samplesOf(envoy, "envoy_cluster_ratelimit_failure_mode_allowed")),
    accepted: total(samplesOf(ticket, "admission_accepted_total")),
    rejected: samplesOf(ticket, "admission_rejected_total"),
    stock: state.stock,
    stream,
    queued: state.queued.length,
  };
}

/** Which rate-limit config the ratelimit container has mounted: "config" is the normal profile. */
function gatewayProfile(): string | null {
  const project = process.env.COMPOSE_PROJECT_NAME ?? "flash-sale";
  const inspected = spawnSync(
    "docker",
    ["inspect", "-f", "{{range .Mounts}}{{.Source}}{{end}}", `${project}-ratelimit-1`],
    { encoding: "utf8" },
  );
  if (inspected.status !== 0) {
    return null;
  }
  return inspected.stdout.trim().replaceAll("\\", "/").split("/").at(-1) ?? null;
}

function runK6(): Promise<number> {
  return new Promise((resolve, reject) => {
    const k6 = spawn("k6", ["run", "--quiet", "loadtest/bot-flood.js"], {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        GATEWAY: String(flags.gateway),
        EVENT_ID,
        TOTAL_RATE: String(TOTAL_RATE),
        DURATION: `${DURATION_SEC}s`,
        OUT: `loadtest/results/phase5/${EVENT_ID}.json`,
        SESSION_SECRET: TEST_SESSION_SECRET,
        ADMISSION_SECRET: TEST_ADMISSION_SECRET,
        ...(flags.withBody ? { WITH_BODY: "1" } : {}),
      },
    });
    k6.on("error", (error) => reject(new Error(`could not start k6: ${error.message}`)));
    k6.on("exit", (code) => resolve(code ?? 1));
  });
}

interface Check {
  pass: boolean;
  name: string;
  detail: string;
}

/** The share of requests that may go unanswered (a dropped connection) in a run that still counts. */
const UNSENT_TOLERANCE = 0.001;
/** Each scenario's share of the total rate, as in loadtest/bot-flood.js. */
const GATEWAY_REFUSED_SHARE = 0.78;
const STOLEN_TOKEN_SHARE = 0.02;

/** How many outgoing ports this machine hands out, where that can be asked (Windows). */
function outgoingPorts(): number | null {
  if (process.platform !== "win32") {
    return null;
  }
  const shown = spawnSync("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], {
    encoding: "utf8",
  });
  const ports = /Number of Ports\s*:\s*(\d+)/.exec(shown.stdout ?? "");
  return ports ? Number(ports[1]) : null;
}

/**
 * The gateway closes the connection after refusing a request whose body it has not read, so each
 * such refusal uses up one outgoing port for a couple of minutes. Says so before a run that will
 * use more of them than the machine has.
 */
function warnAboutPorts(): void {
  const ports = outgoingPorts();
  if (ports === null) {
    return;
  }
  const withBodyPerSec =
    TOTAL_RATE * (STOLEN_TOKEN_SHARE + (flags.withBody ? GATEWAY_REFUSED_SHARE : 0));
  const needed = Math.round(withBodyPerSec * DURATION_SEC);
  if (needed > ports * 0.8) {
    console.log(
      `WARNING: up to ${needed} of these requests carry a body, and each one the gateway refuses ` +
        `costs a new connection. This machine has ${ports} outgoing ports, which is about ` +
        `${Math.floor(ports / withBodyPerSec)}s of this run. Expect "no answer" after that` +
        `${flags.withBody ? ": drop --withBody, or shorten the run" : ": shorten the run or lower the rate"}.`,
    );
  }
}

async function main(): Promise<boolean> {
  const profile = gatewayProfile();
  if (profile !== null && profile !== "config" && !flags.anyProfile) {
    throw new Error(
      `the gateway is on the "${profile}" rate-limit config, not the normal one. The bot flood is ` +
        "about the REAL limits: run `make normal-profile` first (or pass --anyProfile).",
    );
  }
  mkdirSync(join(ROOT, "loadtest/results/phase5"), { recursive: true });

  const redis = new Redis(String(flags.redisUrl), { maxRetriesPerRequest: 3 });
  redis.on("error", () => {});
  try {
    // An event a reserve could really succeed on: stock on sale, the sale open, nobody holding any.
    await seedStock(String(flags.ticketUrl), EVENT_ID, Number(flags.stock));
    const now = Date.now();
    await seedWaitingRoom(redis, {
      eventId: EVENT_ID,
      lobbyOpensAt: now - 60_000,
      saleOpensAt: now - 60_000,
      admitRatePerSec: 50,
      admitTtlSec: 120,
      name: "Bot flood",
      price: 1_999,
    });
    console.log(
      `event ${EVENT_ID}: ${flags.stock} tickets on sale, sale open. Gateway profile: ` +
        `${profile === null ? "unknown (docker inspect failed)" : profile === "config" ? "normal" : profile}.`,
    );

    warnAboutPorts();
    const before = await snapshot(redis);
    const startedAt = Date.now();
    const k6Exit = await runK6();
    const endedAt = Date.now();
    // Envoy counts a request when its access log entry is written, a moment after the response.
    await sleep(2_000);
    const after = await snapshot(redis);
    if (!existsSync(OUT)) {
      throw new Error(`k6 wrote no results (${OUT}); it exited with ${k6Exit}`);
    }
    const k6 = JSON.parse(readFileSync(OUT, "utf8")) as {
      answers: Record<string, Record<string, number>>;
    };

    const gatewayDelta = (where: (labels: Labels) => boolean) =>
      total(after.gateway, where) - total(before.gateway, where);
    const rejectedDelta = (reasons: string[]) =>
      total(after.rejected, (labels) => reasons.includes(String(labels.reason))) -
      total(before.rejected, (labels) => reasons.includes(String(labels.reason)));
    const sumOf = (scenarios: string[], kind: string) =>
      scenarios.reduce((sum, scenario) => sum + (k6.answers[scenario]?.[kind] ?? 0), 0);

    const reserve2xx = sumOf(RESERVE_SCENARIOS, "2xx");
    const reserve2xxAtGateway = gatewayDelta(
      (labels) => labels.route === "reserve" && String(labels.code).startsWith("2"),
    );
    const reserveOther = sumOf(RESERVE_SCENARIOS, "other");
    const allScenarios = Object.keys(k6.answers);
    const unsent = sumOf(allScenarios, "unsent");
    const attempted = allScenarios.reduce(
      (sum, scenario) =>
        sum + Object.values(k6.answers[scenario] ?? {}).reduce((each, n) => each + n, 0),
      0,
    );
    const forwarded = gatewayDelta(
      (labels) => labels.route === "reserve" && labels.reason === "via_upstream",
    );
    const tokenless = rejectedDelta(TOKENLESS_REASONS);
    const mismatched = rejectedDelta(["TOKEN_MISMATCH"]);
    const accepted = after.accepted - before.accepted;
    const joins = k6.answers.join_flood ?? {};
    const joinLocal429 = gatewayDelta(
      (labels) =>
        labels.route === "join" && labels.code === "429" && labels.reason === "local_rate_limited",
    );
    const joinGlobal429 = gatewayDelta(
      (labels) =>
        labels.route === "join" &&
        labels.code === "429" &&
        labels.reason === "request_rate_limited",
    );
    // The per-address limit counts in calendar minutes, so a run can use up one allowance per
    // minute it touches.
    const minutesTouched = Math.floor(endedAt / 60_000) - Math.floor(startedAt / 60_000) + 1;
    const joinsAllowed = JOINS_PER_ADDRESS_PER_MINUTE * minutesTouched;
    const failedOpen = after.failedOpen - before.failedOpen;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    const checks: Check[] = [
      {
        pass: reserve2xx === 0 && reserve2xxAtGateway === 0,
        name: "No reserve succeeded",
        detail: `2xx on /api/reserve: ${reserve2xx} seen by k6, ${reserve2xxAtGateway} by the gateway (expected 0)`,
      },
      {
        pass: reserveOther === 0,
        name: "Every answered reserve got 401, 403 or 429",
        detail:
          `401 ${sumOf(RESERVE_SCENARIOS, "401")}, 403 ${sumOf(RESERVE_SCENARIOS, "403")}, ` +
          `429 ${sumOf(RESERVE_SCENARIOS, "429")}, any other answer ${reserveOther} (expected 0)`,
      },
      {
        pass: tokenless === 0 && accepted === 0 && forwarded === mismatched,
        name: "Tokenless reserves never reached the ticket service",
        detail:
          `the gateway forwarded ${forwarded} reserves; the ticket service refused ${mismatched} as ` +
          `somebody else's token, ${tokenless} for a missing, forged or expired token (expected 0), ` +
          `and accepted ${accepted} (expected 0)`,
      },
      {
        pass: same(before.stock, after.stock) && before.stream === after.stream,
        name: "Redis is as it was",
        detail:
          `avail ${before.stock.avail} -> ${after.stock.avail}, held ${before.stock.held} -> ` +
          `${after.stock.held}, holds ${before.stock.holds} -> ${after.stock.holds}, stream ` +
          `${before.stream} -> ${after.stream} entries`,
      },
      {
        pass: (joins["429"] ?? 0) > 0 && (joins["2xx"] ?? 0) <= joinsAllowed,
        name: "The join flood was cut off",
        detail:
          `${joins["2xx"] ?? 0} joins let through (the per-address limit allows ${joinsAllowed} ` +
          `over the ${minutesTouched} minute(s) the run touched), ${joins["429"] ?? 0} refused with ` +
          `429: ${joinLocal429} by the local bucket, ${joinGlobal429} by the per-address limit` +
          `${(joins.other ?? 0) > 0 ? `; ${joins.other} got another answer` : ""}` +
          `${failedOpen > 0 ? `; ${failedOpen} requests were let through unchecked because the rate-limit service did not answer in 50 ms (it fails open)` : ""}`,
      },
    ];

    checks.push({
      pass: unsent <= attempted * UNSENT_TOLERANCE,
      name: "The flood was delivered",
      detail:
        `${unsent} of ${attempted} requests got no answer at all (allowed: 1 in 1,000)` +
        (unsent > attempted * UNSENT_TOLERANCE
          ? ". k6 could not send them, so this run shows less than it claims. If the lines above " +
            'say "Only one usage of each socket address", this machine ran out of outgoing ' +
            "ports: run without --withBody, or shorter, or slower"
          : ""),
    });

    const width = Math.max(...checks.map((check) => check.name.length));
    console.log(`BOT FLOOD VERDICT  ${EVENT_ID}`);
    for (const check of checks) {
      console.log(
        `  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`,
      );
    }
    const pass = checks.every((check) => check.pass);
    console.log("");
    console.log(
      `VERDICT  ${pass ? "PASS" : "FAIL"}   (${after.queued} users from the join flood are in the ` +
        "event's queue; the event is off the admitter's list now)",
    );
    return pass;
  } finally {
    await unlistEvent(redis, EVENT_ID).catch(() => {});
    redis.disconnect();
  }
}

main().then(
  (pass) => process.exit(pass ? 0 : 1),
  (error) => {
    console.error(`bot flood failed to run: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  },
);
