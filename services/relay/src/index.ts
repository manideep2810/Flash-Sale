import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@flash/observability";
import { config } from "./config.js";
import { brokerReachable, producer } from "./producer.js";
import { startRecovery } from "./recovery.js";
import { auxRedis, redis, redisReachable } from "./redis.js";
import { run, stop } from "./relay.js";
import { startServer } from "./server.js";
import { ACTIVE_EVENTS } from "./streams.js";
import { startTrim } from "./trim.js";

const RETRY_DELAY_MS = 1_000;

const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

// ioredis reconnects by itself and reports each failed attempt as an "error" event; with no listener
// those are printed to stderr as unhandled.
for (const [connection, client] of [
  ["loop", redis],
  ["aux", auxRedis],
] as const) {
  client.on("error", (error) => {
    logger.warn("redis connection error", { connection, error: error.message });
  });
}

let stopping = false;
let stopTimers = () => {};
let relay: Promise<void> = Promise.resolve();

/**
 * Keeps run() going. run() rejects when Redis or the broker fails mid-batch; the entries it was
 * holding stay in this consumer's pending list, and the next run() begins with recoverPending(),
 * which resends them.
 */
async function supervise(): Promise<void> {
  while (!stopping) {
    try {
      // run() XREADGROUPs every stream in events:active, and with the set empty Redis rejects that
      // command as a syntax error, so wait here until there is a stream to read.
      if ((await auxRedis.scard(ACTIVE_EVENTS)) === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      await run();
    } catch (error) {
      if (stopping) {
        break;
      }
      logger.error("relay loop failed, restarting", error);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// The listener opens before the broker is connected so the probes answer during startup: readiness
// stays 503 until Redis and the broker are both reachable.
startServer({
  port: config.PORT,
  logger,
  checkDependencies: async () => {
    const [redisOk, kafkaOk] = await Promise.all([redisReachable(), brokerReachable()]);
    return { redis: redisOk, kafka: kafkaOk };
  },
  closeClients: async () => {
    stopping = true;
    stop();
    stopTimers();
    await relay;
    await producer.disconnect();
    await Promise.all([redis.quit(), auxRedis.quit()]);
  },
});

// Does not resolve until a broker answers, however long that takes.
await producer.connect();
logger.info("producer connected", { brokers: config.KAFKA_BROKERS });

if (!stopping) {
  const stopRecovery = startRecovery(logger);
  const stopTrim = startTrim(logger);
  stopTimers = () => {
    stopRecovery();
    stopTrim();
  };
  relay = supervise();
}
