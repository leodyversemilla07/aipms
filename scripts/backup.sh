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

OUTPUT_DIR="${1:-./backups}"
KEEP="${AIPMS_BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUTPUT_DIR/aipms-$STAMP.sql.gz"

mkdir -p "$OUTPUT_DIR"

echo "[backup] dumping to $FILE"
docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-user}" --no-owner --clean --if-exists \
  "${POSTGRES_DB:-aipms}" | gzip > "$FILE"

# Sanity check: a valid dump is non-trivially sized and gunzips cleanly.
if ! gunzip -t "$FILE" 2>/dev/null; then
  echo "[backup] ERROR: dump failed integrity check" >&2
  exit 1
fi

SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] ERROR: dump suspiciously small (${SIZE} bytes)" >&2
  exit 1
fi
echo "[backup] ok ($SIZE bytes)"

# Retention: keep newest $KEEP, remove older.
ls -1t "$OUTPUT_DIR"/aipms-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  echo "[backup] pruning $old"
  rm -f "$old"
done
