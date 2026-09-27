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

# Every service with a Prisma schema. Each migrates into its own Postgres schema (named after the
# service) so their migration histories never collide in the shared database.
PRISMA_SERVICES := $(patsubst services/%/prisma/schema.prisma,%,$(wildcard services/*/prisma/schema.prisma))

# ---- Kafka (Redpanda) --------------------------------------------------------
KAFKA_TOPICS     ?= reservations.events payments.events orders.events
KAFKA_PARTITIONS ?= 12
KAFKA_REPLICAS   ?= 1

PNPM ?= pnpm

.DEFAULT_GOAL := help
.PHONY: help up down logs ps shell-db shell-redis topics migrate seed test test-watch lint typecheck check dev clean

help: ## List available targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Start the stack and block until every container is healthy
	$(DOCKER_COMPOSE) up -d --wait --wait-timeout $(WAIT_TIMEOUT)
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

seed: ## Load seed data (placeholder - nothing to seed yet)
	@echo "seed: no seed data defined yet"

test: ## Run unit tests in every workspace
	$(PNPM) -r run test

test-watch: ## Run unit tests in watch mode in every workspace
	$(PNPM) -r --parallel run test --watch

lint: ## Biome lint + format check in every workspace
	$(PNPM) -r run lint

typecheck: ## Typecheck every workspace
	$(PNPM) -r run typecheck

check: ## Biome over the whole repo (root files included), then typecheck every workspace
	$(PNPM) run check

dev: ## Run all services in watch mode (ticket :3001, relay :3002, order :3003, payment-mock :3004, queue :3005)
	$(PNPM) -r --parallel --filter "./services/*" run dev

clean: ## Delete node_modules, dist and .env files everywhere, plus the stack's containers and volumes
	-$(DOCKER_COMPOSE) down -v --remove-orphans
	rm -rf node_modules packages/*/node_modules services/*/node_modules packages/*/dist services/*/dist
	rm -f .env packages/*/.env services/*/.env
