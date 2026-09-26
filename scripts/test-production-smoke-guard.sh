#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

# No Docker daemon or application services are touched by this regression test.
cat > "$TEMP/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$1" in
  compose) ;; # No existing containers.
  volume) printf 'existing-smoke-volume\n' ;;
  *) exit 99 ;;
esac
MOCK
chmod +x "$TEMP/docker"
export DOCKER_CALLS="$TEMP/docker-calls"

if PATH="$TEMP:$PATH" COMPOSE_PROJECT_NAME=aipms \
  bash "$ROOT/scripts/production-smoke.sh" > "$TEMP/unsafe.log" 2>&1; then
  echo 'Smoke script accepted a production project name' >&2
  exit 1
fi
grep -q 'Refusing unsafe smoke project name' "$TEMP/unsafe.log"
if [ -e "$DOCKER_CALLS" ]; then
  echo 'Smoke script contacted Docker for an unsafe project' >&2
  exit 1
fi

if PATH="$TEMP:$PATH" COMPOSE_PROJECT_NAME=aipms-release-smoke-existing \
  bash "$ROOT/scripts/production-smoke.sh" > "$TEMP/existing.log" 2>&1; then
  echo 'Smoke script accepted an existing project volume' >&2
  exit 1
fi
grep -q 'Refusing to reuse existing smoke project' "$TEMP/existing.log"
printf 'Production smoke project guards passed.\n'
