import { Gauge } from "prom-client";

export const kafkaConsumerLag = new Gauge({
  name: "kafka_consumer_lag",
  help: "Messages a consumer group has not committed yet, per topic and partition (from librdkafka statistics).",
  labelNames: ["group", "topic", "partition"],
});

interface PartitionStats {
  consumer_lag: number;
  fetch_state: string;
  hi_offset: number;
  lo_offset: number;
}

/** Lag for one partition, or undefined when it is not this consumer's to report. */
function partitionLag(p: PartitionStats): number | undefined {
  if (p.consumer_lag >= 0) {
    return p.consumer_lag;
  }
  // -1 until the group has committed on the partition; it starts from the oldest message, so
  // everything in a partition it is fetching is still ahead of it.
  if (p.fetch_state === "active" && p.hi_offset >= 0) {
    return p.hi_offset - Math.max(p.lo_offset, 0);
  }
  return undefined;
}

export const STATS_INTERVAL_MS = 5_000;

/**
 * A `stats_cb` for a consumer config that feeds kafka_consumer_lag from the statistics librdkafka
 * already emits (no request to the broker; see the note in consumer.ts on why not the admin API).
 */
export function lagStatsCallback(group: string): (stats: { message: string }) => void {
  // Several consumers share the gauge, so each one clears only its own series between statistics.
  let previous: { topic: string; partition: string }[] = [];
  return (stats) => {
    const parsed = JSON.parse(stats.message) as {
      topics?: Record<string, { partitions?: Record<string, PartitionStats> }>;
    };
    for (const labels of previous) {
      kafkaConsumerLag.remove({ group, ...labels });
    }
    previous = [];
    for (const [topic, t] of Object.entries(parsed.topics ?? {})) {
      for (const [partition, p] of Object.entries(t.partitions ?? {})) {
        const lag = partitionLag(p);
        if (lag !== undefined) {
          kafkaConsumerLag.set({ group, topic, partition }, lag);
          previous.push({ topic, partition });
        }
      }
    }
  };
}
