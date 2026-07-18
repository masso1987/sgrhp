#!/usr/bin/env bash
# Nightly backup: PostgreSQL dump + uploaded files. Keeps 30 days.
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M)
DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$DIR"

if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" --no-owner --format=custom -f "$DIR/sgrhp-$STAMP.dump"
  echo "Database dumped to $DIR/sgrhp-$STAMP.dump"
else
  cp data/db.json "$DIR/db-$STAMP.json"
  echo "JSON store copied to $DIR/db-$STAMP.json"
fi

tar czf "$DIR/uploads-$STAMP.tar.gz" uploads templates 2>/dev/null || true
find "$DIR" -type f -mtime +30 -delete
echo "Backup complete. Retention: 30 days."
