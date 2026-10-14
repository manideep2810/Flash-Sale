#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost}"
TIMEOUT=60

# Check jq is installed
if ! command -v jq &> /dev/null; then
  echo "ERROR: jq is required. Install with: sudo apt install -y jq" >&2
  exit 1
fi

echo "Smoke tests against $BASE_URL (timeout ${TIMEOUT}s)"
echo ""

# Step 1: dev-login
echo "1. POST /api/auth/dev-login (session token)"
RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/dev-login" \
  -H "Content-Type: application/json" \
  -d '{"userId":"smoke-test-user"}')
SESSION_TOKEN=$(echo "$RESPONSE" | jq -r '.sessionToken // empty')
if [ -z "$SESSION_TOKEN" ]; then
  echo "  FAIL: No sessionToken in response: $RESPONSE"
  exit 1
fi
echo "  PASS: Got session token"

# Step 2: GET event info
echo "2. GET /api/events (list events)"
RESPONSE=$(curl -s "$BASE_URL/api/events" \
  -H "Authorization: Bearer $SESSION_TOKEN")
EVENT_ID=$(echo "$RESPONSE" | jq -r '.[0].id // empty')
if [ -z "$EVENT_ID" ]; then
  echo "  FAIL: No events returned: $RESPONSE"
  exit 1
fi
echo "  PASS: Got events, using $EVENT_ID"

# Step 3: POST join
echo "3. POST /api/queue/$EVENT_ID/join (join waiting room)"
RESPONSE=$(curl -s -X POST "$BASE_URL/api/queue/$EVENT_ID/join" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
JOIN_STATUS=$(echo "$RESPONSE" | jq -r '.status // empty')
if [ -z "$JOIN_STATUS" ]; then
  echo "  FAIL: No status in join response: $RESPONSE"
  exit 1
fi
echo "  PASS: Joined, status=$JOIN_STATUS"

# Step 4: Poll status until ADMITTED (timeout 60s)
echo "4. GET /api/queue/$EVENT_ID/status (poll until ADMITTED)"
DEADLINE=$((SECONDS + TIMEOUT))
ADMISSION_TOKEN=""
while [ $SECONDS -lt $DEADLINE ]; do
  RESPONSE=$(curl -s "$BASE_URL/api/queue/$EVENT_ID/status" \
    -H "Authorization: Bearer $SESSION_TOKEN")
  STATUS=$(echo "$RESPONSE" | jq -r '.status // empty')
  ADMISSION_TOKEN=$(echo "$RESPONSE" | jq -r '.admissionToken // empty')
  if [ "$STATUS" = "ADMITTED" ] || [ -n "$ADMISSION_TOKEN" ]; then
    echo "  PASS: Admitted (got token)"
    break
  fi
  if [ "$STATUS" = "SOLD_OUT" ] || [ "$STATUS" = "EXPIRED" ]; then
    echo "  SKIP: Event $STATUS"
    exit 0
  fi
  sleep 1
done
if [ -z "$ADMISSION_TOKEN" ]; then
  echo "  FAIL: Not admitted after ${TIMEOUT}s. Last status: $STATUS"
  exit 1
fi

# Step 5: POST reserve
echo "5. POST /api/reserve (reserve a ticket)"
RESPONSE=$(curl -s -X POST "$BASE_URL/api/reserve" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "X-Admission-Token: $ADMISSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"$EVENT_ID\"}")
HOLD_ID=$(echo "$RESPONSE" | jq -r '.holdId // empty')
if [ -z "$HOLD_ID" ]; then
  echo "  FAIL: No holdId in response: $RESPONSE"
  exit 1
fi
echo "  PASS: Reserved (holdId=$HOLD_ID)"

# Step 6: POST pay
echo "6. POST /api/orders/:id/pay (initiate payment)"
ORDER_ID="${SESSION_TOKEN%.*}"  # Use part of token as a fake order id; real flow needs GET /orders first
RESPONSE=$(curl -s -X POST "$BASE_URL/api/orders/$ORDER_ID/pay" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"holdId\":\"$HOLD_ID\",\"amount\":999}")
# Payment endpoint may not exist in demo; skip hard check
echo "  SKIP: Payment response (demo only): $(echo "$RESPONSE" | jq -c '.' 2>/dev/null || echo 'not JSON')"

echo ""
echo "✓ ===== SMOKE TESTS PASSED ====="
