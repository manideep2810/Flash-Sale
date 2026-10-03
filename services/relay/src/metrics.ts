import { Counter, Gauge, Histogram } from "prom-client";
import { auxRedis } from "./redis.js";
import { activeStreams, GROUP } from "./streams.js";

// All four register on prom-client's default registry, which GET /metrics in server.ts serves.

/** Incremented by producer.send() once the broker has acknowledged a batch. */
export const eventsPublished = new Counter({
  name: "relay_events_published_total",
  help: "Stream entries published to reservations.events and acknowledged by the broker.",
});

/** Observed by producer.send(), one sample per batch. */
export const publishLatency = new Histogram({
  name: "relay_publish_latency_ms",
  help: "Time for one producer.send() batch to be acknowledged by the broker, in milliseconds.",
  // linger.ms=5 puts a floor of a few milliseconds under every batch.
  buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
});

/**
 * A gauge with one series per active stream, read from Redis at scrape time rather than on a timer.
 * A stream that cannot be read (Redis away, group not created yet) is left out of that scrape instead
 * of failing it, so the counter and histogram above still export.
 */
function perStreamGauge(
  name: string,
  help: string,
  read: (stream: string) => Promise<number>,
): Gauge<"stream"> {
  return new Gauge({
    name,
    help,
    labelNames: ["stream"],
    async collect() {
      this.reset();
      const streams = await activeStreams().catch(() => []);
      await Promise.all(
        streams.map(async (stream) => {
          try {
            this.set({ stream }, await read(stream));
          } catch {
            // Left out of this scrape.
          }
        }),
      );
    },
  });
}

export const streamLength = perStreamGauge(
  "relay_stream_length",
  "Entries currently in each active reservation stream (XLEN).",
  (stream) => auxRedis.xlen(stream),
);

export const pendingEntries = perStreamGauge(
  "relay_pending_entries",
  "Entries delivered to the relay group and not yet acked, per stream (XPENDING).",
  async (stream) => {
    const [count] = (await auxRedis.xpending(stream, GROUP)) as [number, ...unknown[]];
    return count;
  },
);
