import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Redis } from "ioredis";
import pg from "pg";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Local-stack defaults (infra/docker/docker-compose.yml), the same ones tools/check-outbox.ts uses.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5434/flashsale?schema=order";
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";
const COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME ?? "flash-sale";

const TOPIC = "reservations.events";
const ACTIVE_EVENTS = "events:active";

const STARTUP_TIMEOUT_MS = 30_000;
/** For the waits a test uses to time a kill: the failure should land while work is in hand. */
const FAST_POLL_MS = 5;

async function waitFor(
  what: string,
  timeoutMs: number,
  done: () => Promise<boolean>,
  pollMs = 200,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(pollMs);
  }
}

/** One of the repo's services, run as a child process so a test can kill it and bring it back. */
export class Service {
  readonly url: string;
  #child: ChildProcess | undefined;
  #output = "";

  constructor(
    readonly name: "ticket" | "relay" | "order",
    readonly port: number,
    private readonly env: Record<string, string>,
  ) {
    this.url = `http://localhost:${port}`;
  }

  async #answers(path: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}${path}`, { signal: AbortSignal.timeout(1_000) });
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (await this.#answers("/healthz/live")) {
      throw new Error(
        `port ${this.port} is already serving: stop the ${this.name} service (\`make dev\`) before running the e2e tests`,
      );
    }
    // `node --import tsx` rather than the tsx CLI: the CLI runs the program in a child of its own,
    // and killing the wrapper would leave the real process alive.
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: `${ROOT}services/${this.name}`,
      env: {
        ...process.env,
        NODE_ENV: "development",
        LOG_LEVEL: "warn",
        ...this.env,
        PORT: String(this.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#output = "";
    const keepTail = (chunk: Buffer) => {
      this.#output = (this.#output + chunk.toString()).slice(-4_000);
    };
    child.stdout?.on("data", keepTail);
    child.stderr?.on("data", keepTail);
    this.#child = child;

    await waitFor(`${this.name} to become ready`, STARTUP_TIMEOUT_MS, async () => {
      if (child.exitCode !== null) {
        throw new Error(`${this.name} exited during startup:\n${this.#output}`);
      }
      return this.#answers("/healthz/ready");
    }).catch((error) => {
      throw new Error(`${(error as Error).message}\n${this.#output}`);
    });
  }

  /** SIGKILL: no drain, no XACK, no offset commit. What a crash looks like to everything else. */
  async kill(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.kill("SIGKILL");
    await once(child, "exit");
    // The ticket service's cluster workers notice the primary is gone and exit a moment later.
    await waitFor(`${this.name} to stop answering`, 10_000, async () => {
      return !(await this.#answers("/healthz/live"));
    });
  }
}

const run = promisify(execFile);

async function compose(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", [
    "compose",
    "-p",
    COMPOSE_PROJECT_NAME,
    "-f",
    `${ROOT}infra/docker/docker-compose.yml`,
    ...args,
  ]);
  return stdout;
}

/** The Kafka-protocol broker, which is Redpanda in the local stack. */
export const broker = {
  /** `docker compose kill` sends SIGKILL, so nothing in flight is flushed or acknowledged. */
  async kill(): Promise<void> {
    await compose("kill", "redpanda");
  },
  async start(): Promise<void> {
    await compose("start", "redpanda");
    await waitFor("redpanda to report healthy", 60_000, async () => {
      try {
        return /Healthy:\s*true/.test(
          await compose("exec", "-T", "redpanda", "rpk", "cluster", "health"),
        );
      } catch {
        return false;
      }
    });
  },
};

export interface Fixture {
  ticket: Service;
  relay: Service;
  order: Service;
  /** Seeds a new event with `total` tickets and marks it active for the relay. Returns its id. */
  createEvent(total: number): Promise<string>;
  /** Reserves one ticket each for `count` distinct users. Returns how many got a hold (201). */
  reserve(eventId: string, count: number, userPrefix: string): Promise<number>;
  /** Resolves once the relay has read its first entries from the event's stream. */
  relayReading(eventId: string): Promise<void>;
  /** Resolves once the order service has written at least one order for the event. */
  ordersArriving(eventId: string): Promise<void>;
  /** The Kafka message the relay published for the event's most recent reservation, rebuilt. */
  lastRelayedMessage(eventId: string): Promise<KafkaJS.Message>;
  produce(messages: KafkaJS.Message[]): Promise<void>;
  /** Current value of an unlabelled metric on the order service's /metrics. */
  orderMetric(name: string): Promise<number>;
  /** Kills the services and removes every event this fixture created, in Redis and Postgres. */
  stop(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const url = new URL(DATABASE_URL);
  const schema = url.searchParams.get("schema") ?? "public";
  url.searchParams.delete("schema");
  const table = (name: string) => `"${schema.replaceAll('"', '""')}"."${name}"`;

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on("error", () => {});
  const db = new pg.Pool({ connectionString: url.href, max: 2 });

  // Fail with something readable if the stack is not there, rather than on the first reserve.
  try {
    await redis.ping();
    await db.query(`SELECT 1 FROM ${table("Order")} LIMIT 1`);
  } catch (error) {
    redis.disconnect();
    await db.end();
    throw new Error(
      `the local stack is not ready (${(error as Error).message}): run \`make up\` and \`make migrate\` first`,
    );
  }

  const ticket = new Service("ticket", 3001, { REDIS_URL, WORKERS: "2", METRICS_PORT: "9464" });
  const relay = new Service("relay", 3002, { REDIS_URL, KAFKA_BROKERS });
  const order = new Service("order", 3003, { DATABASE_URL, KAFKA_BROKERS });
  const services = [ticket, relay, order];
  const events: string[] = [];

  try {
    await Promise.all(services.map((service) => service.start()));
  } catch (error) {
    await Promise.all(services.map((service) => service.kill()));
    redis.disconnect();
    await db.end();
    throw error;
  }

  const postJson = (path: string, body: unknown) =>
    fetch(`${ticket.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    ticket,
    relay,
    order,

    async createEvent(total) {
      // A fresh id every time: /redis/reset clears Redis but not the orders of an earlier run.
      const eventId = `e2e-${randomUUID()}`;
      const res = await postJson("/redis/reset", { eventId, total });
      if (!res.ok) {
        throw new Error(`reset returned ${res.status}: ${await res.text()}`);
      }
      await res.arrayBuffer();
      events.push(eventId);
      return eventId;
    },

    async reserve(eventId, count, userPrefix) {
      let next = 0;
      let held = 0;
      // 50 requests in flight at a time, each worker taking the next user until none are left.
      await Promise.all(
        Array.from({ length: Math.min(50, count) }, async () => {
          while (next < count) {
            const userId = `${userPrefix}-${next++}`;
            const res = await postJson("/redis/reserve", { eventId, userId, qty: 1 });
            const body = await res.text();
            if (res.status === 201) {
              held++;
            } else if (res.status !== 409) {
              throw new Error(`reserve returned ${res.status}: ${body}`);
            }
          }
        }),
      );
      return held;
    },

    async relayReading(eventId) {
      const stream = `ev:${eventId}:stream`;
      await waitFor(
        "the relay to start reading the stream",
        30_000,
        async () => {
          // The relay's group is created with last-delivered-id 0-0, which moves on its first read.
          const groups = (await redis.xinfo("GROUPS", stream)) as unknown[][];
          return groups.some(
            (g) =>
              g[g.indexOf("name") + 1] === "relay" &&
              g[g.indexOf("last-delivered-id") + 1] !== "0-0",
          );
        },
        FAST_POLL_MS,
      );
    },

    async ordersArriving(eventId) {
      await waitFor(
        "the first order to be written",
        30_000,
        async () => {
          const { rows } = await db.query(
            `SELECT 1 FROM ${table("Order")} WHERE "eventId" = $1 LIMIT 1`,
            [eventId],
          );
          return rows.length > 0;
        },
        FAST_POLL_MS,
      );
    },

    async lastRelayedMessage(eventId) {
      const stream = `ev:${eventId}:stream`;
      const [entry] = await redis.xrevrange(stream, "+", "-", "COUNT", 1);
      if (!entry) {
        throw new Error(`stream ${stream} is empty`);
      }
      const [entryId, fields] = entry;
      const data: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) {
        data[String(fields[i])] = String(fields[i + 1]);
      }
      // Same shape as toKafkaMessage() in services/relay/src/producer.ts.
      return { key: data.holdId ?? null, value: JSON.stringify({ ...data, stream, entryId }) };
    },

    async produce(messages) {
      const producer = new KafkaJS.Kafka({ "bootstrap.servers": KAFKA_BROKERS }).producer({
        acks: -1,
      });
      await producer.connect();
      try {
        await producer.send({ topic: TOPIC, messages });
      } finally {
        await producer.disconnect();
      }
    },

    async orderMetric(name) {
      const text = await (await fetch(`${order.url}/metrics`)).text();
      const line = text.split("\n").find((l) => l.startsWith(`${name} `));
      if (!line) {
        throw new Error(`metric ${name} not found on ${order.url}/metrics`);
      }
      return Number(line.slice(name.length + 1));
    },

    async stop() {
      await Promise.all(services.map((service) => service.kill()));
      for (const eventId of events) {
        await redis.srem(ACTIVE_EVENTS, eventId);
        await redis.del(
          ...["avail", "total", "holds", "stream"].map((key) => `ev:${eventId}:${key}`),
        );
        await db.query(`DELETE FROM ${table("Order")} WHERE "eventId" = $1`, [eventId]);
        await db.query(`DELETE FROM ${table("ProcessedEvent")} WHERE "eventId" LIKE $1`, [
          `ev:${eventId}:stream:%`,
        ]);
      }
      redis.disconnect();
      await db.end();
    },
  };
}
