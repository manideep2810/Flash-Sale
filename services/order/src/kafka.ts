import { KafkaJS } from "@confluentinc/kafka-javascript";
import { config } from "./config.js";

// KAFKA_BROKERS is Redpanda locally. Redpanda speaks the Kafka protocol, so a Kafka client is its
// client; the consumer and the DLQ producer are both built from this.
export const kafka = new KafkaJS.Kafka({ "bootstrap.servers": config.KAFKA_BROKERS });
