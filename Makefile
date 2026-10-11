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
COMPOSE_ENV          := $(dir $(COMPOSE_FILE)).env
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

# ---- The gateway's profiles ---------------------------------------------------
# The load profile is docker-compose.load.yml layered on the normal file: higher local buckets and
# no per-address limit, because a load run plays a whole crowd from one address.
LOAD_OVERRIDE    := infra/docker/docker-compose.load.yml
GATEWAY_SERVICES := envoy ratelimit
# Empties the rate limiter's counters, so windows counted under one profile do not carry into the other.
FLUSH_LIMITS     := $(DOCKER_COMPOSE) exec -T redis-ratelimit redis-cli flushall

# ---- Load testing (k6 -> Prometheus remote write -> Grafana) -----------------
K6                ?= k6
PROMETHEUS_RW_URL ?= http://localhost:9090/api/v1/write
VARIANT           ?=
TARGET_RPS        ?=
# Overrides the services' .env LOG_LEVEL when set (node --env-file never clobbers an existing variable).
# Per-request info logs written to a terminal block the event loop on Windows; load tests run at warn.
LOG_LEVEL         ?=

.DEFAULT_GOAL := help
.PHONY: help up down logs ps shell-db shell-redis topics migrate baseline-db seed test test-baseline test-order-db test-payment-db test-queue test-phase5 smoke-phase4 check-invariants loadtest-baseline test-watch lint typecheck check env dev dev-loadtest clean load-profile normal-profile load-small load-t1 load-soldout load-expiry load-restart bot-flood

help: ## List available targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# The gateway takes its two secrets from infra/docker/.env, which compose reads for every command.
$(COMPOSE_ENV): $(COMPOSE_ENV).example
	@if [ -f "$@" ]; then touch "$@"; else cp "$<" "$@" && echo "created  $@"; fi

up: $(COMPOSE_ENV) ## Start the stack, block until every container is healthy, then create the reservation topics
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

seed: ## Put a handful of demo events in the catalogue (needs `make dev` and `make migrate`); safe to re-run
	$(PNPM) -C tools run seed-events

test: ## Run unit tests in every workspace
	$(PNPM) -r run test

test-baseline: ## Run the ticket baseline concurrency test against the local postgres (needs `make baseline-db`)
	DATABASE_URL="$(DATABASE_URL_BASE)" $(PNPM) -C services/ticket run test:baseline

test-order-db: ## Run the order payment-claim/timeout tests against a throwaway `order_test` schema in the local postgres
	DATABASE_URL="$(DATABASE_URL_BASE)?schema=order_test" REDIS_URL="$(REDIS_URL)" $(PNPM) -C services/order run test:db

test-payment-db: ## Run the payment-mock request-handling tests against a throwaway `payment_test` schema in the local postgres
	DATABASE_URL="$(DATABASE_URL_BASE)?schema=payment_test" $(PNPM) -C services/payment-mock run test:db

test-queue: ## Run the waiting-room tests (queue-svc and the admitter) against the local redis
	REDIS_URL="$(REDIS_URL)" $(PNPM) -C services/queue run test

test-phase5: ## Waiting room and gateway end to end, through Envoy on :8080 with the test limits (needs `make up`; stop `make dev` first)
	$(PNPM) -C tests/e2e run test:phase5

smoke-phase4: ## reserve -> pay -> wait for the payment -> check invariants (needs `make dev` and the stack up)
	$(PNPM) -C tools run smoke-phase4

check-invariants: ## Check the saga invariants (I1-I4) against the running stack: make check-invariants [EVENT=evt-001]
	$(PNPM) -C tools run check-invariants $(EVENT)

load-profile: $(COMPOSE_ENV) ## Gateway on the LOAD limits: no per-address limit, higher local buckets (recreates envoy and ratelimit if they differ)
	$(DOCKER_COMPOSE) -f $(LOAD_OVERRIDE) up -d --wait --wait-timeout $(WAIT_TIMEOUT) $(GATEWAY_SERVICES)
	@$(FLUSH_LIMITS) > /dev/null
	@echo "✓ gateway on the LOAD profile (go back with: make normal-profile)"

normal-profile: $(COMPOSE_ENV) ## Gateway back on the normal limits (recreates envoy and ratelimit if they differ)
	$(DOCKER_COMPOSE) up -d --wait --wait-timeout $(WAIT_TIMEOUT) $(GATEWAY_SERVICES)
	@$(FLUSH_LIMITS) > /dev/null
	@echo "✓ gateway on the NORMAL profile"

# ---- Waiting-room load runs (tools/load, through the gateway) ------------------
# Each target seeds a fresh event, plays the crowd (tools/load/waiting-room-sim.ts), then judges the
# run (tools/check-queue-order.ts: admission order, conservation, the saga invariants). The services
# must be running with `make dev-loadtest`, NOT `make dev`: with per-request logs going to a
# terminal they answer a handful of requests a second, and the simulator refuses to start.
# They leave the gateway on the load profile; `make normal-profile` goes back.
#
# Every number is a variable: make load-t1 LOBBY_USERS=2000 JOIN_RATE=500 ADMIT_RATE=100
SIM   := $(PNPM) -C tools exec tsx load/waiting-room-sim.ts
CHECK := $(PNPM) -C tools exec tsx check-queue-order.ts
LOBBY_SEC     ?= 15
ADMIT_TTL_SEC ?= 120
NO_SHOW_PCT   ?= 10
FAIL_PCT      ?= 0
MAX_SOCKETS   ?= 256
SIM_FLAGS     ?=
# One shell command: the simulator with this target's numbers. $(1) is the run's label, and $$id
# (set by the recipe) its event id.
sim-run = $(SIM) --label $(1) --eventId $$id \
	--lobbyUsers $(LOBBY_USERS) --lobbySec $(LOBBY_SEC) \
	--joinRatePerSec $(JOIN_RATE) --joinDurationSec $(JOIN_SEC) \
	--admitRate $(ADMIT_RATE) --admitTtlSec $(ADMIT_TTL_SEC) --stock $(STOCK) \
	--noShowPct $(NO_SHOW_PCT) --failPct $(FAIL_PCT) \
	--maxRunSec $(MAX_RUN_SEC) --maxSockets $(MAX_SOCKETS) $(SIM_FLAGS)
run-id = $$(date +%m%d-%H%M%S)

load-small: LOBBY_USERS ?= 500
load-small: JOIN_RATE   ?= 250
load-small: JOIN_SEC    ?= 20
load-small: ADMIT_RATE  ?= 50
load-small: STOCK       ?= 100000
load-small: MAX_RUN_SEC ?= 300
load-small: load-profile ## Small load run: lobby 500, then 250 joins/s for 20s against 50 admitted/s, 100,000 tickets; then the order check
	@id=load-small-$(run-id); $(call sim-run,small) && $(CHECK) --eventId $$id

load-t1: LOBBY_USERS ?= 10000
load-t1: LOBBY_SEC   := 30
load-t1: JOIN_RATE   ?= 2500
load-t1: JOIN_SEC    ?= 30
load-t1: ADMIT_RATE  ?= 500
load-t1: STOCK       ?= 20000
load-t1: MAX_RUN_SEC ?= 600
load-t1: MAX_SOCKETS := 512
load-t1: load-profile ## Full-size run T1: lobby 10,000, then 2,500 joins/s for 30s against 500 admitted/s, 20,000 tickets (scale it: LOBBY_USERS= JOIN_RATE= ADMIT_RATE= STOCK=)
	@id=load-t1-$(run-id); $(call sim-run,t1) && $(CHECK) --eventId $$id

load-soldout: LOBBY_USERS ?= 1000
load-soldout: JOIN_RATE   ?= 400
load-soldout: JOIN_SEC    ?= 10
load-soldout: ADMIT_RATE  ?= 100
load-soldout: STOCK       ?= 500
load-soldout: MAX_RUN_SEC ?= 300
load-soldout: load-profile ## Sell-out run: 5,000 users for 500 tickets. Expect PAUSED, then SOLD_OUT, and the polling to stop
	@id=load-soldout-$(run-id); $(call sim-run,soldout) && $(CHECK) --eventId $$id

load-expiry: LOBBY_USERS   ?= 200
load-expiry: JOIN_RATE     ?= 100
load-expiry: JOIN_SEC      ?= 10
load-expiry: ADMIT_RATE    ?= 50
load-expiry: STOCK         ?= 100000
load-expiry: ADMIT_TTL_SEC := 10
load-expiry: NO_SHOW_PCT   := 50
load-expiry: MAX_RUN_SEC   ?= 300
load-expiry: SIM_FLAGS     := --rejoinAfterExpiry true
load-expiry: load-profile ## Expiry run: a 10s turn and half the users walking away. Expect EXPIRED, and rejoins at the back of the line
	@id=load-expiry-$(run-id); $(call sim-run,expiry) && $(CHECK) --eventId $$id

# The admitter is killed this long after the sale opens, and stays down this long.
RESTART_AT_SEC   ?= 10
RESTART_DOWN_SEC ?= 8
load-restart: LOBBY_USERS ?= 500
load-restart: JOIN_RATE   ?= 250
load-restart: JOIN_SEC    ?= 20
load-restart: ADMIT_RATE  ?= 50
load-restart: STOCK       ?= 100000
load-restart: MAX_RUN_SEC ?= 300
load-restart: load-profile ## load-small with the admitter killed 10s after the sale opens and restarted 8s later (tools/chaos/restart-admitter.sh); the order check must still pass
	@id=load-restart-$(run-id); \
	bash tools/chaos/restart-admitter.sh --after $$(( $(LOBBY_SEC) + $(RESTART_AT_SEC) + 2 )) --down $(RESTART_DOWN_SEC) & chaos=$$!; \
	$(call sim-run,restart); status=$$?; \
	if [ $$status -ne 0 ]; then kill $$chaos 2> /dev/null; exit $$status; fi; \
	wait $$chaos; $(CHECK) --eventId $$id

BOT_RATE ?= 10000
BOT_SEC  ?= 60
bot-flood: normal-profile ## Bot flood against the NORMAL limits: k6, 10,000 req/s for 60s of tokenless, forged and stolen-token reserves and a join flood, then a verdict (BOT_RATE= BOT_SEC=)
	$(PNPM) -C tools exec tsx load/bot-flood.ts --totalRate $(BOT_RATE) --durationSec $(BOT_SEC)

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

env: ## Create each services/<name>/.env and infra/docker/.env from its .env.example (never overwrites an existing .env)
	@for example in services/*/.env.example $(COMPOSE_ENV).example; do \
		target="$${example%.example}"; \
		if [ -f "$$target" ]; then \
			echo "kept     $$target"; \
		else \
			cp "$$example" "$$target" && echo "created  $$target"; \
		fi; \
	done

dev: ## Run all services and the web app in watch mode (needs services/<name>/.env - run `make env` once); LOG_LEVEL=warn to override .env
	$(if $(LOG_LEVEL),LOG_LEVEL=$(LOG_LEVEL)) $(PNPM) -r --parallel --filter "./services/*" --filter "./web" run dev

dev-loadtest: ## `make dev` with per-request logs dropped (LOG_LEVEL=warn) - use this while running k6
	$(MAKE) dev LOG_LEVEL=warn

clean: ## Delete node_modules, dist and .env files everywhere, plus the stack's containers and volumes
	-$(DOCKER_COMPOSE) down -v --remove-orphans
	rm -rf node_modules packages/*/node_modules services/*/node_modules packages/*/dist services/*/dist
	rm -f .env packages/*/.env services/*/.env
