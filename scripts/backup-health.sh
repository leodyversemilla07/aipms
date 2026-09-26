#!/usr/bin/env bash
# Validate freshness and integrity of the newest AIPMS logical backup.
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
MAX_AGE="${BACKUP_MAX_AGE_SECONDS:-90000}"
if ! [[ "$MAX_AGE" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup-health] ERROR: BACKUP_MAX_AGE_SECONDS must be a positive integer" >&2
  exit 1
fi
if [ ! -d "$BACKUP_DIR" ]; then
  echo "[backup-health] ERROR: backup directory does not exist" >&2
  exit 1
fi

LATEST=""
LATEST_MTIME=0
while IFS= read -r -d '' candidate; do
  mtime=$(stat -c '%Y' "$candidate")
  if [ "$mtime" -gt "$LATEST_MTIME" ]; then
    LATEST="$candidate"
    LATEST_MTIME="$mtime"
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'aipms-*.sql.gz' -print0)

if [ -z "$LATEST" ]; then
  echo "[backup-health] ERROR: no AIPMS backup found" >&2
  exit 1
fi

NOW=$(date +%s)
AGE=$((NOW - LATEST_MTIME))
if [ "$AGE" -lt -300 ]; then
  echo "[backup-health] ERROR: newest backup timestamp is in the future" >&2
  exit 1
fi
if [ "$AGE" -gt "$MAX_AGE" ]; then
  echo "[backup-health] ERROR: newest backup is stale (${AGE}s)" >&2
  exit 1
fi

SIDECAR="$LATEST.sha256"
if [ ! -f "$SIDECAR" ]; then
  echo "[backup-health] ERROR: checksum sidecar is missing" >&2
  exit 1
fi
EXPECTED=$(tr -d '[:space:]' < "$SIDECAR")
ACTUAL=$(sha256sum "$LATEST" | awk '{print $1}')
if ! [[ "$EXPECTED" =~ ^[[:xdigit:]]{64}$ ]] || [ "${EXPECTED,,}" != "$ACTUAL" ]; then
  echo "[backup-health] ERROR: checksum mismatch" >&2
  exit 1
fi
gunzip -t "$LATEST"
SIZE=$(wc -c < "$LATEST")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup-health] ERROR: newest backup is suspiciously small" >&2
  exit 1
fi

printf '{"ok":true,"file":"%s","ageSeconds":%s,"sizeBytes":%s,"checkedAt":"%s"}\n' \
  "$(basename "$LATEST")" "$AGE" "$SIZE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
