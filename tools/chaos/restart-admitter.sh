#!/usr/bin/env bash
# Chaos helper: kills the queue admitter in the middle of a run, leaves it down for a while and
# starts it again, marking both moments on the Grafana dashboards.
#
#   tools/chaos/restart-admitter.sh [--after SEC] [--down SEC]
#   make load-restart            (a small load run with this fired ten seconds after the sale opens)
#
#   --after SEC   wait this long before killing it (default 0)
#   --down SEC    how long it stays down (default 5)
#
# What it shows: while the admitter is down nobody is admitted, the queue only grows, and joins and
# status calls keep being answered (queue-svc is another process). When it is back, admissions
# resume at the configured rate, after at most one second's worth in a burst, and nobody was lost:
# tools/check-queue-order.ts must still pass.
#
# The admitter is not a container here. It runs on the host with the other services (`make dev`),
# so there is no `docker compose restart` to call. Instead:
#   stop    the process listening on ADMITTER_PORT is killed outright (no graceful shutdown: the
#           harsher case, and the one a crash would be).
#   start   under `make dev` each service runs in tsx's watch mode, which starts a program again
#           when one of its files changes. So the admitter's entry file is touched (its modification
#           time only; the content is not changed) and watch mode brings it back in the same
#           terminal. If nothing is listening after 15 seconds (the admitter was not running in
#           watch mode), it is started here instead, in the background, logging to
#           loadtest/results/phase5/admitter-restart.log. That one is NOT under `make dev`: it has
#           to be stopped by hand afterwards (the script prints its pid).
#
# Environment:
#   ADMITTER_PORT   default 3011
#   GRAFANA_URL     default http://localhost:3000
#   GRAFANA_AUTH    user:password for the annotations API, default admin:admin (the local stack's)
set -euo pipefail

AFTER=0
DOWN=5
while [ $# -gt 0 ]; do
  case "$1" in
    --after) AFTER="$2"; shift 2 ;;
    --down) DOWN="$2"; shift 2 ;;
    -h | --help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${ADMITTER_PORT:-3011}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_AUTH="${GRAFANA_AUTH:-admin:admin}"
ENTRY="$ROOT/services/queue/src/admitter/main.ts"
HEALTH="http://127.0.0.1:$PORT/healthz"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) WINDOWS=1 ;;
  *) WINDOWS=0 ;;
esac

now_ms() {
  # GNU date has %N; where it does not (macOS), whole seconds are close enough for a dashboard.
  local ms
  ms="$(date +%s%3N 2>/dev/null)"
  case "$ms" in
    *N* | "") echo "$(($(date +%s) * 1000))" ;;
    *) echo "$ms" ;;
  esac
}

clock() { date +%H:%M:%S; }

# The pid of whatever is listening on the admitter's port, or nothing.
listening_pid() {
  if [ "$WINDOWS" = 1 ]; then
    netstat -ano | grep LISTENING | grep -E "[:.]$PORT[[:space:]]" | awk '{print $NF}' | head -1
  elif command -v lsof > /dev/null 2>&1; then
    lsof -ti "tcp:$PORT" -sTCP:LISTEN 2> /dev/null | head -1
  else
    ss -ltnpH "sport = :$PORT" 2> /dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1
  fi
}

kill_hard() {
  if [ "$WINDOWS" = 1 ]; then
    # Only this process, not its parent: under `make dev` the parent is tsx's watcher, which stays.
    taskkill //PID "$1" //F > /dev/null
  else
    kill -9 "$1"
  fi
}

is_up() { curl -sf -m 2 -o /dev/null "$HEALTH"; }

wait_until_up() {
  local i
  for i in $(seq 1 "$1"); do
    if is_up; then return 0; fi
    sleep 1
  done
  return 1
}

# A marker on every dashboard that shows annotations tagged "chaos".
annotate() {
  local body
  body="{\"time\": $(now_ms), \"tags\": [\"chaos\", \"admitter\"], \"text\": \"$1\"}"
  if ! curl -sf -m 5 -o /dev/null -u "$GRAFANA_AUTH" -H "content-type: application/json" \
    -X POST "$GRAFANA_URL/api/annotations" -d "$body"; then
    echo "  (could not post the Grafana annotation \"$1\" to $GRAFANA_URL)" >&2
  fi
}

if [ "$AFTER" != 0 ]; then
  echo "[$(clock)] chaos: killing the admitter in ${AFTER}s"
  sleep "$AFTER"
fi

PID="$(listening_pid)"
if [ -z "$PID" ]; then
  echo "chaos: nothing is listening on port $PORT: the admitter is not running" >&2
  exit 1
fi

kill_hard "$PID"
annotate "admitter stopped"
echo "[$(clock)] chaos: admitter stopped (pid $PID killed); it stays down for ${DOWN}s"
sleep "$DOWN"

# Watch mode starts it again when its entry file changes.
touch "$ENTRY"
if wait_until_up 15; then
  annotate "admitter started"
  echo "[$(clock)] chaos: admitter started again by watch mode (pid $(listening_pid))"
  exit 0
fi

echo "[$(clock)] chaos: watch mode did not bring it back; starting it here"
LOG="$ROOT/loadtest/results/phase5/admitter-restart.log"
mkdir -p "$(dirname "$LOG")"
(
  cd "$ROOT/services/queue"
  nohup node --import tsx --env-file-if-exists=.env src/admitter/main.ts >> "$LOG" 2>&1 &
)
if wait_until_up 20; then
  annotate "admitter started"
  echo "[$(clock)] chaos: admitter started (pid $(listening_pid), NOT under \`make dev\`: stop it by hand; log: $LOG)"
  exit 0
fi

echo "chaos: the admitter did not come back on port $PORT. See $LOG" >&2
exit 1
