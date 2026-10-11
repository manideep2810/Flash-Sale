// The API gateway, end to end. Every request here goes through Envoy on :8080 unless the test is
// about going around it.
//
//   pnpm -C tests/e2e run test:phase5        (or: make test-phase5)
//
// What it starts, and puts back:
//   - the gateway's three containers, recreated with the TEST limits (infra/docker/docker-compose.test.yml:
//     infra/envoy/limits.test.env and infra/ratelimit/config-test/). afterAll recreates them with the
//     normal limits; if the run is cut short, `make up` does the same.
//   - every service as a child process on its usual port (stop `make dev` first): the Phase 4 stack
//     (ticket, relay, order-api, order-worker, payment) plus queue-svc and the admitter.
// Needs the local stack up (`make up`): Redis, Postgres, Redpanda, Prometheus.
//
// Each test starts with empty rate-limit counters (redis-ratelimit is flushed), so no test depends
// on what another one sent. The numbers below are the test limits:
//   global   join: 3/min per user, 8/min per address    status: 10/min per user
//            reserve: 3/s per user                       everything else out of reach
//   local    login: a bucket of 5, refilled every 5s     everything else out of reach

import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ADMISSION_HEADER,
  bearer,
  mintAdmissionToken,
  TEST_SESSION_SECRET,
} from "../../../tools/tokens.js";
import { Harness } from "../phase4/support.js";
import {
  call,
  ENVOY_ADMIN,
  forgetSale,
  GATEWAY,
  GATEWAY_CONTAINERS,
  type HttpResult,
  clustersHealthy as healthy,
  ORDER_API,
  openWaitingRoom,
  QUEUE,
  queueProcs,
  compose as stack,
  TICKET,
  waitFor,
} from "./support.js";

const PROMETHEUS = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
const TICKET_METRICS = "http://localhost:9464/metrics";

// ---- docker compose -----------------------------------------------------------------------------

/** `docker compose ...` on the local stack, with the gateway's TEST limits unless told otherwise. */
const compose = (args: string[], { testLimits = true } = {}) => stack(args, { testLimits });

/** Empties the rate limiter's counters: every user and address starts a fresh window. */
const resetLimits = () => compose(["exec", "-T", "redis-ratelimit", "redis-cli", "flushall"]);

// ---- Envoy, from the outside ----------------------------------------------------------------------

interface AccessLine {
  path: string;
  route: string | null;
  status: number;
  flags: string;
  details: string;
  user: string | null;
}

/** The access-log lines whose path contains `marker`. */
async function accessLog(marker: string): Promise<AccessLine[]> {
  const out = await compose(["logs", "--no-log-prefix", "--tail", "2000", "envoy"]);
  return out
    .split("\n")
    .filter((line) => line.startsWith("{") && line.includes(marker))
    .map((line) => JSON.parse(line) as AccessLine);
}

/** How many requests Envoy has sent to a cluster. Health checks are not requests and do not count. */
async function forwardedTo(cluster: string): Promise<number> {
  const filter = encodeURIComponent(`^cluster\\.${cluster}\\.upstream_rq_total$`);
  const res = await fetch(`${ENVOY_ADMIN}/stats?format=json&filter=${filter}`);
  const { stats } = (await res.json()) as { stats: { name: string; value: number }[] };
  return stats[0]?.value ?? 0;
}

const clustersHealthy = () => healthy(["order-api", "ticket", "queue-svc", "ratelimit"]);

/**
 * True when Envoy answered by itself. A response that came from a service carries the time the
 * service took (x-envoy-upstream-service-time); one Envoy made up does not.
 */
const answeredByEnvoy = (res: HttpResult) =>
  res.headers.get("server") === "envoy" &&
  res.headers.get("x-envoy-upstream-service-time") === null;

interface Caller {
  /** Sends this user's session. */
  as?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One request through the gateway. */
async function gw(
  method: "GET" | "POST",
  path: string,
  { as, headers = {}, body }: Caller = {},
): Promise<HttpResult> {
  const session: Record<string, string> =
    as === undefined ? {} : { authorization: await bearer(as) };
  return call(method, `${GATEWAY}${path}`, { ...session, ...headers }, body);
}

// ---- tokens a real login would never issue ---------------------------------------------------------

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function forgeSession({
  aud = "session",
  iss = "order-api",
  expIn = 3600,
  alg = "HS256" as "HS256" | "none",
  secret = TEST_SESSION_SECRET,
} = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url({ alg, typ: "JWT" })}.${b64url({ sub: "alice", aud, iss, iat: now, exp: now + expIn })}`;
  return alg === "none"
    ? `${input}.`
    : `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

// ---- the suite ---------------------------------------------------------------------------------------

describe("the gateway", () => {
  const h = new Harness({ ticketWorkers: "1" });
  const queue = queueProcs();
  const runId = randomUUID().slice(0, 8);
  /** A user id nobody else has used, so counters and queues from other runs cannot matter. */
  const user = (name: string) => `${name}-${runId}`;
  const sales: string[] = [];
  /** A sale with plenty of stock and an open waiting room, shared by most tests. */
  let sale: string;

  const statusPath = () => `/api/queue/${sale}/status`;
  const joinPath = () => `/api/queue/${sale}/join`;

  async function saleWithWaitingRoom(total: number, label: string): Promise<string> {
    const eventId = await h.createSale(total, label);
    await openWaitingRoom(h.redis, eventId);
    sales.push(eventId);
    return eventId;
  }

  /** Logs in through the gateway. The login route's local bucket is small under test, so it waits its turn. */
  async function login(userId: string): Promise<string> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const res = await gw("POST", "/api/auth/dev-login", { body: { userId } });
      if (res.status === 200) {
        return String(res.body.token);
      }
      expect(res.status, "login through the gateway").toBe(429);
      await sleep(1_000);
    }
    throw new Error("login was rate limited for 15 seconds");
  }

  /** A reserve for `userId`, logged in and admitted to `eventId` (tokens minted by the test). */
  async function reserve(userId: string, eventId: string): Promise<HttpResult> {
    return gw("POST", "/api/reserve", {
      as: userId,
      headers: { [ADMISSION_HEADER]: await mintAdmissionToken({ userId, eventId }) },
      body: { eventId, qty: 1 },
    });
  }

  /**
   * The per-minute limits count in windows that turn over on the minute, by the rate limiter's
   * clock. A test that counts requests against one must not straddle that turn, so this waits it
   * out when it is a few seconds away. The probe is a status call by a user of its own.
   */
  async function clearOfWindowEdge(): Promise<void> {
    const probe = await gw("GET", statusPath(), { as: user(`probe-${randomUUID().slice(0, 6)}`) });
    const secondsLeft = Number(probe.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(secondsLeft) && secondsLeft < 5) {
      await sleep((secondsLeft + 1) * 1_000);
    }
  }

  beforeAll(async () => {
    await compose(["up", "-d", "--wait", ...GATEWAY_CONTAINERS]);
    try {
      await h.startAll();
      await Promise.all(queue.map((proc) => proc.start()));
    } catch (error) {
      await Promise.all(queue.map((proc) => proc.kill()));
      await h.stopAll();
      throw error;
    }
    // Envoy health-checks each service every 5s and routes to it once it has passed.
    await waitFor("Envoy to see every service healthy", 60_000, clustersHealthy, 500);
    // Whatever an earlier run left in flight finishes first, as in the Phase 4 suites.
    await h.waitQuiet(120_000).catch(() => {});
    await h.resetTables();
    sale = await saleWithWaitingRoom(200, "gateway");
  }, 400_000);

  afterAll(async () => {
    await Promise.all(queue.map((proc) => proc.kill()));
    for (const eventId of sales) {
      await forgetSale(h.redis, eventId);
    }
    await h.stopAll();
    // Back to the normal limits.
    await compose(["up", "-d", "--wait", ...GATEWAY_CONTAINERS], { testLimits: false }).catch(
      (error) => {
        console.warn(
          `could not restore the gateway's normal limits (${(error as Error).message}); run \`make up\``,
        );
      },
    );
  }, 240_000);

  beforeEach(async () => {
    await resetLimits();
  });

  it("1. answers 401 itself without a session; queue-svc is never called", async () => {
    const before = await forwardedTo("queue-svc");

    for (const [method, path] of [
      ["POST", joinPath()],
      ["GET", statusPath()],
    ] as const) {
      const res = await gw(method, path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: "UNAUTHENTICATED", message: expect.stringMatching(/^Jwt/) });
      expect(answeredByEnvoy(res)).toBe(true);
    }

    expect(await forwardedTo("queue-svc")).toBe(before);
  });

  it("2. logs in, then joins and reads status with the session", async () => {
    const userId = user("carol");
    const before = await forwardedTo("queue-svc");
    const token = await login(userId);
    const session = { headers: { authorization: `Bearer ${token}` } };

    const joined = await gw("POST", joinPath(), session);
    expect(joined.status).toBe(200);
    expect(["QUEUED", "ADMITTED"]).toContain(joined.body.status);
    expect(answeredByEnvoy(joined)).toBe(false);

    const status = await gw("GET", statusPath(), session);
    expect(status.status).toBe(200);
    expect(["QUEUED", "ADMITTED"]).toContain(status.body.status);

    expect(await forwardedTo("queue-svc")).toBe(before + 2);
    // The login is who queue-svc saw.
    const [queued, admitted] = await Promise.all([
      h.redis.zscore(`ev:${sale}:queue`, userId),
      h.redis.hexists(`ev:${sale}:admitted`, userId),
    ]);
    expect(queued !== null || admitted === 1).toBe(true);
  });

  it("3. answers 401 itself for a reserve with no admission token; the ticket service is never called", async () => {
    const rejectedByTicket = async () => {
      const text = await (await fetch(TICKET_METRICS)).text();
      return text.split("\n").filter((line) => line.startsWith("admission_"));
    };
    const forwarded = await forwardedTo("ticket");
    const counters = await rejectedByTicket();

    const res = await gw("POST", "/api/reserve", {
      as: user("dan"),
      body: { eventId: sale, qty: 1 },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: "UNAUTHENTICATED", message: expect.stringMatching(/^Jwt/) });
    expect(answeredByEnvoy(res)).toBe(true);

    // Envoy sent it nothing, and its own admission counters say the same.
    expect(await forwardedTo("ticket")).toBe(forwarded);
    expect(await rejectedByTicket()).toEqual(counters);
  });

  it("4. refuses a forged, expired or wrong-audience session, and an admission token used as one", async () => {
    const before = await forwardedTo("queue-svc");
    const notSessions = {
      "signed with another secret": forgeSession({
        secret: "another-secret-another-secret-another-secret",
      }),
      expired: forgeSession({ expIn: -3600 }),
      "for another audience": forgeSession({ aud: "reserve" }),
      "from another issuer": forgeSession({ iss: "queue-svc" }),
      "unsigned (alg none)": forgeSession({ alg: "none" }),
      "an admission token": await mintAdmissionToken({ userId: "alice", eventId: sale }),
    };

    for (const [what, token] of Object.entries(notSessions)) {
      const res = await gw("GET", statusPath(), { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, what).toBe(401);
      expect(res.body.code, what).toBe("UNAUTHENTICATED");
      expect(answeredByEnvoy(res), what).toBe(true);
    }
    expect(await forwardedTo("queue-svc")).toBe(before);
  });

  it("5. counts and identifies a caller by their session, whatever x-user-id they send", async () => {
    await clearOfWindowEdge();
    const alice = user("alice5");
    const bob = user("bob5");
    const aliceClaimingBob: Caller = { as: alice, headers: { "x-user-id": bob } };

    // The rate limiter counts alice: she uses up her own 10 a minute...
    for (let i = 0; i < 10; i++) {
      expect((await gw("GET", statusPath(), aliceClaimingBob)).status).toBe(200);
    }
    expect((await gw("GET", statusPath(), aliceClaimingBob)).status).toBe(429);
    // ...and none of bob's: his first request finds his whole allowance there.
    const bobs = await gw("GET", statusPath(), { as: bob });
    expect(bobs.status).toBe(200);
    expect(bobs.headers.get("x-ratelimit-remaining")).toBe("9");

    // The service sees alice: it is alice who is in the queue (or already admitted), not bob.
    expect((await gw("POST", joinPath(), aliceClaimingBob)).status).toBe(200);
    const place = async (userId: string) => {
      const [queued, admitted] = await Promise.all([
        h.redis.zscore(`ev:${sale}:queue`, userId),
        h.redis.hexists(`ev:${sale}:admitted`, userId),
      ]);
      return queued !== null || admitted === 1;
    };
    expect(await place(alice)).toBe(true);
    expect(await place(bob)).toBe(false);

    // And Envoy's own log names her.
    let lines: AccessLine[] = [];
    await waitFor(
      "the access log",
      15_000,
      async () => {
        lines = (await accessLog(joinPath())).filter((line) => line.user === alice);
        return lines.length > 0;
      },
      500,
    );
    expect((await accessLog(joinPath())).some((line) => line.user === bob)).toBe(false);
  });

  it("6. limits one user's reserves and leaves another user alone", async () => {
    const alice = user("alice6");
    const bob = user("bob6");

    // 12 at once from alice against 3 a second, with 2 from bob in the same instant. Even if the
    // burst straddles two one-second windows, at most 6 of hers can pass.
    const results = await Promise.all(
      [...Array<string>(12).fill(alice), bob, bob].map((userId) => reserve(userId, sale)),
    );
    const alices = results.slice(0, 12);
    const refused = alices.filter((res) => res.status === 429);
    const reserved = alices.filter((res) => res.status === 201);

    expect(refused.length + reserved.length).toBe(12);
    expect(reserved.length).toBeGreaterThanOrEqual(3);
    expect(reserved.length).toBeLessThanOrEqual(6);
    for (const res of refused) {
      expect(res.body).toEqual({ code: "RATE_LIMITED", message: expect.any(String) });
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(answeredByEnvoy(res)).toBe(true);
    }

    expect(results.slice(12).map((res) => res.status)).toEqual([201, 201]);
  });

  it("7. limits status per minute, and allows it again in the next window", async () => {
    await clearOfWindowEdge();
    const erin = user("erin7");

    for (let i = 0; i < 10; i++) {
      expect((await gw("GET", statusPath(), { as: erin })).status).toBe(200);
    }
    const over = await gw("GET", statusPath(), { as: erin });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("RATE_LIMITED");
    expect(over.headers.get("x-ratelimit-remaining")).toBe("0");

    // Retry-After is the time left in the window, and it is the truth: after it, she is let in.
    const retryAfter = Number(over.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    await sleep((retryAfter + 1) * 1_000);

    expect((await gw("GET", statusPath(), { as: erin })).status).toBe(200);
  }, 120_000);

  it("8. counts each user separately, and the address across all of them", async () => {
    await clearOfWindowEdge();
    const alice = user("alice8");
    const bob = user("bob8");
    const carol = user("carol8");
    const dave = user("dave8");
    const join = (userId: string) => gw("POST", joinPath(), { as: userId });
    const statuses = async (userId: string, times: number) => {
      const seen: number[] = [];
      for (let i = 0; i < times; i++) {
        seen.push((await join(userId)).status);
      }
      return seen;
    };

    // 3 a minute per user: alice's fourth is refused, on her own count.
    expect(await statuses(alice, 3)).toEqual([200, 200, 200]);
    const alicesFourth = await join(alice);
    expect(alicesFourth.status).toBe(429);
    expect(alicesFourth.headers.get("x-ratelimit-limit")).toMatch(/^3,/);

    // Bob, from the same address, has all three of his own.
    expect(await statuses(bob, 3)).toEqual([200, 200, 200]);

    // 8 a minute for the address: those were 7, carol's is the eighth, and dave's first ever
    // request is refused. It is the address's limit that refused him, not his.
    expect((await join(carol)).status).toBe(200);
    const daves = await join(dave);
    expect(daves.status).toBe(429);
    expect(daves.headers.get("x-ratelimit-limit")).toMatch(/^8,/);
  });

  it("9. refuses a burst over the local bucket, and logs it as the local limit", async () => {
    // A full bucket to start from: 5 tokens, refilled every 5 seconds.
    await sleep(5_500);
    const marker = `burst=${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call("POST", `${GATEWAY}/api/auth/dev-login?${marker}`, {}, { userId: user("burst") }),
      ),
    );
    const passed = results.filter((res) => res.status === 200);
    const refused = results.filter((res) => res.status === 429);

    // 5, or 10 if a refill landed in the middle of the burst. Never all 20.
    expect(passed.length + refused.length).toBe(20);
    expect(passed.length).toBeGreaterThanOrEqual(5);
    expect(passed.length).toBeLessThanOrEqual(10);
    for (const res of refused) {
      expect(res.body).toEqual({ code: "RATE_LIMITED", message: expect.any(String) });
      expect(res.headers.get("retry-after")).toBe("1");
      // The local limit does not involve the ratelimit service, so there is no window to report.
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
      expect(answeredByEnvoy(res)).toBe(true);
    }

    let lines: AccessLine[] = [];
    await waitFor(
      "the access log",
      15_000,
      async () => {
        lines = await accessLog(marker);
        return lines.length >= 20;
      },
      500,
    );
    const refusedLines = lines.filter((line) => line.status === 429);
    expect(refusedLines).toHaveLength(refused.length);
    for (const line of refusedLines) {
      expect(line).toMatchObject({ route: "login", flags: "RL", details: "local_rate_limited" });
    }

    // Leave a full bucket for whoever logs in next.
    await sleep(5_500);
  });

  it("10. keeps serving when the ratelimit service is down, and keeps checking tokens", async () => {
    const frank = user("frank10");
    await compose(["stop", "ratelimit"]);
    try {
      // Far past his 10 a minute, and nothing is refused: the limit fails open.
      for (let i = 0; i < 15; i++) {
        const res = await gw("GET", statusPath(), { as: frank });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-ratelimit-limit")).toBeNull();
      }
      // The JWT check does not go through that service, and does not fail open.
      expect((await gw("GET", statusPath())).status).toBe(401);
      const noAdmission = await gw("POST", "/api/reserve", {
        as: frank,
        body: { eventId: sale, qty: 1 },
      });
      expect(noAdmission.status).toBe(401);
    } finally {
      await compose(["start", "ratelimit"]);
      // Envoy takes a health check or two to start asking it again.
      await waitFor(
        "rate limiting to come back",
        60_000,
        async () => {
          const probe = await gw("GET", statusPath(), {
            as: user(`probe-${randomUUID().slice(0, 6)}`),
          });
          return probe.headers.get("x-ratelimit-limit") !== null;
        },
        500,
      );
    }
  }, 120_000);

  it("11. is not the only check: each service refuses a direct call without a session", async () => {
    const direct = [
      ["GET", `${QUEUE}/queue/${sale}/status`],
      ["POST", `${QUEUE}/queue/${sale}/join`],
      ["POST", `${TICKET}/redis/reserve`],
      ["GET", `${ORDER_API}/orders/some-order`],
      ["POST", `${ORDER_API}/orders/some-order/pay`],
    ] as const;

    for (const [method, url] of direct) {
      // The header the gateway sets for its rate limiter is not an identity to a service.
      const res = await call(
        method,
        url,
        { "x-user-id": "alice" },
        method === "POST" ? { eventId: sale, qty: 1 } : undefined,
      );
      expect(res.status, url).toBe(401);
      expect(res.body.code, url).toBe("UNAUTHENTICATED");
      // Answered by the service: these did not pass through Envoy, and the words are the service's.
      expect(res.headers.get("server"), url).not.toBe("envoy");
      expect(res.body.message, url).not.toMatch(/^Jwt/);
    }
  });

  // The services are host processes started by `make dev`, each on its own port, so they ARE
  // reachable from the host: there is no container boundary to test. Test 11 is the defence that
  // exists: a direct call gets nowhere without a session. This case applies once they run in containers.
  it.skip("12. services are reachable from the host only through :8080 (does not apply: they run on the host)", () => {});

  it("13. takes a user from login to a paid order, through the gateway only", async () => {
    const eventId = await saleWithWaitingRoom(5, "journey");
    // The mock payment service approves users whose id starts with "ok-" (NODE_ENV=test).
    const userId = `ok-${user("gw")}`;
    const session = { headers: { authorization: `Bearer ${await login(userId)}` } };

    const joined = await gw("POST", `/api/queue/${eventId}/join`, session);
    expect(joined.status).toBe(200);

    // Poll as a client would, well inside the 10 a minute it is allowed.
    let admission: string | undefined;
    await waitFor(
      "the admitter to let the user in",
      8_000,
      async () => {
        const { body } = await gw("GET", `/api/queue/${eventId}/status`, session);
        admission = body.token;
        return body.status === "ADMITTED";
      },
      1_000,
    );

    const reserved = await gw("POST", "/api/reserve", {
      headers: { ...session.headers, [ADMISSION_HEADER]: String(admission) },
      body: { eventId, qty: 1 },
    });
    expect(reserved.status).toBe(201);
    const orderId = String(reserved.body.holdId);
    expect(orderId).toContain(`${eventId}:${userId}:`);

    // The order is created asynchronously (relay -> Kafka -> order worker).
    await waitFor("the order to be created", 30_000, async () => {
      return (await h.order(orderId)) !== undefined;
    });
    const orderPath = `/api/orders/${encodeURIComponent(orderId)}`;
    const pay = await gw("POST", `${orderPath}/pay`, session);
    expect(pay.status).toBe(202);

    await h.waitForState(orderId, ["PAID"], 60_000);
    const order = await gw("GET", orderPath, session);
    expect(order.status).toBe(200);
    expect(order.body.state).toBe("PAID");

    // The hold becomes a sale a moment after the order is PAID (the settlement consumer).
    await waitFor("the hold to be settled as sold", 30_000, async () => {
      const { avail, sold } = await h.inventory(eventId);
      return avail === 4 && sold === 1;
    });
    await h.waitQuiet(60_000).catch(() => {});
  }, 180_000);

  it("14. exports 401s and 429s per route to Prometheus", async () => {
    const targets = (await (await fetch(`${PROMETHEUS}/api/v1/targets`)).json()) as {
      data: { activeTargets: { labels: { job: string }; health: string }[] };
    };
    const scraped = (job: string) =>
      targets.data.activeTargets.some((t) => t.labels.job === job && t.health === "up");
    expect(
      scraped("envoy") && scraped("ratelimit"),
      "Prometheus has no healthy envoy and ratelimit targets: it reads infra/prometheus.yml at start, so restart it (docker compose restart prometheus)",
    ).toBe(true);

    // One of each kind, whatever ran before: a 401 on orders, a global 429 on status and a local 429
    // on login.
    expect((await gw("GET", "/api/orders/none")).status).toBe(401);
    const grace = user("grace14");
    await clearOfWindowEdge();
    for (let i = 0; i < 11; i++) {
      await gw("GET", statusPath(), { as: grace });
    }
    await sleep(5_500);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        gw("POST", "/api/auth/dev-login", { body: { userId: user("burst14") } }),
      ),
    );

    const count = async (query: string): Promise<number> => {
      const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(query)}`);
      const body = (await res.json()) as { data: { result: { value: [number, string] }[] } };
      return body.data.result.reduce((sum, series) => sum + Number(series.value[1]), 0);
    };
    const series = {
      "401s on orders": 'envoy_gateway_requests{route="orders", code="401"}',
      "local 429s on login":
        'envoy_gateway_requests{route="login", code="429", reason="local_rate_limited"}',
      "global 429s on status":
        'envoy_gateway_requests{route="status", code="429", reason="request_rate_limited"}',
      "the ratelimit service's OVER_LIMIT count for status per user":
        'ratelimit_service_rate_limit_over_limit{domain="flashsale", key1="generic_key_status", key2="user_id"}',
    };
    for (const [what, query] of Object.entries(series)) {
      // Scraped every 5 seconds.
      await waitFor(
        `Prometheus to have ${what}`,
        40_000,
        async () => (await count(query)) > 0,
        1_000,
      );
    }
  }, 120_000);
});
