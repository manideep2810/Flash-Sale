#!/bin/sh
# Entrypoint of the envoy container (infra/docker/docker-compose.yml).
#
# envoy.yaml in this directory is a template: it holds ${PLACEHOLDERS} where the JWT keys and the
# local rate-limit numbers go, so that no secret is ever committed and the test stack can run the
# same file with smaller limits. This script fills them in from the container's environment, writes
# the result to /tmp/envoy.yaml and starts Envoy on it through the image's own entrypoint.
#
#   SESSION_SECRET, ADMISSION_SECRET   from infra/docker/.env; become the two HS256 keys
#   LOCAL_*                            from infra/envoy/limits.env (limits.test.env under test)
set -eu

TEMPLATE=/etc/envoy/gateway/envoy.yaml
RENDERED=/tmp/envoy.yaml
CR=$(printf '\r')

# A JWK carries a symmetric key as unpadded base64url.
b64url() {
  printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='
}

: "${SESSION_SECRET:?SESSION_SECRET is not set (infra/docker/.env)}"
: "${ADMISSION_SECRET:?ADMISSION_SECRET is not set (infra/docker/.env)}"
SESSION_JWK_K=$(b64url "$SESSION_SECRET")
ADMISSION_JWK_K=$(b64url "$ADMISSION_SECRET")
export SESSION_JWK_K ADMISSION_JWK_K

cp "$TEMPLATE" "$RENDERED"
# Every ${NAME} the template uses (outside its comments) must be set. The values are base64url text,
# numbers and durations, none of which can contain the '|' that delimits the sed expression. A
# carriage return is dropped, in case an env file was saved with Windows line endings.
for name in $(grep -v '^[[:space:]]*#' "$TEMPLATE" | grep -o '\${[A-Z0-9_]*}' | tr -d '${}' | sort -u); do
  eval "value=\${$name:-}"
  value=$(printf '%s' "$value" | tr -d "$CR")
  if [ -z "$value" ]; then
    echo "entrypoint: $name is used by envoy.yaml but is not set" >&2
    exit 1
  fi
  sed -i "s|\${$name}|$value|g" "$RENDERED"
done

# Access-log lines reach stdout within a second instead of Envoy's default ten.
exec /docker-entrypoint.sh envoy -c "$RENDERED" --file-flush-interval-msec 1000 "$@"
