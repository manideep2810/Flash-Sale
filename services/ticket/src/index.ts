import cluster from "node:cluster";
import { createLogger } from "@flash/observability";
import { getPool } from "./baseline/db.js";
import { config } from "./config.js";
import { collectWorkerMetrics, startMetricsServer } from "./metrics.js";
import {
  createReserveScript,
  getRedisPool,
  type RedisPool,
  type ReserveScript,
} from "./redis/index.js";
import { startServer } from "./server.js";

// Process model: the primary forks WORKERS node:cluster workers that all accept on PORT (one Node
// thread cannot drive a flash-sale burst alone), and serves /metrics for the whole set on
// METRICS_PORT. Workers run the HTTP app; each opens its own Redis/Postgres pools.
const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });

if (cluster.isPrimary) {
  runPrimary();
} else {
  await runWorker();
}

function runPrimary(): void {
  const log = logger.child({ role: "primary" });
  let shuttingDown = false;
  let alive = 0;

  const fork = () => {
    cluster.fork();
    alive++;
  };

  cluster.on("online", (worker) => {
    log.info("worker online", { worker: worker.id, pid: worker.process.pid });
  });

  cluster.on("exit", (worker, code, signal) => {
    alive--;
    if (shuttingDown) {
      log.info("worker stopped", { worker: worker.id, code, signal, remaining: alive });
      if (alive === 0) {
        log.info("shutdown complete");
      }
      return;
    }
    // A crashed worker takes its share of in-flight requests with it; replacing it keeps capacity
    // up. A boot-time failure (bad env, Redis down) would loop here, which is loud on purpose.
    log.warn("worker exited unexpectedly, replacing", { worker: worker.id, code, signal });
    fork();
  });

  for (let i = 0; i < config.WORKERS; i++) {
    fork();
  }
  log.info("primary started", { workers: config.WORKERS, metricsPort: config.METRICS_PORT });

  const metricsServer = startMetricsServer({ port: config.METRICS_PORT, logger: log });

  // Workers each run their own drain (see server.ts); the primary just relays the signal and lets
  // the event loop wind down once the last worker and the metrics listener are gone.
  process.once("SIGTERM", (signal) => {
    shuttingDown = true;
    log.info("shutdown signal received, stopping workers", { signal, workers: alive });
    metricsServer.close();
    metricsServer.closeAllConnections();
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.process.kill("SIGTERM");
    }
  });
}

async function runWorker(): Promise<void> {
  const worker = cluster.worker;
  if (!worker) {
    throw new Error("runWorker() called outside a cluster worker");
  }
  const log = logger.child({ worker: worker.id });
  collectWorkerMetrics(worker.id);

  // The baseline experiments need Postgres; without DATABASE_URL the service still boots (probes only).
  const baselinePool = config.DATABASE_URL ? getPool() : undefined;

  // Redis needs a live connection to SCRIPT LOAD reserve.lua, so this is awaited before the listener
  // opens -- /redis/reserve should never be reachable without a sha behind it.
  let redisPool: RedisPool | undefined;
  let reserveScript: ReserveScript | undefined;
  if (config.REDIS_URL) {
    redisPool = getRedisPool();
    await redisPool.ready();
    reserveScript = await createReserveScript({ pool: redisPool, logger: log });
    log.info("reserve.lua loaded", { sha: reserveScript.sha, connections: redisPool.size });
  }

  startServer({
    port: config.PORT,
    logger: log,
    baselinePool,
    reserveScript,
    redisPool,
    closeClients: async () => {
      await Promise.all([baselinePool?.end(), redisPool?.quit()]);
    },
  });
}
