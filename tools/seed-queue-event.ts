// Seeds one waiting-room event for a fresh run, straight into Redis. The event gets NO entry in the
// catalogue, so it is not on the web app's front page: for events to look at, use seed-events.ts
// (`make seed`). This one is for load runs and for poking at the waiting room by hand.
//
//   pnpm -C tools run seed-queue-event
//   EVENT_ID=evt-001 SALE_OPENS_IN_SEC=10 ADMIT_RATE=50 pnpm -C tools run seed-queue-event
//   EVENT_NAME="Launch day" EVENT_PRICE=4999 pnpm -C tools run seed-queue-event
//
// Writes the event's config hash, lists it in queue:events (the set the admitter iterates) and
// deletes its queue, admitted and state keys, in one MULTI (seedWaitingRoom in load/lib/seed.ts,
// which the load tools use too).
//
// It does NOT seed stock. That belongs to Phase 2 (the ticket service's ev:<eventId>:avail key), and
// the admitter leaves an event alone until it exists; when it is missing this prints how to seed it.

import { Redis } from "ioredis";
import { keysOf, seedWaitingRoom } from "./load/lib/seed.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const TICKET_URL = process.env.TICKET_URL ?? "http://localhost:3001";
const EVENT_ID = process.env.EVENT_ID ?? "demo";

/** Reads a number from the environment, falling back when unset and failing when it is not one. */
function numberFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

const LOBBY_OPENS_IN_SEC = numberFromEnv("LOBBY_OPENS_IN_SEC", 0, 0);
const SALE_OPENS_IN_SEC = numberFromEnv("SALE_OPENS_IN_SEC", 60, 0);
const ADMIT_RATE = numberFromEnv("ADMIT_RATE", 500, 1);
const ADMIT_TTL_SEC = numberFromEnv("ADMIT_TTL_SEC", 120, 1);
// The price is per ticket, in the smallest currency unit: what the order service charges, times the
// quantity, when an order of this event is paid for.
const EVENT_NAME = process.env.EVENT_NAME || "Demo event";
const EVENT_PRICE = numberFromEnv("EVENT_PRICE", 4999, 0);

const availKey = (eventId: string) => keysOf(eventId).avail;

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  // Without a listener ioredis prints every failed connection attempt; the failure is reported once,
  // by the command that gives up.
  redis.on("error", () => {});
  try {
    const now = Date.now();
    const lobbyOpensAt = now + Math.round(LOBBY_OPENS_IN_SEC * 1000);
    const saleOpensAt = now + Math.round(SALE_OPENS_IN_SEC * 1000);

    await seedWaitingRoom(redis, {
      eventId: EVENT_ID,
      lobbyOpensAt,
      saleOpensAt,
      admitRatePerSec: ADMIT_RATE,
      admitTtlSec: ADMIT_TTL_SEC,
      name: EVENT_NAME,
      price: EVENT_PRICE,
    });

    console.log(`event        ${EVENT_ID}  ("${EVENT_NAME}", price ${Math.round(EVENT_PRICE)})`);
    console.log(`lobby opens  ${new Date(lobbyOpensAt).toISOString()}`);
    console.log(`sale opens   ${new Date(saleOpensAt).toISOString()}  (in ${SALE_OPENS_IN_SEC}s)`);
    console.log(`admit rate   ${ADMIT_RATE}/s`);
    console.log(`admit ttl    ${Math.round(ADMIT_TTL_SEC)}s`);
    console.log("queue, admitted and state cleared");
    console.log("queue-svc and the admitter cache event config for 5s, so allow that long.");

    const stock = await redis.get(availKey(EVENT_ID));
    if (stock === null) {
      console.log("");
      console.log(`No stock: ${availKey(EVENT_ID)} does not exist, so the admitter will not admit`);
      console.log("anyone for this event. Seed it through the running ticket service:");
      console.log("");
      console.log(
        `  curl -X POST ${TICKET_URL}/redis/reset -H "content-type: application/json" \\`,
      );
      console.log(`    -d '{"eventId":"${EVENT_ID}","total":1000}'`);
      console.log("");
      console.log("Do not use infra/redis/init.sh for this now: it FLUSHALLs, which would delete");
      console.log(
        "the config written above. If you do use it, run it first and this script after.",
      );
    } else {
      console.log(`stock        ${stock} available (${availKey(EVENT_ID)})`);
    }
  } finally {
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error(
    `seed failed against ${REDIS_URL}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
