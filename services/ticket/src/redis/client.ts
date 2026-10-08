import { Redis } from "ioredis";

/**
 * Round-robin pool of Redis connections, sized from REDIS_POOL.
 *
 * ioredis has no connection pool of its own: one Redis instance is a single TCP socket that
 * multiplexes commands, so REDIS_POOL is implemented here as N independent clients handed out in
 * turn. Redis executes commands on one thread, so extra sockets buy nothing server-side -- they are
 * here so that a single socket's syscall and serialization cost does not become the *client-side*
 * ceiling, which is the same reason the Postgres baseline runs a pool (see src/baseline/db.ts).
 */
export interface RedisPool {
  readonly size: number;
  /** Next connection in the rotation. */
  next(): Redis;
  /** Every connection, for commands that must target a specific client. */
  all(): readonly Redis[];
  /** Opens every connection; call once at startup before issuing commands. */
  ready(): Promise<void>;
  quit(): Promise<void>;
}

export function createRedisPool(env: NodeJS.ProcessEnv = process.env): RedisPool {
  const url = env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required for the redis module");
  }

  const size = Number.parseInt(env.REDIS_POOL ?? "10", 10);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`REDIS_POOL must be a positive integer, got "${env.REDIS_POOL}"`);
  }

  const clients = Array.from(
    { length: size },
    () =>
      new Redis(url, {
        // Connect in ready() rather than the constructor, so building the pool stays side-effect free
        // and a bad URL surfaces at startup instead of on import.
        lazyConnect: true,
        // Fail a command rather than parking it indefinitely while the socket is down. Under load an
        // unbounded offline queue turns a brief blip into a latency cliff that outlives the blip.
        maxRetriesPerRequest: 3,
        // Off deliberately: auto-pipelining coalesces commands issued in the same event-loop tick,
        // which would make these numbers incomparable to the Postgres variants' one-round-trip-per-
        // request shape. Turn it on to measure how fast the client *can* go.
        enableAutoPipelining: false,
      }),
  );

  let cursor = 0;

  return {
    size,
    next() {
      const client = clients[cursor];
      cursor = (cursor + 1) % size;
      if (!client) {
        throw new Error("redis pool is empty");
      }
      return client;
    },
    all: () => clients,
    async ready() {
      // Called once at startup, when every lazily-created client is still in "wait"; connect()
      // rejects for any other status, so anything already opening is left to finish on its own.
      await Promise.all(
        clients.map((client) => (client.status === "wait" ? client.connect() : Promise.resolve())),
      );
    },
    async quit() {
      await Promise.allSettled(clients.map((client) => client.quit()));
    },
  };
}

let shared: RedisPool | undefined;

/** Process-wide pool built from the environment on first use, so importing this module is side-effect free. */
export function getRedisPool(): RedisPool {
  shared ??= createRedisPool();
  return shared;
}

export type { Redis } from "ioredis";
