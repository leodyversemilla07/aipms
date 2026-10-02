#!/usr/bin/env bash
set -euo pipefail

# Build the exact deployment targets, apply migrations through the production
# API entrypoint, and verify both externally reachable health surfaces.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aipms-release-smoke-$(date +%s)-$$}"
# Never let an inherited production project name reach the destructive restore
# drill or the cleanup trap. CI uses its own unique aipms-ci-* project name.
case "$PROJECT_NAME" in
  aipms-release-smoke-* | aipms-ci-*) ;;
  *)
    printf 'Refusing unsafe smoke project name: %s\n' "$PROJECT_NAME" >&2
    exit 1
    ;;
esac
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3100}"
POSTGRES_PORT="${POSTGRES_PORT:-55432}"
export API_PORT WEB_PORT POSTGRES_PORT
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-release-smoke-db-password}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-release-smoke-auth-secret-at-least-32-bytes}"
export AIPMS_TOKEN_ENCRYPTION_SECRET="${AIPMS_TOKEN_ENCRYPTION_SECRET:-release-smoke-token-encryption-key-32-bytes}"
export AIPMS_SERVICE_TOKEN="${AIPMS_SERVICE_TOKEN:-release-smoke-service-token}"
export AIPMS_AGENT_SIGNING_SECRET="${AIPMS_AGENT_SIGNING_SECRET:-release-smoke-agent-signing-secret-32-bytes}"
export AIPMS_AGENT_ID="${AIPMS_AGENT_ID:-release-smoke-agent-1}"
# Fixed isolated smoke controls: prove the image sees non-default limits/scopes.
export AIPMS_AGENT_SCOPES="invoice.ingest,events.read"
export AIPMS_AGENT_RATE_LIMIT="1"
export AIPMS_AGENT_CONCURRENCY="2"
export OPERATIONS_MONITORING_TOKEN="${OPERATIONS_MONITORING_TOKEN:-release-smoke-monitoring-token}"
export APP_URL="${APP_URL:-http://localhost:${WEB_PORT}}"
export AUTH_TRUSTED_ORIGINS="${AUTH_TRUSTED_ORIGINS:-${APP_URL}}"
BACKUP_DIR="${TMPDIR:-/tmp}/${PROJECT_NAME}-backups"
PROBE_VALUE="restore-probe-$(date +%s)-$$"

compose() {
  docker compose -p "$PROJECT_NAME" "$@"
}

# A previous run may have left data even if its containers are stopped. Refuse
# to adopt or delete any existing Compose project, including orphaned volumes.
existing_containers="$(compose ps --all --quiet)"
existing_volumes="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME")"
if [ -n "$existing_containers" ] || [ -n "$existing_volumes" ]; then
  printf 'Refusing to reuse existing smoke project: %s\n' "$PROJECT_NAME" >&2
  exit 1
fi

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if (( exit_code != 0 )); then
    compose ps || true
    compose logs --no-color postgres api web || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$BACKUP_DIR"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wait_for_url() {
  local name=$1
  local url=$2
  local attempts=${3:-90}
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --silent --show-error --fail --max-time 5 "$url" >/dev/null; then
      printf '%s is ready: %s\n' "$name" "$url"
      return 0
    fi
    sleep 2
  done
  printf 'Timed out waiting for %s at %s\n' "$name" "$url" >&2
  return 1
}

compose build api web agent
compose up --detach postgres api web

wait_for_url "API liveness" "http://localhost:${API_PORT}/health/live"
wait_for_url "API readiness" "http://localhost:${API_PORT}/health/ready"
wait_for_url "Web" "http://localhost:${WEB_PORT}/"

web_headers=$(curl --silent --show-error --fail --head \
  "http://localhost:${WEB_PORT}/" | tr -d '\r')
for required_header in \
  'content-security-policy:' \
  'strict-transport-security:' \
  'x-content-type-options: nosniff' \
  'x-frame-options: DENY' \
  'referrer-policy: no-referrer'; do
  if ! grep -Fqi "$required_header" <<< "$web_headers"; then
    printf 'Missing production web security header: %s\n' "$required_header" >&2
    exit 1
  fi
done

health_payload=$(curl --silent --show-error --fail "http://localhost:${API_PORT}/health/ready")
if [[ "$health_payload" != *'"ok":true'* ]]; then
  printf 'Unexpected API health payload: %s\n' "$health_payload" >&2
  exit 1
fi

monitoring_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://localhost:${API_PORT}/health/operations")
if [ "$monitoring_status" != "401" ]; then
  printf 'Monitoring endpoint did not reject an unauthenticated probe: %s\n' \
    "$monitoring_status" >&2
  exit 1
fi
monitoring_payload=$(curl --silent --show-error --fail \
  -H "Authorization: Bearer ${OPERATIONS_MONITORING_TOKEN}" \
  "http://localhost:${API_PORT}/health/operations")
if [[ "$monitoring_payload" != *'"deadLetters":0'* ]]; then
  printf 'Unexpected monitoring payload: %s\n' "$monitoring_payload" >&2
  exit 1
fi

# Validate effective container settings, including narrowed scopes; no AI or
# external provider is started. One empty queue envelope is admitted, then the
# shared quota must refuse the next envelope with HTTP 429.
compose exec --no-TTY api node -e '
  const assert = require("node:assert/strict");
  assert.equal(process.env.AIPMS_AGENT_SCOPES, "invoice.ingest,events.read");
  assert.equal(process.env.AIPMS_AGENT_RATE_LIMIT, "1");
  assert.equal(process.env.AIPMS_AGENT_CONCURRENCY, "2");
'
exchange=$(curl --silent --show-error --fail --max-time 10 \
  -H "Authorization: Bearer ${AIPMS_SERVICE_TOKEN}" \
  -H 'Content-Type: application/json' -d '{}' \
  "http://localhost:${API_PORT}/api/service/agent/token")
access_token=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).accessToken)' "$exchange")
batch_status=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
  -H "Authorization: Bearer ${access_token}" -H 'Content-Type: application/json' \
  -d '{"limit":1}' "http://localhost:${API_PORT}/api/service/agent/batch")
[ "$batch_status" = "201" ] || { printf 'First machine batch was not admitted: %s\n' "$batch_status" >&2; exit 1; }
# A minute boundary between requests resets the bucket. Make a bounded third
# attempt if that occurred instead of weakening the refusal assertion.
for ((attempt = 0; attempt < 2; attempt++)); do
  batch_status=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' \
    -H "Authorization: Bearer ${access_token}" -H 'Content-Type: application/json' \
    -d '{"limit":1}' "http://localhost:${API_PORT}/api/service/agent/batch")
  [ "$batch_status" = "429" ] && break
done
[ "$batch_status" = "429" ] || { printf 'Shared machine quota was not enforced: %s\n' "$batch_status" >&2; exit 1; }

CAPACITY_BASE_URL="http://localhost:${API_PORT}" \
CAPACITY_ALLOW_INSECURE=1 \
CAPACITY_REQUESTS="${CAPACITY_REQUESTS:-100}" \
CAPACITY_CONCURRENCY="${CAPACITY_CONCURRENCY:-10}" \
CAPACITY_MAX_P95_MS="${CAPACITY_MAX_P95_MS:-2500}" \
  node ./scripts/capacity-smoke.mjs

# The production entrypoint already ran migrate deploy. Verify that the image
# and database agree and that no migration was silently left pending.
compose exec --no-TTY api sh -c \
  'cd /app && pnpm --filter @workspace/db exec prisma migrate status'

# Exercise the operational backup and restore procedures against the same
# production images. A probe created before the dump must survive a destructive
# mutation and the validated restore.
printf 'Validating backup and restore round trip.\n'
compose exec --no-TTY postgres psql -U "${POSTGRES_USER:-user}" \
  -d "${POSTGRES_DB:-aipms}" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE TABLE "restoreSmokeProbe" (value text PRIMARY KEY)' \
  -c "INSERT INTO \"restoreSmokeProbe\" (value) VALUES ('$PROBE_VALUE')"
mkdir -p "$BACKUP_DIR"
./scripts/backup.sh "$BACKUP_DIR"
BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'aipms-*.sql.gz' -type f -print -quit)"
if [ -z "$BACKUP_FILE" ]; then
  printf 'Backup file was not created.\n' >&2
  exit 1
fi
BACKUP_MAX_AGE_SECONDS=300 ./scripts/backup-health.sh "$BACKUP_DIR"
compose exec --no-TTY postgres psql -U "${POSTGRES_USER:-user}" \
  -d "${POSTGRES_DB:-aipms}" -v ON_ERROR_STOP=1 -q \
  -c 'DROP TABLE "restoreSmokeProbe"'
AIPMS_RESTORE_SKIP_RESTART=1 ./scripts/restore.sh "$BACKUP_FILE"
RESTORED_PROBE="$(compose exec --no-TTY postgres psql \
  -U "${POSTGRES_USER:-user}" -d "${POSTGRES_DB:-aipms}" -Atq \
  -c 'SELECT value FROM "restoreSmokeProbe"')"
if [ "$RESTORED_PROBE" != "$PROBE_VALUE" ]; then
  printf 'Restore probe mismatch.\n' >&2
  exit 1
fi
compose up --detach api web
wait_for_url "API after restore" "http://localhost:${API_PORT}/health/ready"
wait_for_url "Web after restore" "http://localhost:${WEB_PORT}/"

# Confirm all expected production artifacts were built, even though the agent
# is not started during the HTTP smoke test (it requires a real provider).
docker image inspect "${AIPMS_AGENT_IMAGE_REF:-aipms-agent:local}" >/dev/null

printf 'Production image smoke test passed.\n'
