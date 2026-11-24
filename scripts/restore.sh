#!/usr/bin/env bash
# Restore a backup produced by scripts/backup.sh using host PostgreSQL tools.
#
#   DATABASE_URL=... AIPMS_RESTORE_CONFIRM=yes AIPMS_RESTORE_WRITERS_STOPPED=yes \
#     scripts/restore.sh backups/aipms-20260825-020000.sql.gz
#
# The restore is destructive: it is refused unless the operator confirms the
# action and states that every application writer (API, schedulers, event
# relay) has been stopped. The archive is validated in a disposable database
# before the target is touched.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup-file.sql.gz>" >&2
  exit 1
fi
FILE="$1"
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL must point to the PostgreSQL instance}"

for tool in psql createdb dropdb gzip gunzip sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[restore] ERROR: required tool not found on PATH: $tool" >&2
    exit 1
  fi
done

# The connection string travels in the environment (PGDATABASE), never in the
# process argument list, so the database password is not exposed through ps.
export PGDATABASE="$DATABASE_URL"

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

# Never restore into a PostgreSQL maintenance database.
TARGET_DB="$(psql -Atq -v ON_ERROR_STOP=1 -c 'SELECT current_database()')"
case "$TARGET_DB" in
  postgres | template0 | template1)
    echo "[restore] ERROR: refusing to restore into maintenance database $TARGET_DB" >&2
    exit 1
    ;;
esac

if [ "${AIPMS_RESTORE_CONFIRM:-}" != "yes" ]; then
  echo "[restore] refusing destructive restore; set AIPMS_RESTORE_CONFIRM=yes" >&2
  exit 1
fi
if [ "${AIPMS_RESTORE_WRITERS_STOPPED:-}" != "yes" ]; then
  echo "[restore] stop the API, schedulers, and event relay, then set AIPMS_RESTORE_WRITERS_STOPPED=yes" >&2
  exit 1
fi

# Validate the entire SQL stream against a disposable database before touching
# the target. A syntactically valid gzip is not enough: missing objects and SQL
# errors must fail here first.
VALIDATION_DB="aipms_restore_check_$$"
VALIDATION_CREATED=0
cleanup_validation() {
  if [ "$VALIDATION_CREATED" -eq 1 ]; then
    dropdb --maintenance-db="$TARGET_DB" --if-exists --force "$VALIDATION_DB" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup_validation EXIT
trap 'exit 130' INT TERM

if [ "${AIPMS_RESTORE_SKIP_VALIDATION:-0}" = "1" ]; then
  echo "[restore] WARNING: disposable-database validation skipped by AIPMS_RESTORE_SKIP_VALIDATION=1"
else
  echo "[restore] validating archive in disposable database $VALIDATION_DB"
  dropdb --maintenance-db="$TARGET_DB" --if-exists --force "$VALIDATION_DB" \
    >/dev/null 2>&1 || true
  createdb --maintenance-db="$TARGET_DB" -T template0 "$VALIDATION_DB"
  VALIDATION_CREATED=1
  VALIDATION_URL="$(DATABASE_URL="$DATABASE_URL" VALIDATION_DB="$VALIDATION_DB" node --input-type=module -e '
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = "/" + encodeURIComponent(process.env.VALIDATION_DB)
    process.stdout.write(url.toString())
  ')"
  gunzip -c "$FILE" | PGDATABASE="$VALIDATION_URL" \
    psql -q -b --single-transaction -v ON_ERROR_STOP=1
  SCHEMA_PRESENT="$(PGDATABASE="$VALIDATION_URL" psql -Atq -v ON_ERROR_STOP=1 \
    -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")"
  if [ "$SCHEMA_PRESENT" != "t" ]; then
    echo "[restore] ERROR: archive does not contain the Prisma migration ledger" >&2
    exit 1
  fi
  cleanup_validation
  VALIDATION_CREATED=0
  echo "[restore] archive validation passed"
fi

echo "[restore] restoring $FILE into $TARGET_DB"
if ! gunzip -c "$FILE" | psql -q -b --single-transaction -v ON_ERROR_STOP=1; then
  echo "[restore] ERROR: target restore failed; the target database is unchanged" >&2
  exit 1
fi

SCHEMA_PRESENT="$(psql -Atq -v ON_ERROR_STOP=1 \
  -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")"
if [ "$SCHEMA_PRESENT" != "t" ]; then
  echo "[restore] ERROR: restored schema failed validation" >&2
  exit 1
fi

echo "[restore] complete — run pnpm db:deploy before restarting application writers"
trap - EXIT INT TERM
