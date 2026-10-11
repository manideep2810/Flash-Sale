// k6 bot flood: what the gateway does with a crowd that has no business reaching /reserve.
//
//   make bot-flood                         (normal gateway profile, seeds the event, prints a verdict)
//   pnpm -C tools exec tsx load/bot-flood.ts --totalRate 1000 --durationSec 15
//
// Run through tools/load/bot-flood.ts, which seeds the event, reads the gateway's, the ticket
// service's and Redis's counters before and after, and turns them and this script's numbers into a
// verdict. Run on its own (`k6 run loadtest/bot-flood.js`) it only prints what was answered.
//
// Six scenarios at once, each at a constant arrival rate, together TOTAL_RATE requests a second:
//
//   no_token               POST /api/reserve with nothing at all
//   session_only           a valid session, no admission token
//   forged_admission       a valid session, and an admission token signed with the wrong secret
//   expired_admission      a valid session, and an admission token that ran out a minute ago
//   other_users_admission  a valid session, and a VALID admission token that belongs to someone else
//   join_flood             POST /api/queue/:id/join, valid sessions, a new user every time, one address
//
// The first four must be stopped by the gateway and never reach the ticket service. The fifth
// passes the gateway (both tokens verify) and is refused by the service, before it touches Redis.
// The sixth is real traffic as far as any one request goes; the per-address and local limits are
// what cut it off.
//
// About request bodies. The gateway refuses the first four on their headers alone, and when it
// refuses a request whose body it has not read yet it also closes the connection ("connection:
// close"). Every such refusal then costs the client a new TCP connection, and one machine has only
// so many outgoing ports (16,384 on Windows by default): at a few hundred refusals a second the
// flood stops being a flood after twenty seconds, because k6 can no longer connect. So by default
// those four are sent WITHOUT a body. The gateway's answer is the same and the connection is kept,
// which is what lets the flood be delivered at any rate. WITH_BODY=1 sends the real reserve body on
// them too: closer to a real bot, and only deliverable in short, slow runs. The fifth always carries
// the body, because the ticket service reads the event from it; that is why its share is small.
//
// Env:
//   GATEWAY      default http://localhost:8080
//   EVENT_ID     the event to aim at (default bot-flood)
//   TOTAL_RATE   requests a second, all scenarios together (default 10000)
//   DURATION     default 60s
//   WITH_BODY    1 to send the reserve body on the four gateway-refused scenarios (see above)
//   OUT          where the numbers go as JSON (default loadtest/results/phase5/bot-flood.json)
//   SESSION_SECRET, ADMISSION_SECRET   must match the services (see loadtest/lib/tokens.js)

import http from "k6/http";
import { Counter } from "k6/metrics";
import { ADMISSION_HEADER, bearer, mintAdmissionToken, sign } from "./lib/tokens.js";

const GATEWAY = __ENV.GATEWAY || "http://localhost:8080";
const EVENT_ID = __ENV.EVENT_ID || "bot-flood";
const TOTAL_RATE = Number(__ENV.TOTAL_RATE || 10000);
const DURATION = __ENV.DURATION || "60s";
const WITH_BODY = __ENV.WITH_BODY === "1";
const OUT = __ENV.OUT || "loadtest/results/phase5/bot-flood.json";

/** Each scenario's share of TOTAL_RATE, and the function it runs. */
const SCENARIOS = {
  no_token: { share: 0.2, exec: "noToken" },
  session_only: { share: 0.2, exec: "sessionOnly" },
  forged_admission: { share: 0.2, exec: "forgedAdmission" },
  expired_admission: { share: 0.18, exec: "expiredAdmission" },
  // Always sent with a body, so each one the gateway refuses costs a connection: kept small.
  other_users_admission: { share: 0.02, exec: "otherUsersAdmission" },
  join_flood: { share: 0.2, exec: "joinFlood" },
};
const RESERVE_SCENARIOS = Object.keys(SCENARIOS).filter((name) => name !== "join_flood");
/** "unsent": k6 got no HTTP answer at all (it could not connect, or the connection dropped). */
const CLASSES = ["2xx", "401", "403", "429", "other", "unsent"];

// None of these answers is a failed request as far as k6 is concerned: they are what is being counted.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 401, 403, 429));

// One counter per scenario and kind of answer: bot_<scenario>_<class>.
const counters = {};
for (const scenario of Object.keys(SCENARIOS)) {
  counters[scenario] = {};
  for (const kind of CLASSES) {
    counters[scenario][kind] = new Counter(`bot_${scenario}_${kind}`);
  }
}

function tally(scenario, status) {
  const kind =
    status === 0
      ? "unsent"
      : status >= 200 && status < 300
        ? "2xx"
        : status === 401 || status === 403 || status === 429
          ? String(status)
          : "other";
  // Every counter gets a sample every time, so that one that stays at zero still exists to be read.
  for (const each of CLASSES) {
    counters[scenario][each].add(each === kind ? 1 : 0);
  }
}

export const options = {
  summaryTrendStats: ["med", "p(99)", "max"],
  scenarios: Object.fromEntries(
    Object.entries(SCENARIOS).map(([name, { share, exec }]) => {
      const rate = Math.max(1, Math.round(TOTAL_RATE * share));
      return [
        name,
        {
          executor: "constant-arrival-rate",
          exec,
          rate,
          timeUnit: "1s",
          duration: DURATION,
          // A refusal comes back in a millisecond or two; a few VUs carry a lot of them.
          preAllocatedVUs: Math.ceil(rate / 20) + 5,
          maxVUs: Math.max(50, rate),
        },
      ];
    }),
  ),
  // The one number that must be zero whatever else happens.
  thresholds: Object.fromEntries(
    RESERVE_SCENARIOS.map((name) => [`bot_${name}_2xx`, ["count==0"]]),
  ),
};

/** A user id nobody else in the run has: every request is a different "person". */
const userId = () => `bot-${__VU}-${__ITER}-${Date.now() % 1000000}`;

const RESERVE_BODY = JSON.stringify({ eventId: EVENT_ID, qty: 1 });

function reserve(scenario, headers, body) {
  const res = http.post(`${GATEWAY}/api/reserve`, body, {
    headers:
      body === null ? headers : Object.assign({ "Content-Type": "application/json" }, headers),
    tags: { name: scenario },
  });
  tally(scenario, res.status);
}

/** The body of a reserve the gateway refuses on its headers: none, unless WITH_BODY asks for it. */
const refusedBody = WITH_BODY ? RESERVE_BODY : null;

export function noToken() {
  reserve("no_token", {}, refusedBody);
}

export function sessionOnly() {
  reserve("session_only", { Authorization: bearer(userId()) }, refusedBody);
}

export function forgedAdmission() {
  const user = userId();
  const now = Math.floor(Date.now() / 1000);
  // Every claim is right; the signature is made with a secret that is not the services'.
  const forged = sign(
    { sub: user, eid: EVENT_ID, aud: "reserve", iss: "queue-svc", iat: now, exp: now + 120 },
    "not-the-admission-secret-0123456789abcdefghijklmn",
  );
  reserve(
    "forged_admission",
    { Authorization: bearer(user), [ADMISSION_HEADER]: forged },
    refusedBody,
  );
}

export function expiredAdmission() {
  const user = userId();
  reserve(
    "expired_admission",
    {
      Authorization: bearer(user),
      // Signed with the real secret; its turn ended a minute ago.
      [ADMISSION_HEADER]: mintAdmissionToken(user, EVENT_ID, -60),
    },
    refusedBody,
  );
}

export function otherUsersAdmission() {
  const user = userId();
  reserve(
    "other_users_admission",
    {
      Authorization: bearer(user),
      // A real, current admission token for this event, issued to somebody else.
      [ADMISSION_HEADER]: mintAdmissionToken(`victim-of-${user}`, EVENT_ID),
    },
    RESERVE_BODY,
  );
}

export function joinFlood() {
  const res = http.post(`${GATEWAY}/api/queue/${EVENT_ID}/join`, null, {
    headers: { Authorization: bearer(userId()) },
    tags: { name: "join_flood" },
  });
  tally("join_flood", res.status);
}

export function handleSummary(data) {
  const count = (name) => data.metrics[name]?.values?.count ?? 0;
  const answers = {};
  for (const scenario of Object.keys(SCENARIOS)) {
    answers[scenario] = Object.fromEntries(
      CLASSES.map((kind) => [kind, count(`bot_${scenario}_${kind}`)]),
    );
  }
  const result = {
    eventId: EVENT_ID,
    totalRate: TOTAL_RATE,
    duration: DURATION,
    withBody: WITH_BODY,
    requests: count("http_reqs"),
    requestsPerSecond: Math.round(data.metrics.http_reqs?.values?.rate ?? 0),
    droppedIterations: count("dropped_iterations"),
    latencyMs: {
      med: data.metrics.http_req_duration?.values?.med ?? 0,
      p99: data.metrics.http_req_duration?.values?.["p(99)"] ?? 0,
      max: data.metrics.http_req_duration?.values?.max ?? 0,
    },
    answers,
  };

  const pad = (text, width) => String(text).padEnd(width);
  const num = (n) => String(n).padStart(9);
  const heading = { unsent: "no answer" };
  const lines = [
    "",
    `BOT FLOOD  ${EVENT_ID}  ${result.requests} requests in ${DURATION} ` +
      `(${result.requestsPerSecond}/s; asked for ${TOTAL_RATE}/s, ${result.droppedIterations} not started)`,
    `  ${pad("scenario", 24)}${CLASSES.map((kind) => (heading[kind] || kind).padStart(11)).join("")}`,
    ...Object.keys(SCENARIOS).map(
      (scenario) =>
        `  ${pad(scenario, 24)}${CLASSES.map((kind) => `  ${num(answers[scenario][kind])}`).join("")}`,
    ),
    `  latency: median ${result.latencyMs.med.toFixed(1)} ms, p99 ${result.latencyMs.p99.toFixed(1)} ms`,
    "",
  ];
  return {
    stdout: lines.join("\n"),
    [OUT]: JSON.stringify(result, null, 2),
  };
}
