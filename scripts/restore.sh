#!/usr/bin/env bash
#
# §16.2 single-tenant restore — load a backup produced by scripts/backup.sh.
#
#   scripts/restore.sh backups/aipms-20260825-020000.sql.gz
#
# Rollback procedure (spec §16.2.1): stop web/agent, restore the dump, pin the
# previous image tag, start again. The api entrypoint applies pending
# migrations on boot, so a restore to an older schema version is safe.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup-file.sql.gz>" >&2
  exit 1
fi
FILE="$1"
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }
gunzip -t "$FILE"  # refuse a corrupt archive before touching the database

echo "[restore] stopping web + agent so nothing writes during restore"
docker compose stop web agent || true

echo "[restore] restoring $FILE into ${POSTGRES_DB:-aipms}"
gunzip -c "$FILE" | docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-user}" -d "${POSTGRES_DB:-aipms}" -q -b -v ON_ERROR_STOP=1

echo "[restore] restarting stack (api will migrate-deploy on boot)"
docker compose up -d
echo "[restore] done — verify with: docker compose ps && curl -fs localhost:${API_PORT:-3001}/health"
