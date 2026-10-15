#!/usr/bin/env bash
#
# scripts/smoke-prod.sh -- one customer's whole purchase, through the gateway, like the web app does:
# log in, look at the event, join the waiting room, wait to be admitted, reserve, pay, and wait for
# the payment to be decided. PASS or FAIL per step; exits 1 at the first FAIL.
#
#   bash scripts/smoke-prod.sh
#   BASE_URL=http://<server> EVENT_ID=aurora-sound-festival bash scripts/smoke-prod.sh
#
# Needs curl and jq (sudo apt install -y jq). The event must be on sale: the seed's
# aurora-sound-festival is, from the moment it is seeded. Each run buys one of its 500 tickets.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost}"
EVENT_ID="${EVENT_ID:-aurora-sound-festival}"
ADMIT_TIMEOUT="${ADMIT_TIMEOUT:-60}"
PAY_TIMEOUT="${PAY_TIMEOUT:-30}"
USER_ID="smoke-$(date +%s)-$RANDOM"

command -v jq > /dev/null || { echo "jq is required: sudo apt install -y jq" >&2; exit 1; }
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  printf '      last answer: HTTP %s %s\n' "$STATUS" "$BODY"
  exit 1
}
# Reads one field of the last answer, or nothing when it is not JSON.
field() { jq -r "$1 // empty" <<< "$BODY" 2> /dev/null; }

TOKEN=""
ADMISSION=""
STATUS=""
BODY=""
# api METHOD PATH [JSON]: calls the gateway with the session (and the admission token, when there
# is one) and leaves the answer in STATUS and BODY.
api() {
  local args=(-sS -o "$BODY_FILE" -w '%{http_code}' -X "$1" --max-time 10)
  [ -n "$TOKEN" ] && args+=(-H "authorization: Bearer $TOKEN")
  [ -n "$ADMISSION" ] && args+=(-H "x-admission-token: $ADMISSION")
  [ -n "${3:-}" ] && args+=(-H "content-type: application/json" --data "$3")
  STATUS=$(curl "${args[@]}" "$BASE_URL$2" 2> /dev/null) || STATUS="${STATUS:-000}"
  BODY=$(cat "$BODY_FILE" 2> /dev/null)
}

echo "smoke test: $BASE_URL, event $EVENT_ID, user $USER_ID"

# 1. Log in (dev login: a session for any user id, no password)
api POST /api/auth/dev-login "{\"userId\":\"$USER_ID\"}"
TOKEN=$(field .token)
[ "$STATUS" = 200 ] && [ -n "$TOKEN" ] || fail "dev-login"
pass "dev-login: got a session"

# 2. The event: the public catalogue entry, then the waiting room's view of it
api GET "/api/events/$EVENT_ID"
[ "$STATUS" = 200 ] || fail "event $EVENT_ID is not in the catalogue (deploy.sh --reseed seeds it)"
api GET "/api/queue/$EVENT_ID/info"
[ "$STATUS" = 200 ] || fail "waiting-room info"
pass "event info: $(field .name), sale state $(field .state)"

# 3. Join the waiting room
api POST "/api/queue/$EVENT_ID/join"
joined=$(field .status)
case "$joined" in
  QUEUED | ADMITTED) pass "join: $joined $( [ "$joined" = QUEUED ] && echo "at position $(field .position)")" ;;
  *) fail "join (status '$joined')" ;;
esac

# 4. Poll the status until admitted; the admission token comes with ADMITTED
deadline=$((SECONDS + ADMIT_TIMEOUT))
while :; do
  api GET "/api/queue/$EVENT_ID/status"
  case "$(field .status)" in
    ADMITTED) ADMISSION=$(field .token); break ;;
    QUEUED) ;;
    *) fail "status: not admitted (status '$(field .status)')" ;;
  esac
  [ "$SECONDS" -lt "$deadline" ] || fail "status: not admitted within ${ADMIT_TIMEOUT}s"
  # The gateway allows 60 status calls a minute per user.
  sleep 2
done
[ -n "$ADMISSION" ] || fail "status: ADMITTED without a token"
pass "admitted: got an admission token"

# 5. Reserve one ticket with the admission token
api POST /api/reserve "{\"eventId\":\"$EVENT_ID\",\"qty\":1}"
HOLD_ID=$(field .holdId)
[ "$STATUS" = 201 ] && [ -n "$HOLD_ID" ] || fail "reserve"
ADMISSION=""
pass "reserve: hold $HOLD_ID (the order id)"

# 6. Pay. The order is created from the reservation event (relay -> Kafka -> order worker), so it
#    can take a moment to exist: 404 until then.
deadline=$((SECONDS + PAY_TIMEOUT))
while :; do
  api POST "/api/orders/$HOLD_ID/pay"
  [ "$STATUS" != 404 ] && break
  [ "$SECONDS" -lt "$deadline" ] || fail "pay: the order did not appear within ${PAY_TIMEOUT}s"
  sleep 1
done
[ "$STATUS" = 202 ] || [ "$STATUS" = 200 ] || fail "pay"
pass "pay: accepted ($(field .state))"

# 7. Poll the order until the payment is decided. The mock declines a share of charges on purpose;
#    a declined order goes PAYMENT_FAILED and then RELEASED once its ticket is given back.
while :; do
  api GET "/api/orders/$HOLD_ID"
  state=$(field .state)
  case "$state" in
    PAID) pass "order: PAID"; break ;;
    PAYMENT_FAILED | RELEASED) pass "order: $state (the mock declined the card, which it does on purpose)"; break ;;
  esac
  [ "$SECONDS" -lt "$deadline" ] || fail "order: still '$state' after ${PAY_TIMEOUT}s"
  sleep 1
done

echo "SMOKE PASS"
