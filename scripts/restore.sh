#!/usr/bin/env bash
#
# §16.2 single-tenant restore — load a backup produced by scripts/backup.sh.
#
#   scripts/restore.sh backups/aipms-20260825-020000.sql.gz
#
# Rollback procedure (spec §16.2.1): validate the dump in a disposable
# database, stop every application writer, restore the target, then recreate
# the API so its entrypoint applies pending migrations before dependants start.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup-file.sql.gz>" >&2
  exit 1
fi
FILE="$1"
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }

POSTGRES_USER="${POSTGRES_USER:-user}"
POSTGRES_DB="${POSTGRES_DB:-aipms}"
for identifier in "$POSTGRES_USER" "$POSTGRES_DB"; do
  if ! [[ "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "[restore] ERROR: unsafe PostgreSQL identifier: $identifier" >&2
    exit 1
  fi
done
case "$POSTGRES_DB" in
  postgres | template0 | template1)
    echo "[restore] ERROR: refusing to restore into maintenance database $POSTGRES_DB" >&2
    exit 1
    ;;
esac

gunzip -t "$FILE" # refuse a corrupt archive before touching the database
if [ -f "$FILE.sha256" ]; then
  EXPECTED="$(tr -d '[:space:]' < "$FILE.sha256")"
  ACTUAL="$(sha256sum "$FILE" | awk '{print $1}')"
  if ! [[ "$EXPECTED" =~ ^[[:xdigit:]]{64}$ ]] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "[restore] ERROR: backup checksum mismatch" >&2
    exit 1
  fi
  echo "[restore] checksum verified"
else
  echo "[restore] WARNING: no checksum sidecar found; gzip integrity only" >&2
fi

# Validate the entire SQL stream against a disposable database before stopping
# writers or modifying the production database. A syntactically valid gzip is
# not enough: missing objects and SQL errors must fail here first.
VALIDATION_DB="aipms_restore_check_$$"
VALIDATION_CREATED=0
cleanup_validation() {
  if [ "$VALIDATION_CREATED" -eq 1 ]; then
    docker compose exec -T postgres \
      dropdb -U "$POSTGRES_USER" --if-exists --force "$VALIDATION_DB" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup_validation EXIT
trap 'exit 130' INT TERM

echo "[restore] validating archive in disposable database $VALIDATION_DB"
docker compose exec -T postgres \
  dropdb -U "$POSTGRES_USER" --if-exists --force "$VALIDATION_DB" >/dev/null
docker compose exec -T postgres \
  createdb -U "$POSTGRES_USER" -T template0 "$VALIDATION_DB"
VALIDATION_CREATED=1
gunzip -c "$FILE" | docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$VALIDATION_DB" -q -b --single-transaction \
  -v ON_ERROR_STOP=1
SCHEMA_PRESENT="$(docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$VALIDATION_DB" -Atq \
  -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")"
if [ "$SCHEMA_PRESENT" != "t" ]; then
  echo "[restore] ERROR: archive does not contain the Prisma migration ledger" >&2
  exit 1
fi
cleanup_validation
VALIDATION_CREATED=0
echo "[restore] archive validation passed"

echo "[restore] stopping api + web + agent so nothing writes during restore"
docker compose stop agent web api || true

# End any straggling sessions after stopping the application writers. This
# prevents a stale connection from racing the destructive --clean statements.
docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -Atq \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid()" \
  >/dev/null

echo "[restore] restoring $FILE into $POSTGRES_DB"
if ! gunzip -c "$FILE" | docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -b --single-transaction \
  -v ON_ERROR_STOP=1; then
  echo "[restore] ERROR: target restore failed; application writers remain stopped" >&2
  exit 1
fi

SCHEMA_PRESENT="$(docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
  -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")"
if [ "$SCHEMA_PRESENT" != "t" ]; then
  echo "[restore] ERROR: restored schema failed validation; writers remain stopped" >&2
  exit 1
fi

if [ "${AIPMS_RESTORE_SKIP_RESTART:-0}" = "1" ]; then
  echo "[restore] restore validated; restart skipped by AIPMS_RESTORE_SKIP_RESTART=1"
  echo "[restore] application writers remain stopped"
else
  echo "[restore] recreating api (migrate-deploy runs in its entrypoint)"
  docker compose up -d --force-recreate api
  echo "[restore] restarting dependent services"
  docker compose up -d web agent
  echo "[restore] done — verify with: docker compose ps && curl -fsS localhost:${API_PORT:-3001}/health"
fi

trap - EXIT INT TERM
