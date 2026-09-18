#!/usr/bin/env bash
#
# §16.2 single-tenant backup — consistent logical dump of Postgres.
#
#   scripts/backup.sh [output-dir]
#
# Dumps through the running compose postgres container (no host psql needed),
# gzips on the host, and keeps the last N dumps (AIPMS_BACKUP_KEEP, default 14).
# Restore is scripts/restore.sh <file>. Schedule via cron/systemd-timer:
#   0 2 * * * cd /opt/aipms && ./scripts/backup.sh /var/backups/aipms
set -euo pipefail
umask 077

OUTPUT_DIR="${1:-./backups}"
KEEP="${AIPMS_BACKUP_KEEP:-14}"
if ! [[ "$KEEP" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup] ERROR: AIPMS_BACKUP_KEEP must be a positive integer" >&2
  exit 1
fi

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
# pg_dump takes a transactionally consistent MVCC snapshot without stopping
# writers. pipefail ensures a pg_dump or gzip failure rejects the backup.
docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-user}" --format=plain --no-owner \
  --no-privileges --clean --if-exists "${POSTGRES_DB:-aipms}" \
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
  echo "[backup] pruning $old"
  rm -f "$old" "$old.sha256"
done

trap - EXIT INT TERM
