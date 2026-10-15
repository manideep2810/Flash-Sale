#!/usr/bin/env bash
#
# scripts/deploy.sh -- build and (re)start the production stack on this machine (docs/deploy-vm.md).
#
#   bash scripts/deploy.sh              first deploy, and every update after it
#   bash scripts/deploy.sh --reseed     also run the demo seed again (moves the sale times to now)
#   bash scripts/deploy.sh --no-pull    deploy the checkout as it is, without git pull
#
#   ENV_FILE=/path/to/env bash scripts/deploy.sh     another env file than ./.env
#
# Exits non-zero at the first step that fails.

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"
# The project name docker-compose.prod.yml gives itself. topics.sh needs it spelled out.
PROJECT=flash-sale-prod
COMPOSE=(docker compose --env-file "$ENV_FILE" -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.prod.yml)
SEED_EVENT=aurora-sound-festival

RESEED=0
PULL=1
for arg in "$@"; do
  case "$arg" in
    --reseed) RESEED=1 ;;
    --no-pull) PULL=0 ;;
    *) echo "unknown option: $arg (use --reseed, --no-pull)" >&2; exit 2 ;;
  esac
done

step() { printf '\n=== %s ===\n' "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
# The value of one variable in ENV_FILE: the last assignment wins, as in compose; quotes and a
# Windows line ending are dropped.
env_get() {
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}
# Prints the state of every container and the last log lines of the ones that are not healthy.
show_trouble() {
  "${COMPOSE[@]}" ps -a || true
  for svc in $("${COMPOSE[@]}" ps -a --format '{{.Service}} {{.Health}} {{.State}}' \
    | awk '$2 == "unhealthy" || $NF == "restarting" || $NF == "exited" { print $1 }'); do
    echo "--- last log lines of $svc ---"
    "${COMPOSE[@]}" logs --tail 30 "$svc" || true
  done
}

step "1/9 Check $ENV_FILE and the tools"
for tool in docker git curl jq; do
  command -v "$tool" > /dev/null || fail "$tool is not installed (jq: sudo apt install -y jq)"
done
compose_version=$(docker compose version --short | sed 's/^v//')
[ "$(printf '%s\n' 2.24.4 "$compose_version" | sort -V | head -n 1)" = 2.24.4 ] \
  || fail "Docker Compose $compose_version is too old: the prod file needs 2.24.4 or later"
[ -f "$ENV_FILE" ] || fail "$ENV_FILE does not exist: cp .env.example .env, then fill it in"
for var in SESSION_SECRET ADMISSION_SECRET POSTGRES_PASSWORD ADMIN_PASSWORD GRAFANA_ADMIN_PASSWORD; do
  value=$(env_get "$var")
  [ -n "$value" ] || fail "$var is missing from $ENV_FILE (see .env.example)"
  case "$value" in
    *change-me* | *generate-with-openssl* | local-dev-only*)
      fail "$var in $ENV_FILE is still a placeholder or a dev value" ;;
  esac
done
for var in SESSION_SECRET ADMISSION_SECRET; do
  [ "$(env_get "$var" | wc -c)" -gt 32 ] || fail "$var must be at least 32 characters (openssl rand -base64 48)"
done
[[ "$(env_get POSTGRES_PASSWORD)" =~ ^[A-Za-z0-9]+$ ]] \
  || fail "POSTGRES_PASSWORD must be letters and digits only, it goes inside a URL (openssl rand -hex 24)"
[ "$(env_get ADMIN_PASSWORD | wc -c)" -gt 8 ] || fail "ADMIN_PASSWORD must be at least 8 characters"
echo "OK: $ENV_FILE has every variable; Docker Compose $compose_version"

step "2/9 git pull --ff-only"
if [ "$PULL" -eq 1 ]; then
  before=$(git rev-parse HEAD)
  git pull --ff-only
  # bash reads this script as it runs; if the pull changed it, carry on with the new version.
  if [ "$(git rev-parse HEAD)" != "$before" ]; then
    echo "pulled $(git rev-parse --short "$before")..$(git rev-parse --short HEAD); restarting the script"
    exec bash scripts/deploy.sh --no-pull "$@"
  fi
else
  echo "skipped (--no-pull)"
fi

step "3/9 Build the app image"
"${COMPOSE[@]}" build

# Migrations must run before the new code starts, and the topics must exist before the consumers
# subscribe, so the infrastructure comes up first and the app services after both.
step "4/9 Start the infrastructure and create the Kafka topics"
"${COMPOSE[@]}" up -d --wait --wait-timeout "$WAIT_TIMEOUT" postgres redis redis-ratelimit redpanda \
  || { show_trouble; fail "the infrastructure did not become healthy within ${WAIT_TIMEOUT}s"; }
# topics.sh execs rpk in the redpanda container. It loads docker-compose.yml alone, whose
# interpolation needs the two secrets; they are passed from ENV_FILE.
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_FILE=infra/docker/docker-compose.yml \
  SESSION_SECRET="$(env_get SESSION_SECRET)" ADMISSION_SECRET="$(env_get ADMISSION_SECRET)" \
  bash infra/kafka/topics.sh

step "5/9 Run the database migrations (prisma migrate deploy)"
"${COMPOSE[@]}" run --rm migrate

step "6/9 Start everything and wait for the health checks (${WAIT_TIMEOUT}s)"
"${COMPOSE[@]}" up -d --wait --wait-timeout "$WAIT_TIMEOUT" --remove-orphans \
  || { show_trouble; fail "not every service became healthy within ${WAIT_TIMEOUT}s"; }

step "7/9 Seed the demo events"
seeded=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost/api/events/$SEED_EVENT" || true)
if [ "$seeded" = 200 ] && [ "$RESEED" -eq 0 ]; then
  echo "already seeded ($SEED_EVENT exists); --reseed runs it again"
else
  "${COMPOSE[@]}" run --rm seed
fi

step "8/9 Containers"
"${COMPOSE[@]}" ps

step "9/9 Smoke test"
EVENT_ID="$SEED_EVENT" bash scripts/smoke-prod.sh

printf '\nDEPLOYED\n'
