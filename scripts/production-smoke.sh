#!/usr/bin/env bash
set -euo pipefail

# Build the exact deployment targets, apply migrations through the production
# API entrypoint, and verify both externally reachable health surfaces.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aipms-release-smoke}"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3100}"
POSTGRES_PORT="${POSTGRES_PORT:-55432}"
export API_PORT WEB_PORT POSTGRES_PORT
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-release-smoke-db-password}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-release-smoke-auth-secret-at-least-32-bytes}"
export AIPMS_SERVICE_TOKEN="${AIPMS_SERVICE_TOKEN:-release-smoke-service-token}"
export APP_URL="${APP_URL:-http://localhost:${WEB_PORT}}"
export AUTH_TRUSTED_ORIGINS="${AUTH_TRUSTED_ORIGINS:-${APP_URL}}"

compose() {
  docker compose -p "$PROJECT_NAME" "$@"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if (( exit_code != 0 )); then
    compose ps || true
    compose logs --no-color postgres api web || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
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

wait_for_url "API" "http://localhost:${API_PORT}/health"
wait_for_url "Web" "http://localhost:${WEB_PORT}/"

health_payload=$(curl --silent --show-error --fail "http://localhost:${API_PORT}/health")
if [[ "$health_payload" != *'"ok":true'* ]]; then
  printf 'Unexpected API health payload: %s\n' "$health_payload" >&2
  exit 1
fi

# The production entrypoint already ran migrate deploy. Verify that the image
# and database agree and that no migration was silently left pending.
compose exec --no-TTY api sh -c \
  'cd /app && pnpm --filter @workspace/db exec prisma migrate status'

# Confirm all expected production artifacts were built, even though the agent
# is not started during the HTTP smoke test (it requires a real provider).
docker image inspect "${PROJECT_NAME}-agent" >/dev/null

printf 'Production image smoke test passed.\n'
