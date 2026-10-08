#!/usr/bin/env bash
#
# infra/kafka/topics.sh -- create the reservation and payment topics in the local Redpanda.
#
#   bash infra/kafka/topics.sh                   # also run by `make up` once the stack is healthy
#   KAFKA_REPLICAS=3 bash infra/kafka/topics.sh
#
#   reservations.events        12 partitions   relay -> order service, keyed by reservationId
#   reservations.events.dlq     3 partitions   messages the order consumer gave up on
#   payments.commands          80 partitions   order -> payment: PaymentRequested, keyed by orderId
#   payments.events            12 partitions   payment -> order: PaymentProcessed, keyed by orderId
#   orders.events              12 partitions   order service outcomes (OrderExpired, OrderPaid, ...), keyed by orderId
#
# Safe to re-run: a topic that already exists is left alone, which also means editing a partition
# count here does not change a topic that is already there. Replication factor defaults to 1 because
# the local stack is a single broker.

set -euo pipefail

KAFKA_REPLICAS="${KAFKA_REPLICAS:-1}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.yml}"
# Must match the Makefile, which passes `-p flash-sale`. Without it Compose derives the project name
# from the compose file's parent directory ("docker") and looks at a different stack entirely.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-flash-sale}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")

# name:partitions
TOPICS=(
  "reservations.events:12"
  "reservations.events.dlq:3"
  "payments.commands:80"
  "payments.events:12"
  "orders.events:12"
)

for topic in "${TOPICS[@]}"; do
  name="${topic%%:*}"
  partitions="${topic##*:}"
  "${COMPOSE[@]}" exec -T redpanda rpk topic create "$name" \
    --partitions "$partitions" --replicas "$KAFKA_REPLICAS" --if-not-exists
  # The local broker runs in dev-container mode, where write caching is on: a produce is acknowledged
  # while the message is still in the broker's memory, so killing the broker loses messages it has
  # already acknowledged. The relay acks Redis on that acknowledgement, so those would be gone for
  # good. Off for these topics; set separately from create so it also reaches a topic that exists.
  "${COMPOSE[@]}" exec -T redpanda rpk topic alter-config "$name" --set write.caching=false
done
