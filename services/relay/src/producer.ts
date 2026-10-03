import { KafkaJS } from "@confluentinc/kafka-javascript";
import { config } from "./config.js";
import { eventsPublished, publishLatency } from "./metrics.js";

/** Created by infra/kafka/topics.sh. */
export const TOPIC = "reservations.events";

const PROBE_TIMEOUT_MS = 1_000;

// KAFKA_BROKERS is Redpanda locally. Redpanda speaks the Kafka protocol, so a Kafka client is its
// client; nothing below is specific to either broker.
const kafka = new KafkaJS.Kafka({ "bootstrap.servers": config.KAFKA_BROKERS });

const newClient = (): KafkaJS.Producer =>
  kafka.producer({
    // acks=all: send() resolves only once every in-sync replica has the batch, which is what makes
    // it safe for the loop to XACK straight after.
    acks: -1,
    // Retries cannot write a batch twice or out of order within a partition.
    "enable.idempotence": true,
    // Wait up to 5ms for more messages before sending, trading that latency for fuller batches.
    "linger.ms": 5,
  });

let client = newClient();
let admin: KafkaJS.Admin | undefined;
let replacing: Promise<void> | undefined;

async function open(): Promise<void> {
  await client.connect();
  // Shares the producer's connection; it exists for brokerReachable().
  const dependent = client.dependentAdmin();
  await dependent.connect();
  admin = dependent;
}

function isFatal(error: unknown): boolean {
  const { fatal, code } = error as { fatal?: boolean; code?: number };
  return fatal === true || code === KafkaJS.ErrorCodes.ERR__FATAL;
}

/**
 * An idempotent producer gives up for good once it can no longer guarantee ordering, which in
 * practice is a broker coming back without messages it had acknowledged (out-of-order sequence).
 * From then on every send() on that instance fails with a fatal error, so the instance is replaced.
 * Nothing is lost by it: the entries behind the failed send are still pending in Redis and the next
 * run() resends them.
 */
function replaceClient(): Promise<void> {
  replacing ??= (async () => {
    const dead = client;
    const deadAdmin = admin;
    admin = undefined;
    client = newClient();
    // Best effort and not awaited: a producer in a fatal state may never finish closing.
    deadAdmin?.disconnect().catch(() => {});
    dead.disconnect().catch(() => {});
    await open();
  })().finally(() => {
    replacing = undefined;
  });
  return replacing;
}

export const producer = {
  /** Resolves once a broker is reachable; while none is, it keeps retrying rather than rejecting. */
  connect: open,

  /** Flushes anything still queued, then closes. A no-op if connect() never completed. */
  async disconnect(): Promise<void> {
    if (!admin) {
      return;
    }
    const dependent = admin;
    admin = undefined;
    await dependent.disconnect();
    await client.disconnect();
  },

  /** Resolves when the broker has acknowledged every message in the record. */
  async send(record: KafkaJS.ProducerRecord): Promise<KafkaJS.RecordMetadata[]> {
    const startedAt = performance.now();
    let metadata: KafkaJS.RecordMetadata[];
    try {
      metadata = await client.send(record);
    } catch (error) {
      if (isFatal(error)) {
        await replaceClient();
      }
      throw error;
    }
    publishLatency.observe(performance.now() - startedAt);
    eventsPublished.inc(record.messages.length);
    return metadata;
  },
};

/** True when a metadata request to the broker comes back within a second. */
export async function brokerReachable(): Promise<boolean> {
  if (!admin) {
    return false;
  }
  try {
    await admin.listTopics({ timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * One stream entry as a Kafka message.
 *
 * Keyed by holdId, the reservation id, so a reservation's events all land on one partition (ADR
 * 0003). The value is the entry's own fields plus the stream and entry id it came from: together
 * those two are the id a consumer dedupes on, since the relay can deliver an entry more than once.
 */
export function toKafkaMessage(
  stream: string,
  entryId: string,
  fields: string[] | null,
): KafkaJS.Message {
  // Redis returns an entry's fields as a flat [name, value, name, value, ...] list.
  const entry: Record<string, string> = {};
  for (let i = 0; i + 1 < (fields?.length ?? 0); i += 2) {
    const name = fields?.[i];
    const value = fields?.[i + 1];
    if (name !== undefined && value !== undefined) {
      entry[name] = value;
    }
  }
  return {
    key: entry.holdId ?? null,
    value: JSON.stringify({ ...entry, stream, entryId }),
  };
}
