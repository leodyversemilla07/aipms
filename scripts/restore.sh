#!/usr/bin/env bash
#
# §16.2 single-tenant restore — load a backup produced by scripts/backup.sh.
#
#   scripts/restore.sh backups/aipms-20260825-020000.sql.gz
#
# Rollback procedure (spec §16.2.1): stop every application writer, restore
# the dump, pin the previous image tag, then recreate the API so its entrypoint
# applies pending migrations before dependants start.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup-file.sql.gz>" >&2
  exit 1
fi
FILE="$1"
[ -f "$FILE" ] || { echo "not found: $FILE" >&2; exit 1; }
gunzip -t "$FILE"  # refuse a corrupt archive before touching the database

echo "[restore] stopping api + web + agent so nothing writes during restore"
docker compose stop agent web api || true

echo "[restore] restoring $FILE into ${POSTGRES_DB:-aipms}"
gunzip -c "$FILE" | docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-user}" -d "${POSTGRES_DB:-aipms}" -q -b -v ON_ERROR_STOP=1

echo "[restore] recreating api (migrate-deploy runs in its entrypoint)"
docker compose up -d --force-recreate api
echo "[restore] restarting dependent services"
docker compose up -d web agent
echo "[restore] done — verify with: docker compose ps && curl -fsS localhost:${API_PORT:-3001}/health"
