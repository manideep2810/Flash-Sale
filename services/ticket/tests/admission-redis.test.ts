import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@flash/observability";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { mintAdmissionToken, TEST_ADMISSION_SECRET } from "../../../tools/admission-token.js";
import { createRequireAdmission } from "../src/admission.js";
import {
  createRedisPool,
  createReserveScript,
  heldKey,
  type RedisPool,
  reserveKeys,
  resetEvent,
  soldKey,
} from "../src/redis/index.js";
import { createApp } from "../src/server.js";

// The real handler, the real reserve.lua and the real ioredis clients, with a spy on each client's
// sendCommand: every command ioredis sends goes through it. Needs the local Redis:
// `REDIS_URL=redis://localhost:6380 pnpm test`. Skipped when REDIS_URL is unset.
const REDIS_URL = process.env.REDIS_URL;
const EVENT_ID = "admission-spy-test";

describe.skipIf(!REDIS_URL)("admission check, against the real Redis client", () => {
  const logger = createLogger({ service: "ticket", level: "error" });
  let pool: RedisPool;
  let server: Server;
  let url: string;
  let spies: MockInstance[];

  const commandsSent = () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  const avail = async () => Number(await pool.next().get(reserveKeys(EVENT_ID)[0]));

  const reserve = (body: unknown, token?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { "x-admission-token": token }),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    pool = createRedisPool({ REDIS_URL, REDIS_POOL: "2" } as NodeJS.ProcessEnv);
    await pool.ready();
    const reserveScript = await createReserveScript({ pool, logger, holdTtlMs: 600_000 });
    await resetEvent(pool, EVENT_ID, 5);

    const app = createApp(logger, undefined, {
      reserveScript,
      redisPool: pool,
      requireAdmission: createRequireAdmission({ secret: TEST_ADMISSION_SECRET, logger }),
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redis/reserve`;

    // Installed last, so loading the script and seeding the event are not counted.
    spies = pool.all().map((client) => vi.spyOn(client, "sendCommand"));
  });

  beforeEach(() => {
    for (const spy of spies) {
      spy.mockClear();
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    server?.close();
    server?.closeAllConnections();
    const [availKey, holds, stream, held] = reserveKeys(EVENT_ID);
    await pool.next().del(availKey, holds, stream, held, soldKey(EVENT_ID), `ev:${EVENT_ID}:total`);
    await pool.next().srem("events:active", EVENT_ID);
    await pool.quit();
  });

  it("1. sends no Redis command for a request it refuses", async () => {
    const body = { eventId: EVENT_ID, userId: "alice", qty: 1 };
    const forBob = await mintAdmissionToken({ userId: "bob", eventId: EVENT_ID });

    const refused = [
      [await reserve(body), 401, "ADMISSION_REQUIRED"],
      [await reserve(body, "not-a-jwt"), 401, "TOKEN_INVALID"],
      [await reserve(body, forBob), 403, "TOKEN_MISMATCH"],
    ] as const;
    for (const [res, status, code] of refused) {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
    expect(commandsSent()).toBe(0);

    // Read after the count, since reading is itself a command: the inventory is untouched.
    expect(await avail()).toBe(5);
  });

  it("runs reserve.lua, once, for a caller with a valid token", async () => {
    const token = await mintAdmissionToken({ userId: "alice", eventId: EVENT_ID });
    const res = await reserve({ eventId: EVENT_ID, userId: "alice", qty: 2 }, token);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ holdId: expect.stringContaining(`${EVENT_ID}:alice:`) });

    const sent = spies.flatMap((spy) => spy.mock.calls.map(([command]) => command.name));
    expect(sent).toEqual(["evalsha"]);
    expect(await avail()).toBe(3);
    expect(Number(await pool.next().get(heldKey(EVENT_ID)))).toBe(2);
  });
});
