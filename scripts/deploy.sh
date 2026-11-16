#!/usr/bin/env bash
# MBOKA Mon RH - deploy the latest "main" on the server (run from /opt/sgrhp).
#   1. back up the database   2. update the code   3. rebuild + restart   4. wait for /health
# Usage on the server:  bash scripts/deploy.sh          (add --force to rebuild with no new code)
set -e
cd "$(dirname "$0")/.."
BRANCH=main

# Same compose setup as the running app: with Caddy (prod override) or behind nginx (base file only)
if docker ps --format '{{.Names}}' | grep -qi caddy; then
  COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
else
  COMPOSE="docker compose -f docker-compose.yml"
fi
echo "Compose: $COMPOSE"

git fetch --quiet origin "$BRANCH"
BEFORE=$(git rev-parse --short HEAD)
LATEST=$(git rev-parse --short "origin/$BRANCH")
if [ "$BEFORE" = "$LATEST" ] && [ "${1:-}" != "--force" ]; then
  echo "Already up to date ($BEFORE) - nothing to deploy."
  exit 0
fi

# 1) Database backup (keeps the last 10)
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M)
if $COMPOSE exec -T db pg_dump -U sgrhp --no-owner --format=custom sgrhp < /dev/null > "backups/pre-deploy-$STAMP.dump" 2>/dev/null; then
  echo "Backup: backups/pre-deploy-$STAMP.dump ($(du -h "backups/pre-deploy-$STAMP.dump" | cut -f1))"
else
  rm -f "backups/pre-deploy-$STAMP.dump"
  echo "WARNING: database backup failed - deploy continues"
fi
ls -1t backups/pre-deploy-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f

# 2) Latest code (stops if someone edited files on the server)
if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  echo "ERROR: local changes on the server block the update:"
  git status --short | head -20
  exit 11
fi
AFTER=$(git rev-parse --short HEAD)
echo "Code: $BEFORE -> $AFTER"
git log --oneline "$BEFORE..$AFTER" | head -20 | sed 's/^/   + /'

# 3) Rebuild and restart the app
$COMPOSE up -d --build app < /dev/null

# 4) Wait until the app answers (max 2 minutes)
echo "Waiting for the app to start..."
for i in $(seq 1 40); do
  if $COMPOSE exec -T app wget -qO- http://localhost:4000/health < /dev/null > /dev/null 2>&1; then
    echo "App is up after $((i * 3)) seconds."
    break
  fi
  sleep 3
  if [ "$i" = 40 ]; then
    echo "ERROR: the app did not answer after 2 minutes. Last logs:"
    $COMPOSE logs --tail=40 app
    exit 12
  fi
done
$COMPOSE ps
docker image prune -f > /dev/null 2>&1 || true
echo "DEPLOY SUCCESSFUL - version $AFTER"
