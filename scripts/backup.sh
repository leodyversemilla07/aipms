#!/usr/bin/env bash
# Consistent logical backup of the PostgreSQL database configured by
# DATABASE_URL. Requires the PostgreSQL client tools (pg_dump, gzip) on PATH.
set -euo pipefail
umask 077

OUTPUT_DIR="${1:-./backups}"
KEEP="${AIPMS_BACKUP_KEEP:-14}"
: "${DATABASE_URL:?DATABASE_URL must point to the PostgreSQL instance}"
if ! [[ "$KEEP" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup] ERROR: AIPMS_BACKUP_KEEP must be a positive integer" >&2
  exit 1
fi
for tool in pg_dump gzip gunzip sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[backup] ERROR: required tool not found on PATH: $tool" >&2
    exit 1
  fi
done

STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$OUTPUT_DIR/aipms-$STAMP.sql.gz"
TEMP_FILE="$FILE.tmp.$$"
TEMP_CHECKSUM="$FILE.sha256.tmp.$$"
mkdir -p "$OUTPUT_DIR"
cleanup() {
  rm -f "$TEMP_FILE" "$TEMP_CHECKSUM"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "[backup] dumping to $FILE"
# The connection string travels in the environment (PGDATABASE), never in the
# process argument list, so the database password is not exposed through ps.
export PGDATABASE="$DATABASE_URL"
# pg_dump takes a transactionally consistent MVCC snapshot without stopping
# writers. pipefail ensures a pg_dump or gzip failure rejects the backup.
pg_dump --format=plain --no-owner --no-privileges --clean --if-exists \
  | gzip > "$TEMP_FILE"

# Refuse corrupt or implausibly small archives before publishing them under
# the final name. The rename keeps backup consumers from seeing partial files.
gunzip -t "$TEMP_FILE"
SIZE=$(wc -c < "$TEMP_FILE")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] ERROR: dump suspiciously small (${SIZE} bytes)" >&2
  exit 1
fi
sha256sum "$TEMP_FILE" | awk '{print $1}' > "$TEMP_CHECKSUM"
mv "$TEMP_CHECKSUM" "$FILE.sha256"
if ! mv "$TEMP_FILE" "$FILE"; then
  rm -f "$FILE.sha256"
  exit 1
fi
echo "[backup] ok ($SIZE bytes; checksum $FILE.sha256)"

# Retention: keep newest $KEEP archives and remove their checksum sidecars too.
ls -1t "$OUTPUT_DIR"/aipms-*.sql.gz | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  rm -f "$old" "$old.sha256"
done

trap - EXIT INT TERM
