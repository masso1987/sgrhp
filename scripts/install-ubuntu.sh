#!/usr/bin/env bash
# SGRHP — one-shot installation on a fresh Ubuntu 22.04/24.04 server.
# Usage:  sudo bash scripts/install-ubuntu.sh yourdomain.com you@email.com
set -euo pipefail

DOMAIN="${1:?usage: install-ubuntu.sh <domain> <email>}"
EMAIL="${2:?usage: install-ubuntu.sh <domain> <email>}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 1/5 System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw >/dev/null

echo "==> 2/5 Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
docker --version

echo "==> 3/5 Firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null || true
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -6

echo "==> 4/5 Configuration"
cd "$APP_DIR"
if [ ! -f .env ]; then
  cat > .env <<ENVEOF
JWT_SECRET=$(openssl rand -hex 32)
DB_PASSWORD=$(openssl rand -hex 24)
DATABASE_URL=postgres://sgrhp:PLACEHOLDER@db:5432/sgrhp
NODE_ENV=production
ENFORCE_2FA=true
TENANT_ID=t1
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
ENVEOF
  DBPW=$(grep '^DB_PASSWORD=' .env | cut -d= -f2)
  sed -i "s|postgres://sgrhp:PLACEHOLDER@db:5432/sgrhp|postgres://sgrhp:${DBPW}@db:5432/sgrhp|" .env
  chmod 600 .env
  echo "Generated .env with fresh secrets."
else
  echo ".env already present — leaving it untouched."
fi

echo "==> 5/5 Build & start"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
sleep 10
docker compose ps

# nightly backup at 02:00
CRON="0 2 * * * cd $APP_DIR && docker compose exec -T db pg_dump -U sgrhp sgrhp > $APP_DIR/backups/sgrhp-\$(date +\%Y\%m\%d).sql 2>/dev/null"
mkdir -p "$APP_DIR/backups"
( crontab -l 2>/dev/null | grep -v 'sgrhp-\$' ; echo "$CRON" ) | crontab -
echo "Nightly backup scheduled (02:00)."

cat <<DONE

===========================================================
 SGRHP est déployé.

 URL      : https://$DOMAIN   (certificat TLS automatique)
 Santé    : https://$DOMAIN/health

 IMPORTANT — à faire immédiatement :
  1. Connectez-vous avec admin@cible-rh.ci / demo123
  2. Configurez la 2FA (obligatoire en production)
  3. Changez TOUS les mots de passe de démonstration
  4. Supprimez les comptes de démonstration inutilisés

 Journaux : docker compose logs -f app
 Arrêt    : docker compose down
===========================================================
DONE
