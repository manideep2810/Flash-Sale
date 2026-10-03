#!/usr/bin/env bash
#
# infra/redis/init.sh -- seed one flash-sale event into Redis for the /redis/reserve hot path.
#
#   bash infra/redis/init.sh                                  # evt-001, 1,000,000 tickets
#   EVENT_ID=evt-002 TOTAL=50000 bash infra/redis/init.sh
#   REDIS_URL=redis://staging:6380 FORCE=1 bash infra/redis/init.sh
#
# Key names must match reserveKeys() in services/ticket/src/redis/index.ts exactly, or the hot path
# reads a missing key and every reserve returns 409 SOLD_OUT. They are untagged, which is correct for a
# standalone Redis or a Sentinel set; Redis Cluster would need a shared hash tag in both places.
#
# For load testing, prefer POST /redis/reset on the running service -- it resets one event in a single
# MULTI without touching the rest of the keyspace. This script is for first-time seeding and for when
# the service is not up, and it FLUSHALLs, which wipes the whole database. That runs unprompted only
# against a local Redis; any other host needs FORCE=1.

set -euo pipefail

EVENT_ID="${EVENT_ID:-evt-001}"
TOTAL="${TOTAL:-1000000}"
REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.yml}"
# Must match the Makefile, which passes `-p flash-sale`. Without it Compose derives the project name
# from the compose file's parent directory ("docker") and looks at a different stack entirely.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-flash-sale}"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE")

AVAIL_KEY="ev:${EVENT_ID}:avail"
TOTAL_KEY="ev:${EVENT_ID}:total"
HOLDS_KEY="ev:${EVENT_ID}:holds"
STREAM_KEY="ev:${EVENT_ID}:stream"

# ---- pick a redis-cli -------------------------------------------------------------------------
# A host redis-cli is preferred; otherwise fall back to the one inside the compose container, which
# is the usual case on Windows. The container reaches Redis on its own localhost:6379, so the URL is
# only passed to a host client.
if [ -n "${REDIS_CLI:-}" ]; then
  # shellcheck disable=SC2086
  redis() { $REDIS_CLI "$@"; }
  TARGET="\$REDIS_CLI"
elif command -v redis-cli > /dev/null 2>&1; then
  redis() { redis-cli -u "$REDIS_URL" "$@"; }
  TARGET="$REDIS_URL"
elif "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx redis; then
  redis() { "${COMPOSE[@]}" exec -T redis redis-cli "$@"; }
  TARGET="compose service 'redis' (project $COMPOSE_PROJECT_NAME)"
else
  echo "error: no redis-cli on PATH, and no running 'redis' service in compose project" >&2
  echo "       '$COMPOSE_PROJECT_NAME' ($COMPOSE_FILE). Start it with 'make up', or set" >&2
  echo "       COMPOSE_PROJECT_NAME if your stack runs under another name, or point REDIS_CLI" >&2
  echo "       at a client of your own." >&2
  echo >&2
  echo "       running compose projects:" >&2
  docker ps --format '         {{.Label "com.docker.compose.project"}}/{{.Label "com.docker.compose.service"}}' \
    2>/dev/null | grep -v '^ *//*$' | sort -u >&2 || true
  exit 1
fi

# ---- guard the FLUSHALL -----------------------------------------------------------------------
host="${REDIS_URL#*://}"
host="${host%%/*}"
host="${host%%\?*}"
host="${host##*@}"
host="${host%%:*}"

case "$host" in
  localhost | 127.0.0.1 | ::1 | redis | "") ;;
  *)
    if [ "${FORCE:-0}" != "1" ]; then
      echo "error: refusing to FLUSHALL a non-local Redis ('$host'). Set FORCE=1 to override." >&2
      exit 1
    fi
    echo "warning: FLUSHALL against non-local host '$host' (FORCE=1)" >&2
    ;;
esac

if ! redis PING > /dev/null 2>&1; then
  echo "error: cannot reach Redis via $TARGET" >&2
  exit 1
fi

echo "target   : $TARGET"
echo "event    : $EVENT_ID  ($TOTAL tickets)"

# ---- seed -------------------------------------------------------------------------------------
redis FLUSHALL > /dev/null

redis SET "$AVAIL_KEY" "$TOTAL" > /dev/null
redis SET "$TOTAL_KEY" "$TOTAL" > /dev/null

# An empty stream is creatable: XADD makes the key, then MAXLEN 0 trims the entry straight back out,
# leaving a real stream with XLEN 0 so the relay can XREAD it before the first reserve lands. The
# stream's last-generated-id is advanced by the discarded entry, which matters to nothing here.
redis XADD "$STREAM_KEY" MAXLEN 0 '*' init 1 > /dev/null

# The holds ZSET is deliberately NOT created. Redis has no empty collections -- a sorted set ceases to
# exist the moment its last member is removed -- so there is nothing to create; reserve.lua's first
# ZADD brings it into being. It is asserted absent below rather than pretended into existence.

# ---- verify -----------------------------------------------------------------------------------
avail="$(redis GET "$AVAIL_KEY")"
total="$(redis GET "$TOTAL_KEY")"
stream_type="$(redis TYPE "$STREAM_KEY")"
stream_len="$(redis XLEN "$STREAM_KEY")"
holds_exists="$(redis EXISTS "$HOLDS_KEY")"

fail=0
[ "$avail" = "$TOTAL" ] || { echo "error: $AVAIL_KEY is '$avail', expected '$TOTAL'" >&2; fail=1; }
[ "$total" = "$TOTAL" ] || { echo "error: $TOTAL_KEY is '$total', expected '$TOTAL'" >&2; fail=1; }
[ "$stream_type" = "stream" ] || { echo "error: $STREAM_KEY is type '$stream_type'" >&2; fail=1; }
[ "$stream_len" = "0" ] || { echo "error: $STREAM_KEY has $stream_len entries, expected 0" >&2; fail=1; }
[ "$holds_exists" = "0" ] || { echo "error: $HOLDS_KEY already exists after FLUSHALL" >&2; fail=1; }
[ "$fail" -eq 0 ] || exit 1

printf '  %-28s %s\n' "$AVAIL_KEY" "$avail"
printf '  %-28s %s\n' "$TOTAL_KEY" "$total"
printf '  %-28s %s, %s entries\n' "$STREAM_KEY" "$stream_type" "$stream_len"
printf '  %-28s %s\n' "$HOLDS_KEY" "absent until the first reserve (Redis has no empty ZSET)"

echo "Redis initialized"
