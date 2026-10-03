// Checks that every hold in Redis became exactly one order in Postgres.
//
//   pnpm -C tools run check-outbox <eventId> [timeoutSeconds]
//
// Waits for the pipeline to go quiet (nothing left for the relay, no consumer lag), then compares the
// two sides. Prints PASS or FAIL with the numbers and exits 0 or 1.

import { setTimeout as sleep } from "node:timers/promises";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Redis } from "ioredis";
import pg from "pg";

// Local-stack defaults (infra/docker/docker-compose.yml); override through the environment.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5434/flashsale?schema=order";
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";

// Names owned by the services: reserveKeys() in the ticket service, streams.ts in the relay,
// consumer.ts in the order service. They have to be kept in step with those by hand.
const RELAY_GROUP = "relay";
const TOPIC = "reservations.events";
const ORDER_GROUP = "order-service";

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

export interface OutboxCheck {
  eventId: string;
  pass: boolean;
  /** False when the relay or the consumer still had work left at the deadline. */
  drained: boolean;
  /** Stream entries the relay has read and not acked. */
  relayPending: number;
  /** True when the stream holds entries the relay has not read yet. */
  relayUnread: boolean;
  /** Messages in reservations.events the order-service group has not committed, all partitions. */
  consumerLag: number;
  holds: number;
  orders: number;
  /** total - avail. The holds ZSET stores no qty, so this is what Redis has taken out of stock. */
  heldQty: number;
  orderQty: number;
  duplicateOrderIds: number;
}

export interface CheckOptions {
  timeoutMs?: number;
}

interface Backlog {
  relayPending: number;
  relayUnread: boolean;
  consumerLag: number;
}

async function relayBacklog(
  redis: Redis,
  stream: string,
): Promise<Pick<Backlog, "relayPending" | "relayUnread">> {
  let groups: unknown;
  try {
    groups = await redis.xinfo("GROUPS", stream);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such key")) {
      return { relayPending: 0, relayUnread: false };
    }
    throw error;
  }
  // Each group is a flat [field, value, field, value, ...] list.
  const group = (groups as unknown[][]).find((g) => g[g.indexOf("name") + 1] === RELAY_GROUP);
  if (!group) {
    // The relay has never opened this stream, so anything in it is still waiting.
    return { relayPending: 0, relayUnread: (await redis.xlen(stream)) > 0 };
  }
  const lastDelivered = String(group[group.indexOf("last-delivered-id") + 1]);
  const next = await redis.xrange(stream, `(${lastDelivered}`, "+", "COUNT", 1);
  return {
    relayPending: Number(group[group.indexOf("pending") + 1]),
    relayUnread: next.length > 0,
  };
}

/** End of each partition minus what the order-service group has committed, summed. */
async function consumerLag(admin: KafkaJS.Admin): Promise<number> {
  const [ends, committed] = await Promise.all([
    admin.fetchTopicOffsets(TOPIC),
    admin.fetchOffsets({ groupId: ORDER_GROUP, topics: [TOPIC] }),
  ]);
  const committedOffsets = new Map(
    committed.flatMap(({ partitions }) => partitions.map((p) => [p.partition, Number(p.offset)])),
  );
  let lag = 0;
  for (const { partition, high, low } of ends) {
    const offset = committedOffsets.get(partition);
    // Nothing committed yet (reported as a negative offset): the group starts from the oldest message.
    const position = offset === undefined || offset < 0 ? Number(low) : offset;
    lag += Math.max(0, Number(high) - position);
  }
  return lag;
}

const isDrained = (b: Backlog): boolean =>
  b.relayPending === 0 && !b.relayUnread && b.consumerLag === 0;

export async function checkOutbox(
  eventId: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: CheckOptions = {},
): Promise<OutboxCheck> {
  const deadline = Date.now() + timeoutMs;
  const stream = `ev:${eventId}:stream`;

  // Prisma's `?schema=` is not something node-postgres understands, so it is taken off the URL and
  // used to qualify the table name instead.
  const url = new URL(DATABASE_URL);
  const schema = url.searchParams.get("schema") ?? "public";
  url.searchParams.delete("schema");
  const orderTable = `"${schema.replaceAll('"', '""')}"."Order"`;

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  // Failed reconnect attempts surface as rejected commands below; this only keeps ioredis from
  // printing each one as an unhandled error event.
  redis.on("error", () => {});
  const db = new pg.Client({ connectionString: url.href });
  const admin = new KafkaJS.Kafka({ "bootstrap.servers": KAFKA_BROKERS }).admin();
  let adminConnected = false;

  try {
    await db.connect();
    // connect() keeps retrying while no broker answers, so it is raced against the deadline.
    adminConnected = await Promise.race([
      admin.connect().then(() => true),
      sleep(timeoutMs, false, { ref: false }),
    ]);
    if (!adminConnected) {
      throw new Error(`no broker reachable at ${KAFKA_BROKERS} within ${timeoutMs}ms`);
    }

    // 1. Wait for the pipeline to go quiet. A read that fails (something is still restarting) counts
    //    as not quiet yet.
    let backlog: Backlog = { relayPending: Number.NaN, relayUnread: true, consumerLag: Number.NaN };
    for (;;) {
      try {
        backlog = { ...(await relayBacklog(redis, stream)), consumerLag: await consumerLag(admin) };
      } catch {
        // Keep the last reading and try again.
      }
      if (isDrained(backlog) || Date.now() >= deadline) {
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // 2. Compare the two sides.
    const [holds, total, avail] = await Promise.all([
      redis.zcard(`ev:${eventId}:holds`),
      redis.get(`ev:${eventId}:total`),
      redis.get(`ev:${eventId}:avail`),
    ]);
    if (total === null || avail === null) {
      throw new Error(
        `event "${eventId}" has no inventory in Redis (ev:${eventId}:total / :avail)`,
      );
    }
    const heldQty = Number(total) - Number(avail);

    const { rows: orderRows } = await db.query<{ orders: number; qty: number }>(
      `SELECT count(*)::int AS orders, coalesce(sum(qty), 0)::int AS qty
         FROM ${orderTable} WHERE "eventId" = $1`,
      [eventId],
    );
    const { rows: duplicateRows } = await db.query<{ duplicates: number }>(
      `SELECT count(*)::int AS duplicates
         FROM (SELECT id FROM ${orderTable} WHERE "eventId" = $1
               GROUP BY id HAVING count(*) > 1) AS repeated`,
      [eventId],
    );
    const orders = orderRows[0]?.orders ?? 0;
    const orderQty = orderRows[0]?.qty ?? 0;
    const duplicateOrderIds = duplicateRows[0]?.duplicates ?? 0;

    const drained = isDrained(backlog);
    return {
      eventId,
      pass: drained && holds === orders && heldQty === orderQty && duplicateOrderIds === 0,
      drained,
      ...backlog,
      holds,
      orders,
      heldQty,
      orderQty,
      duplicateOrderIds,
    };
  } finally {
    redis.disconnect();
    await db.end().catch(() => {});
    if (adminConnected) {
      await admin.disconnect().catch(() => {});
    }
  }
}

/** The report the CLI prints; the e2e tests attach it to a failed assertion. */
export function formatCheck(c: OutboxCheck): string {
  const versus = (a: number, b: number) => `${a} ${a === b ? "=" : "!="} ${b}`;
  return [
    `check-outbox ${c.eventId}: ${c.pass ? "PASS" : "FAIL"}${c.drained ? "" : " (pipeline did not go quiet before the timeout)"}`,
    `  relay pending             ${c.relayPending}${c.relayUnread ? " (plus entries not read yet)" : ""}`,
    `  consumer lag              ${c.consumerLag}`,
    `  holds vs orders           ${versus(c.holds, c.orders)}`,
    `  held qty vs order qty     ${versus(c.heldQty, c.orderQty)}`,
    `  duplicate order ids       ${c.duplicateOrderIds}`,
  ].join("\n");
}

if (import.meta.main) {
  const [eventId, timeoutSeconds] = process.argv.slice(2);
  const timeoutMs = timeoutSeconds === undefined ? undefined : Number(timeoutSeconds) * 1_000;
  if (!eventId || (timeoutMs !== undefined && !(timeoutMs > 0))) {
    console.error("usage: check-outbox <eventId> [timeoutSeconds]");
    process.exit(2);
  }
  try {
    const result = await checkOutbox(eventId, { timeoutMs });
    console.log(formatCheck(result));
    process.exit(result.pass ? 0 : 1);
  } catch (error) {
    console.error(
      `check-outbox ${eventId}: FAIL\n  ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}
