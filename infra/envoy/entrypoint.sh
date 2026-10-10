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
# Every ${NAME} the template uses must be set. The values are base64url text, numbers and durations,
# none of which can contain the '|' that delimits the sed expression.
for name in $(grep -o '\${[A-Z0-9_]*}' "$TEMPLATE" | tr -d '${}' | sort -u); do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "entrypoint: $name is used by envoy.yaml but is not set" >&2
    exit 1
  fi
  sed -i "s|\${$name}|$value|g" "$RENDERED"
done

exec /docker-entrypoint.sh envoy -c "$RENDERED" "$@"
