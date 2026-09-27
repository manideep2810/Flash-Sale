import { Kafka, type KafkaConfig, logLevel } from "kafkajs";

/** KafkaJS client with repo-wide defaults; callers own their producer/consumer lifecycles. */
export function createKafka(config: KafkaConfig): Kafka {
  return new Kafka({ logLevel: logLevel.WARN, ...config });
}
