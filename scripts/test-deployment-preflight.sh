#!/usr/bin/env bash
set -euo pipefail

TEMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT INT TERM
ENV_FILE="$TEMP_DIR/production.env"

write_valid() {
  cat > "$ENV_FILE" <<'EOF'
DATABASE_URL="postgresql://aipms:pg_7FvSzBknWY8uqoRc2hPjQm9L4NtX6DsE@db.internal.example.com:5432/aipms?sslmode=require"
BETTER_AUTH_SECRET="ba_8DkLmQxN4WrTz7YpV2Hs6Jc9FgRu5KeM"
AIPMS_TOKEN_ENCRYPTION_SECRET="enc_6TbQ2nV9xK4mR8pL1sH7wF3dJ5cY0eZa"
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

for name in AIPMS_AGENT_RATE_LIMIT AIPMS_AGENT_CONCURRENCY; do
  cp "$ENV_FILE" "$ENV_FILE.valid"
  printf '%s="0"\n' "$name" >> "$ENV_FILE"
  if isolated_preflight > "$TEMP_DIR/quota.out" 2>&1; then
    echo "deployment preflight accepted a zero machine quota" >&2
    exit 1
  fi
  grep -q "\"check\": \"$name\"" "$TEMP_DIR/quota.out"
  grep -q "must be a positive database-range integer" "$TEMP_DIR/quota.out"
  mv "$ENV_FILE.valid" "$ENV_FILE"
done

# Only the bundled single-label model hostname is trusted without an explicit
# allowlist.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's|http://llm:11434/v1|http://external:11434/v1|' "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/hostname.out" 2>&1; then
  echo "deployment preflight accepted an unlisted single-label LLM hostname" >&2
  exit 1
fi
grep -q 'offline endpoint must be private or explicitly allowlisted' "$TEMP_DIR/hostname.out"
mv "$ENV_FILE.valid" "$ENV_FILE"

# Shared credentials must fail without echoing either secret.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i \
  's|om_5KpVxQmT8YrN3Hs7Jc2Ld9WfBg6ZeRaU|as_9FrTqWmK3YpL8VxN6Hs2Jc7BdEz4UaG|' \
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
mv "$ENV_FILE.valid" "$ENV_FILE"

# A managed deployment must declare its database connection explicitly.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i '/^DATABASE_URL=/d' "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/database-url.out" 2>&1; then
  echo "deployment preflight accepted a missing database URL" >&2
  exit 1
fi
grep -q '"check": "DATABASE_URL"' "$TEMP_DIR/database-url.out"
grep -q 'is required' "$TEMP_DIR/database-url.out"
mv "$ENV_FILE.valid" "$ENV_FILE"

# A PostgreSQL maintenance database is never a valid application target.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's|:5432/aipms?sslmode=require|:5432/postgres?sslmode=require|' "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/maintenance.out" 2>&1; then
  echo "deployment preflight accepted a maintenance database" >&2
  exit 1
fi
grep -q 'must not point at a PostgreSQL maintenance database' "$TEMP_DIR/maintenance.out"
mv "$ENV_FILE.valid" "$ENV_FILE"

# A remote database must require transport security.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's|?sslmode=require||' "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/tls.out" 2>&1; then
  echo "deployment preflight accepted a remote database without TLS" >&2
  exit 1
fi
grep -q 'must require transport security' "$TEMP_DIR/tls.out"
mv "$ENV_FILE.valid" "$ENV_FILE"

# A loopback database is allowed without transport security.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's|@db.internal.example.com:5432/aipms?sslmode=require|@127.0.0.1:5432/aipms|' "$ENV_FILE"
isolated_preflight | grep -q '"ok": true'
mv "$ENV_FILE.valid" "$ENV_FILE"

# A Unix-socket database connection is local and needs no transport security.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's|postgresql://aipms:pg_7FvSzBknWY8uqoRc2hPjQm9L4NtX6DsE@db.internal.example.com:5432/aipms?sslmode=require|postgresql://aipms@/aipms?host=/var/run/postgresql|' "$ENV_FILE"
isolated_preflight | grep -q '"ok": true'
mv "$ENV_FILE.valid" "$ENV_FILE"

# Local ChatGPT subscription auth must never pass production preflight.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's/AIPMS_LLM_KIND="offline"/AIPMS_LLM_KIND="chatgpt"/' "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/chatgpt.out" 2>&1; then
  echo "deployment preflight accepted local ChatGPT subscription mode" >&2
  exit 1
fi
grep -q 'local-development only' "$TEMP_DIR/chatgpt.out"
mv "$ENV_FILE.valid" "$ENV_FILE"

# Retention/no-retention gates are only enforceable by the offline provider path.
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i \
  -e 's/AIPMS_LLM_KIND="offline"/AIPMS_LLM_KIND="cloud"/' \
  -e 's|AIPMS_LLM_ENDPOINT="http://llm:11434/v1"|AIPMS_LLM_ENDPOINT="https://api.openai.com/v1"|' \
  "$ENV_FILE"
printf 'AIPMS_LLM_API_KEY="sk_test_abcdefghijklmnopqrstuvwxyz"\nAIPMS_LLM_GATE="no-retention"\n' >> "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/retention.out" 2>&1; then
  echo "deployment preflight accepted a cloud no-retention gate" >&2
  exit 1
fi
grep -q 'retention/no-retention policies require offline mode' "$TEMP_DIR/retention.out"
mv "$ENV_FILE.valid" "$ENV_FILE"

# A valid file with broad filesystem permissions must still fail closed.
cp "$ENV_FILE" "$ENV_FILE.valid"
chmod 644 "$ENV_FILE"
if isolated_preflight >/dev/null 2>&1; then
  echo "deployment preflight accepted insecure file permissions" >&2
  exit 1
fi
mv "$ENV_FILE.valid" "$ENV_FILE"

printf 'Deployment preflight self-test passed.\n'
