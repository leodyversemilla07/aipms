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
AIPMS_TOKEN_ENCRYPTION_SECRET="enc_6TbQ2nV9xK4mR8pL1sH7wF3dJ5cY0eZa"
AIPMS_SERVICE_TOKEN="as_9FrTqWmK3YpL8VxN6Hs2Jc7BdEz4UaG"
AIPMS_AGENT_SIGNING_SECRET="ats_4NcR8mV2qP7xL1kD5sH9wF3bJ6tY0eZu"
AIPMS_AGENT_ID="staging-procurement-agent-1"
AIPMS_API_IMAGE_REF="ghcr.io/example/aipms-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
AIPMS_WEB_IMAGE_REF="ghcr.io/example/aipms-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
AIPMS_AGENT_IMAGE_REF="ghcr.io/example/aipms-agent@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
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

# Compose must inherit configured scopes, preserve empty denial, and leave
# genuinely unset scopes absent. config does not start/contact any container.
check_compose_scopes() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
    docker compose --env-file "$ENV_FILE" config --format json | \
    node --input-type=module -e '
      import assert from "node:assert/strict"
      let input = ""
      for await (const chunk of process.stdin) input += chunk
      const environment = JSON.parse(input).services.api.environment
      const expected = process.argv[1]
      if (expected === "UNSET") {
        assert.ok(environment.AIPMS_AGENT_SCOPES == null)
      } else {
        assert.equal(environment.AIPMS_AGENT_SCOPES, expected)
      }
      assert.equal(environment.AIPMS_AGENT_RATE_LIMIT, "2")
      assert.equal(environment.AIPMS_AGENT_CONCURRENCY, "1")
    ' "$1"
}
printf 'AIPMS_AGENT_RATE_LIMIT="2"\nAIPMS_AGENT_CONCURRENCY="1"\n' >> "$ENV_FILE"
check_compose_scopes "UNSET"
cp "$ENV_FILE" "$ENV_FILE.valid"
printf 'AIPMS_AGENT_SCOPES=""\n' >> "$ENV_FILE"
check_compose_scopes ""
mv "$ENV_FILE.valid" "$ENV_FILE"
printf 'AIPMS_AGENT_SCOPES="intake.read"\n' >> "$ENV_FILE"
check_compose_scopes "intake.read"

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

# Only the bundled Compose hostname is trusted without an explicit allowlist.
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

# Mutable image tags must never pass a production deployment preflight.
mv "$ENV_FILE.valid" "$ENV_FILE"
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i \
  's|ghcr.io/example/aipms-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|ghcr.io/example/aipms-api:latest|' \
  "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/image.out" 2>&1; then
  echo "deployment preflight accepted a mutable image tag" >&2
  exit 1
fi
grep -q 'immutable sha256 image digest' "$TEMP_DIR/image.out"

# Local ChatGPT subscription auth must never pass production preflight.
mv "$ENV_FILE.valid" "$ENV_FILE"
cp "$ENV_FILE" "$ENV_FILE.valid"
sed -i 's/AIPMS_LLM_KIND="offline"/AIPMS_LLM_KIND="chatgpt"/' "$ENV_FILE"
if isolated_preflight > "$TEMP_DIR/chatgpt.out" 2>&1; then
  echo "deployment preflight accepted local ChatGPT subscription mode" >&2
  exit 1
fi
grep -q 'local-development only' "$TEMP_DIR/chatgpt.out"

# Retention/no-retention gates are only enforceable by the offline provider path.
mv "$ENV_FILE.valid" "$ENV_FILE"
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

# A valid file with broad filesystem permissions must still fail closed.
mv "$ENV_FILE.valid" "$ENV_FILE"
chmod 644 "$ENV_FILE"
if isolated_preflight >/dev/null 2>&1; then
  echo "deployment preflight accepted insecure file permissions" >&2
  exit 1
fi

printf 'Deployment preflight self-test passed.\n'
