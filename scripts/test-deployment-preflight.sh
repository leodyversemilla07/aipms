#!/usr/bin/env bash
set -euo pipefail

TEMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT INT TERM
ENV_FILE="$TEMP_DIR/production.env"

write_valid() {
  cat > "$ENV_FILE" <<'EOF'
POSTGRES_PASSWORD="pg_7FvSzBknWY8uqoRc2hPjQm9L4NtX6DsE"
BETTER_AUTH_SECRET="ba_8DkLmQxN4WrTz7YpV2Hs6Jc9FgRu5KeM"
AIPMS_SERVICE_TOKEN="as_9FrTqWmK3YpL8VxN6Hs2Jc7BdEz4UaG"
AIPMS_AGENT_SIGNING_SECRET="ats_4NcR8mV2qP7xL1kD5sH9wF3bJ6tY0eZu"
AIPMS_AGENT_ID="staging-procurement-agent-1"
OPERATIONS_MONITORING_TOKEN="om_5KpVxQmT8YrN3Hs7Jc2Ld9WfBg6ZeRaU"
APP_URL="https://aipms.example.com"
AUTH_TRUSTED_ORIGINS="https://aipms.example.com"
AUTH_SEED_DEMO="0"
AIPMS_LLM_KIND="offline"
AIPMS_LLM_ENDPOINT="http://llm:11434/v1"
AIPMS_LLM_MODEL="llama3.2:3b"
AIPMS_LLM_ALLOWED_HOSTS="llm"
AIPMS_MESSAGING_TRANSPORT="smtp"
AIPMS_SMTP_HOST="smtp.example.com"
AIPMS_SMTP_PORT="587"
AIPMS_SMTP_FROM="Procurement <procurement@example.com>"
AIPMS_SMTP_USER="relay-user"
AIPMS_SMTP_PASSWORD="smtp_3YpL8VxN6Hs2Jc7BdEz4UaG"
EOF
  chmod 600 "$ENV_FILE"
}

isolated_preflight() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
    node ./scripts/deployment-preflight.mjs "$ENV_FILE"
}

write_valid
isolated_preflight | grep -q '"ok": true'

# Shared credentials must fail without echoing either secret.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i \
  's/om_5KpVxQmT8YrN3Hs7Jc2Ld9WfBg6ZeRaU/as_9FrTqWmK3YpL8VxN6Hs2Jc7BdEz4UaG/' \
  "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/shared.out" 2>&1; then
  echo "deployment preflight accepted shared credentials" >&2
  exit 1
fi
grep -q 'must be independent' "$TEMP_DIR/shared.out"
if grep -q 'as_9FrTqWmK3YpL8VxN6Hs2Jc7BdEz4UaG' "$TEMP_DIR/shared.out"; then
  echo "deployment preflight leaked a credential" >&2
  exit 1
fi

# A valid file with broad filesystem permissions must still fail closed.
mv "$ENV_FILE.valid" "$ENV_FILE"
chmod 644 "$ENV_FILE"
if isolated_preflight >/dev/null 2>&1; then
  echo "deployment preflight accepted insecure file permissions" >&2
  exit 1
fi

printf 'Deployment preflight self-test passed.\n'
