import { createServer, type Server } from "node:http";
import type { Logger } from "@flash/observability";
import { AggregatorRegistry, collectDefaultMetrics } from "prom-client";

/**
 * Worker side. Registers prom-client's Node process metrics (CPU, memory, event-loop lag, GC, active
 * handles, ...) on this worker's global registry, every series labelled `worker="<cluster id>"`, and
 * installs the IPC responder the primary's AggregatorRegistry pulls them through.
 *
 * The label is what keeps workers apart after aggregation: AggregatorRegistry merges series with
 * identical label sets (sum for counters, average/min/max for the lag gauges), so without it the
 * primary would expose one blended process instead of N.
 */
export function collectWorkerMetrics(workerId: number): void {
  // Constructing an AggregatorRegistry inside a worker is what wires up the process.on("message")
  // handler that answers the primary's getMetricsReq; the instance itself is not needed afterwards.
  new AggregatorRegistry();
  collectDefaultMetrics({ labels: { worker: String(workerId) } });
}

export interface MetricsServerOptions {
  port: number;
  logger: Logger;
}

/**
 * Primary side. GET /metrics asks every connected worker for its registry over IPC and returns the
 * merged exposition. Separate from PORT because the workers own that listener; the primary only
 * dispatches connections to them.
 */
export function startMetricsServer({ port, logger }: MetricsServerOptions): Server {
  const registry = new AggregatorRegistry();

  const server = createServer(async (req, res) => {
    const path = req.url?.split("?", 1)[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await registry.clusterMetrics();
      res.writeHead(200, { "content-type": registry.contentType }).end(body);
    } catch (error) {
      // clusterMetrics() rejects after 5s if a worker never answers (e.g. a blocked event loop).
      logger.error("metrics aggregation failed", error);
      res.writeHead(500).end();
    }
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info("metrics server started", { port });
  });

  return server;
}
