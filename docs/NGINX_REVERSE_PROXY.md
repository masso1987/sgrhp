# Servir SGRHP derrière nginx (VPS partagé) + TLS certbot

À utiliser quand le VPS héberge **déjà** un autre site servi par **nginx** sur les
ports 80/443. Dans ce cas, Caddy (du `docker-compose.prod.yml`) ne peut pas prendre
les ports : on **retire Caddy** et c'est **nginx** qui sert de reverse proxy vers
l'application, avec un certificat Let's Encrypt géré par certbot.

Architecture :

```
Internet ──443──> nginx (hôte, partagé) ──> http://127.0.0.1:4000 (conteneur app)
                      │
                      └──> autre site (server_name différent) — inchangé
```

L'application écoute sur `127.0.0.1:4000` (uniquement en local, jamais exposée
directement sur Internet). La base `db` et le volume `uploads` restent en Docker.

---

## 0. Prérequis
- L'enregistrement DNS **A** `portal.mboketech.com` pointe déjà vers ce serveur.
- nginx tourne et sert un autre `server_name` (ne pas y toucher).
- La pile Docker est lancée (`db` + `app` « Up (healthy) »).

## 1. Retirer Caddy et lancer SANS l'override prod

Le `docker-compose.prod.yml` est spécifique à Caddy : on ne l'utilise plus ici.

```bash
cd /opt/sgrhp
docker rm -f sgrhp-caddy-1            # supprime le conteneur Caddy inutile

# Démarrage avec la SEULE base compose (l'app reste sur 127.0.0.1:4000)
docker compose -f docker-compose.yml up -d
docker ps                            # app doit afficher 127.0.0.1:4000->4000
```

Si vous aviez exporté `COMPOSE_FILE`, retirez-le pour ne plus charger l'override :
```bash
unset COMPOSE_FILE
sed -i '/^COMPOSE_FILE=/d' /opt/sgrhp/.env 2>/dev/null || true
```

> L'app doit rester liée à **`127.0.0.1:4000`** (local only). Si `docker ps`
> montre `0.0.0.0:4000`, mettez `APP_PORT=127.0.0.1:4000` dans `.env` puis
> `docker compose -f docker-compose.yml up -d`.

## 2. Bloc nginx pour le domaine

```bash
cat >/etc/nginx/sites-available/portal.mboketech.com <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name portal.mboketech.com;

    client_max_body_size 30m;   # téléversements (pièces, photos, imports)

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket (chat /ws)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
EOF

ln -s /etc/nginx/sites-available/portal.mboketech.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx   # "test is successful" avant de recharger
```

## 3. Certificat TLS (certbot)

```bash
apt-get update && apt-get install -y certbot python3-certbot-nginx   # si absent

certbot --nginx -d portal.mboketech.com --non-interactive --agree-tos \
  -m mmsferdine@gmail.com --redirect
```

certbot ajoute `listen 443 ssl`, les chemins du certificat et la redirection
HTTP→HTTPS dans le bloc ci-dessus, puis recharge nginx. Le renouvellement
automatique est installé (`systemctl status certbot.timer`).

## 4. Vérification

```bash
curl -sS https://portal.mboketech.com/health ; echo     # doit renvoyer le JSON de santé
```

Puis ouvrir le site dans un navigateur et se connecter. L'autre site du VPS
n'est pas affecté (server_name distinct).

---

## Dépannage

- **`nginx -t` échoue** : corriger la syntaxe indiquée avant tout reload.
- **502 Bad Gateway** : l'app n'est pas joignable sur `127.0.0.1:4000`.
  Vérifier `docker ps` (app « Up ») et `docker compose -f docker-compose.yml logs --tail=50 app`.
- **certbot : challenge failed** : le DNS ne pointe pas (encore) ici, ou le port
  80 n'est pas ouvert au pare-feu (`ufw allow 80,443/tcp`).
- **Téléversements refusés (413)** : augmenter `client_max_body_size`.

## Renouvellement & exploitation
- Certificat : renouvelé automatiquement par `certbot.timer`.
- Mise à jour de l'app : `cd /opt/sgrhp && git pull && docker compose -f docker-compose.yml up -d --build`.
- nginx ne redémarre pas l'app ; après un `up`, aucune action nginx nécessaire
  (le proxy pointe vers un port fixe).
