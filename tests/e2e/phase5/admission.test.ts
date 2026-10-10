// The waiting room end to end, service to service: join -> admitted by the admitter -> status hands
// out the token -> that token opens POST /redis/reserve on the ticket service. Each call carries the
// user's session. (gateway.test.ts covers the same path through Envoy.)
//
//   pnpm -C tests/e2e run test:phase5
//
// Starts the ticket service, queue-svc and queue-admitter as child processes on their usual ports
// (stop `make dev` first), all given one SESSION_SECRET and one ADMISSION_SECRET. Needs only Redis
// from the local stack.

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer } from "../../../tools/tokens.js";
import {
  call,
  forgetSale,
  openWaitingRoom,
  QUEUE,
  queueProcs,
  REDIS_URL,
  TICKET,
  ticketProc,
  waitFor,
} from "./support.js";

describe("admission token, from the waiting room to /redis/reserve", () => {
  const procs = [ticketProc(), ...queueProcs()];
  const eventId = `e2e-admission-${randomUUID().slice(0, 8)}`;
  let redis: Redis;

  const avail = async () => Number(await redis.get(`ev:${eventId}:avail`));

  /** Joins, then polls status the way a client would until the admitter has let the user in. */
  async function admit(userId: string): Promise<string> {
    const session = { authorization: await bearer(userId) };
    const joined = await call("POST", `${QUEUE}/queue/${eventId}/join`, session);
    expect(joined.status).toBe(200);
    expect(["QUEUED", "ADMITTED"]).toContain(joined.body.status);

    let token: string | undefined;
    await waitFor(`${userId} to be admitted`, 15_000, async () => {
      const { body } = await call("GET", `${QUEUE}/queue/${eventId}/status`, session);
      token = body.token;
      return body.status === "ADMITTED";
    });
    return String(token);
  }

  /** As `userId`, logged in, unless `userId` is null. The body does not say who is reserving. */
  const reserve = async (userId: string | null, token?: string) =>
    call(
      "POST",
      `${TICKET}/redis/reserve`,
      {
        ...(userId === null ? {} : { authorization: await bearer(userId) }),
        ...(token === undefined ? {} : { "x-admission-token": token }),
      },
      { eventId, qty: 1 },
    );

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    try {
      await redis.ping();
    } catch (error) {
      redis.disconnect();
      throw new Error(
        `redis is not reachable (${(error as Error).message}): run \`make up\` first`,
      );
    }
    try {
      await Promise.all(procs.map((proc) => proc.start()));
    } catch (error) {
      await Promise.all(procs.map((proc) => proc.kill()));
      redis.disconnect();
      throw error;
    }

    // Stock through the ticket service, as in every other run; then the waiting room, already open.
    const reset = await call("POST", `${TICKET}/redis/reset`, {}, { eventId, total: 3 });
    expect(reset.status).toBe(200);
    await openWaitingRoom(redis, eventId);
  });

  afterAll(async () => {
    await Promise.all(procs.map((proc) => proc.kill()));
    if (!redis) {
      return;
    }
    await forgetSale(redis, eventId);
    redis.disconnect();
  });

  it("2. reserves with the token queue-svc hands an admitted user", async () => {
    const token = await admit("alice");

    const reserved = await reserve("alice", token);
    expect(reserved.status).toBe(201);
    expect(reserved.body.holdId).toContain(`${eventId}:alice:`);
    expect(await avail()).toBe(2);
    expect(await redis.zcard(`ev:${eventId}:holds`)).toBe(1);
  });

  it("refuses the same reserve without the token, or with someone else's", async () => {
    const alices = await admit("alice");

    // No session: alice's admission token alone is not enough.
    const anonymous = await reserve(null, alices);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("UNAUTHENTICATED");

    const none = await reserve("bob");
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("ADMISSION_REQUIRED");

    const borrowed = await reserve("bob", alices);
    expect(borrowed.status).toBe(403);
    expect(borrowed.body.code).toBe("TOKEN_MISMATCH");

    // Nothing was taken from stock by any of them.
    expect(await avail()).toBe(2);

    // Bob waits his turn like anyone else, and then it works.
    const bobs = await admit("bob");
    expect((await reserve("bob", bobs)).status).toBe(201);
    expect(await avail()).toBe(1);
  });
});
