#!/usr/bin/env bash
# Restore a backup: scripts/restore.sh backups/sgrhp-YYYYMMDD-HHMM.dump
set -euo pipefail
FILE="${1:?usage: restore.sh <dump-file>}"
if [[ "$FILE" == *.dump ]]; then
  pg_restore --clean --if-exists --no-owner -d "${DATABASE_URL:?DATABASE_URL required}" "$FILE"
else
  cp "$FILE" data/db.json
fi
echo "Restored from $FILE"
