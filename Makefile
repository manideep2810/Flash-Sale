# Developer workflow for flash-sale. Recipes are POSIX sh.

# Windows: run recipes with Git for Windows' bash and coreutils (awk, rm, ...) so `make` behaves the
# same from PowerShell, cmd or Git Bash. Override GIT_USR_BIN if Git is installed somewhere else.
ifeq ($(OS),Windows_NT)
GIT_USR_BIN ?= C:/Program Files/Git/usr/bin
export PATH := $(GIT_USR_BIN);$(PATH)
SHELL := $(GIT_USR_BIN)/bash.exe
endif

# ---- Docker Compose ----------------------------------------------------------
COMPOSE_FILE         ?= infra/docker/docker-compose.yml
COMPOSE_PROJECT_NAME ?= flash-sale
DOCKER_COMPOSE       ?= docker compose -p $(COMPOSE_PROJECT_NAME) -f $(COMPOSE_FILE)
WAIT_TIMEOUT         ?= 120
LOG_TAIL             ?= 100
SERVICE              ?=

# ---- Postgres (must match the postgres service in COMPOSE_FILE) -------------
POSTGRES_USER     ?= app
POSTGRES_PASSWORD ?= app
POSTGRES_DB       ?= flashsale
POSTGRES_PORT     ?= 5434
DATABASE_URL_BASE := postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@localhost:$(POSTGRES_PORT)/$(POSTGRES_DB)
REDIS_URL         ?= redis://localhost:6380

# Every service with a Prisma schema. Each migrates into its own Postgres schema (named after the
# service) so their migration histories never collide in the shared database.
PRISMA_SERVICES := $(patsubst services/%/prisma/schema.prisma,%,$(wildcard services/*/prisma/schema.prisma))

# ---- Kafka (Redpanda) --------------------------------------------------------
# reservations.events, its DLQ and the payments.* topics are created by infra/kafka/topics.sh, which
# sets their partition counts; KAFKA_TOPICS is everything else, all at KAFKA_PARTITIONS.
KAFKA_TOPICS     ?= orders.events
KAFKA_PARTITIONS ?= 12
KAFKA_REPLICAS   ?= 1
TOPICS_SH        := COMPOSE_PROJECT_NAME=$(COMPOSE_PROJECT_NAME) COMPOSE_FILE=$(COMPOSE_FILE) \
	KAFKA_REPLICAS=$(KAFKA_REPLICAS) bash infra/kafka/topics.sh

PNPM ?= pnpm

# ---- Load testing (k6 -> Prometheus remote write -> Grafana) -----------------
K6                ?= k6
PROMETHEUS_RW_URL ?= http://localhost:9090/api/v1/write
VARIANT           ?=
TARGET_RPS        ?=
# Overrides the services' .env LOG_LEVEL when set (node --env-file never clobbers an existing variable).
# Per-request info logs written to a terminal block the event loop on Windows; load tests run at warn.
LOG_LEVEL         ?=

.DEFAULT_GOAL := help
.PHONY: help up down logs ps shell-db shell-redis topics migrate baseline-db seed test test-baseline test-order-db test-payment-db smoke-phase4 check-invariants loadtest-baseline test-watch lint typecheck check env dev dev-loadtest clean

help: ## List available targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Start the stack, block until every container is healthy, then create the reservation topics
	$(DOCKER_COMPOSE) up -d --wait --wait-timeout $(WAIT_TIMEOUT)
	$(TOPICS_SH)
	@echo "✓ Stack ready"

down: ## Stop the stack and delete its containers and volumes (wipes local data)
	$(DOCKER_COMPOSE) down -v --remove-orphans

logs: ## Follow stack logs; one service only with SERVICE=postgres|redis|redpanda|jaeger
	$(DOCKER_COMPOSE) logs -f --tail=$(LOG_TAIL) $(SERVICE)

ps: ## Show stack containers and their health
	$(DOCKER_COMPOSE) ps

shell-db: ## Open a psql shell in the postgres container
	$(DOCKER_COMPOSE) exec -e PGPASSWORD=$(POSTGRES_PASSWORD) postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

shell-redis: ## Open a redis-cli REPL in the redis container
	$(DOCKER_COMPOSE) exec redis redis-cli

topics: ## Create the Kafka topics in Redpanda (safe to re-run)
	$(TOPICS_SH)
	$(DOCKER_COMPOSE) exec -T redpanda rpk topic create $(KAFKA_TOPICS) \
		--partitions $(KAFKA_PARTITIONS) --replicas $(KAFKA_REPLICAS) --if-not-exists

migrate: ## prisma migrate dev for each service with a schema; NAME=add_x names the migration
	@$(DOCKER_COMPOSE) exec -T postgres pg_isready -q -U $(POSTGRES_USER) -d $(POSTGRES_DB) \
		|| { echo "postgres is not up - run 'make up' first" >&2; exit 1; }
	@for svc in $(PRISMA_SERVICES); do \
		echo "==> $$svc (postgres schema \"$$svc\")"; \
		DATABASE_URL="$(DATABASE_URL_BASE)?schema=$$svc" \
			$(PNPM) -C services/$$svc exec prisma migrate dev $(if $(NAME),--name $(NAME)) || exit 1; \
	done

baseline-db: ## Apply infra/sql/baseline.sql (baseline schema: inventory + holds) to the running postgres
	@$(DOCKER_COMPOSE) exec -T postgres pg_isready -q -U $(POSTGRES_USER) -d $(POSTGRES_DB) \
		|| { echo "postgres is not up - run 'make up' first" >&2; exit 1; }
	$(DOCKER_COMPOSE) exec -T -e PGPASSWORD=$(POSTGRES_PASSWORD) postgres \
		psql -v ON_ERROR_STOP=1 -U $(POSTGRES_USER) -d $(POSTGRES_DB) < infra/sql/baseline.sql

seed: ## Load seed data (placeholder - nothing to seed yet)
	@echo "seed: no seed data defined yet"

test: ## Run unit tests in every workspace
	$(PNPM) -r run test

test-baseline: ## Run the ticket baseline concurrency test against the local postgres (needs `make baseline-db`)
	DATABASE_URL="$(DATABASE_URL_BASE)" $(PNPM) -C services/ticket run test:baseline

test-order-db: ## Run the order payment-claim/timeout tests against a throwaway `order_test` schema in the local postgres
	DATABASE_URL="$(DATABASE_URL_BASE)?schema=order_test" REDIS_URL="$(REDIS_URL)" $(PNPM) -C services/order run test:db

test-payment-db: ## Run the payment-mock request-handling tests against a throwaway `payment_test` schema in the local postgres
	DATABASE_URL="$(DATABASE_URL_BASE)?schema=payment_test" $(PNPM) -C services/payment-mock run test:db

smoke-phase4: ## reserve -> pay -> wait for the payment -> check invariants (needs `make dev` and the stack up)
	$(PNPM) -C tools run smoke-phase4

check-invariants: ## Check the saga invariants (I1-I4) against the running stack: make check-invariants [EVENT=evt-001]
	$(PNPM) -C tools run check-invariants $(EVENT)

loadtest-baseline: ## k6 baseline run streamed to Prometheus/Grafana: VARIANT=redis TARGET_RPS=500 (service via `make dev-loadtest`)
	@[ -n "$(VARIANT)" ] && [ -n "$(TARGET_RPS)" ] \
		|| { echo "usage: make loadtest-baseline VARIANT=naive|pessimistic|atomic|optimistic|redis TARGET_RPS=500" >&2; \
		     echo "       start the service first with 'make dev-loadtest' (LOG_LEVEL=warn, no per-request logs)" >&2; exit 1; }
	VARIANT=$(VARIANT) TARGET_RPS=$(TARGET_RPS) \
	K6_PROMETHEUS_RW_SERVER_URL=$(PROMETHEUS_RW_URL) \
	K6_PROMETHEUS_RW_TREND_STATS="p(50),p(95),p(99),avg,max" \
	K6_PROMETHEUS_RW_STALE_MARKERS=true \
		$(K6) run -o experimental-prometheus-rw loadtest/baseline.js

test-watch: ## Run unit tests in watch mode in every workspace
	$(PNPM) -r --parallel run test --watch

lint: ## Biome lint + format check in every workspace
	$(PNPM) -r run lint

typecheck: ## Typecheck every workspace
	$(PNPM) -r run typecheck

check: ## Biome over the whole repo (root files included), then typecheck every workspace
	$(PNPM) run check

env: ## Create each services/<name>/.env from its .env.example (never overwrites an existing .env)
	@for example in services/*/.env.example; do \
		target="$${example%.example}"; \
		if [ -f "$$target" ]; then \
			echo "kept     $$target"; \
		else \
			cp "$$example" "$$target" && echo "created  $$target"; \
		fi; \
	done

dev: ## Run all services in watch mode (needs services/<name>/.env - run `make env` once); LOG_LEVEL=warn to override .env
	$(if $(LOG_LEVEL),LOG_LEVEL=$(LOG_LEVEL)) $(PNPM) -r --parallel --filter "./services/*" run dev

dev-loadtest: ## `make dev` with per-request logs dropped (LOG_LEVEL=warn) - use this while running k6
	$(MAKE) dev LOG_LEVEL=warn

clean: ## Delete node_modules, dist and .env files everywhere, plus the stack's containers and volumes
	-$(DOCKER_COMPOSE) down -v --remove-orphans
	rm -rf node_modules packages/*/node_modules services/*/node_modules packages/*/dist services/*/dist
	rm -f .env packages/*/.env services/*/.env
