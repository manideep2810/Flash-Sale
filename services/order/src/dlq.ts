import { setTimeout as sleep } from "node:timers/promises";
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import { kafka } from "./kafka.js";

/** Created by infra/kafka/topics.sh. */
export const DLQ_TOPIC = "reservations.events.dlq";

const MAX_RETRIES = 3;
/** Doubles each retry: 100ms, 200ms, 400ms. */
const BACKOFF_BASE_MS = 100;

const producer = kafka.producer({
  // The consumer commits the source offset as soon as send() resolves, so that has to mean the
  // message is safely in the DLQ.
  acks: -1,
  "enable.idempotence": true,
});

export type Attempted<T> = { ok: true; value: T } | { ok: false; error: unknown; attempts: number };

/**
 * Runs `task`, and if it throws runs it again up to three more times, backing off in between.
 * Never throws: the last error comes back as a value for the caller to dead-letter.
 */
export async function withRetries<T>(task: () => Promise<T>): Promise<Attempted<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await task() };
    } catch (error) {
      if (attempt > MAX_RETRIES) {
        return { ok: false, error, attempts: attempt };
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

export interface FailedMessage {
  topic: string;
  partition: number;
  message: KafkaJS.KafkaMessage;
}

/**
 * Publishes the message to the DLQ byte for byte, with what went wrong and where it came from in
 * headers. Resolves once the broker has it; throws if it cannot be published.
 */
export async function deadLetter(
  { topic, partition, message }: FailedMessage,
  error: unknown,
  attempts: number,
): Promise<void> {
  const failure = error instanceof Error ? error : new Error(String(error));
  await producer.send({
    topic: DLQ_TOPIC,
    messages: [
      {
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          "x-error-name": failure.name,
          "x-error-message": failure.message,
          "x-attempts": String(attempts),
          "x-original-topic": topic,
          "x-original-partition": String(partition),
          "x-original-offset": message.offset,
        },
      },
    ],
  });
}

export const dlqProducer = {
  connect: (): Promise<void> => producer.connect(),
  disconnect: (): Promise<void> => producer.disconnect(),
};
