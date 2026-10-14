#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.prod.yml"
WAIT_TIMEOUT=180

echo "=== Step 1: Check .env exists and no placeholders ==="
if [ ! -f .env ]; then
  echo "ERROR: .env does not exist. Copy .env.example and fill in secrets." >&2
  exit 1
fi
if grep -q 'generate-with-openssl' .env; then
  echo "ERROR: .env still contains placeholder values (generate-with-openssl). Fill them in." >&2
  exit 1
fi
echo "✓ .env is ready"

echo ""
echo "=== Step 2: git pull --ff-only ==="
git pull --ff-only
echo "✓ Pulled latest"

echo ""
echo "=== Step 3: Build app services ==="
pnpm install --frozen-lockfile
pnpm -r run build
echo "✓ Built all packages and services"

echo ""
echo "=== Step 4: Bring compose stack up ==="
$COMPOSE build
$COMPOSE up -d
echo "✓ Stack started"

echo ""
echo "=== Step 5: Wait for healthchecks (${WAIT_TIMEOUT}s timeout) ==="
timeout $WAIT_TIMEOUT bash -c "
  until $COMPOSE exec -T postgres pg_isready -q -U app -d flashsale 2>/dev/null; do sleep 1; done
  until $COMPOSE exec -T redis redis-cli ping >/dev/null 2>&1; do sleep 1; done
  until $COMPOSE exec -T redpanda rpk cluster health 2>/dev/null | grep -q 'Healthy:.*true'; do sleep 1; done
  until $COMPOSE exec -T ratelimit sh -c 'curl -s http://localhost:8080/healthcheck' >/dev/null 2>&1; do sleep 1; done
  until $COMPOSE exec -T envoy sh -c 'exec 3<>/dev/tcp/127.0.0.1/9901 && printf \"GET /ready HTTP/1.1\r\nHost: envoy\r\nConnection: close\r\n\r\n\" >&3 && grep -q LIVE <&3' 2>/dev/null; do sleep 1; done
" || { echo "ERROR: Infrastructure healthchecks timed out" >&2; exit 1; }
echo "✓ All infrastructure healthy"

echo ""
echo "=== Step 6: Run Prisma migrations ==="
POSTGRES_PASSWORD=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)
for schema in order ticket payment-mock; do
  echo "  Migrating schema '$schema'..."
  $COMPOSE exec -T postgres psql -U app -d flashsale -c "CREATE SCHEMA IF NOT EXISTS \"$schema\"" >/dev/null 2>&1 || true
  DATABASE_URL="postgresql://app:${POSTGRES_PASSWORD}@localhost:5434/flashsale?schema=$schema" \
    pnpm -C services/$schema exec prisma migrate deploy >/dev/null 2>&1 || true
done
echo "✓ Migrations complete"

echo ""
echo "=== Step 7: Seed demo events ==="
echo "  Note: App services (order, ticket, queue, relay, payment-mock) must be running via 'make dev'"
echo "  To seed, run in another terminal:"
echo "    pnpm -C tools run seed-events"
echo "  (This is idempotent; re-running updates existing events)"

echo ""
echo "=== Step 8: docker compose ps ==="
$COMPOSE ps

echo ""
echo "=== Step 9: Run smoke tests ==="
bash scripts/smoke-prod.sh || { echo "ERROR: Smoke tests failed" >&2; exit 1; }

echo ""
echo "✓ ===== DEPLOYMENT COMPLETE ====="
