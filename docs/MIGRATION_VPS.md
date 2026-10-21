# Transfert vers un nouveau VPS (même domaine : portal.mboketech.com)

Objet : déplacer l'application SGRHP d'un VPS vers un autre, en conservant le
domaine et **toutes les données** (base PostgreSQL, fichiers téléversés, modèles,
secrets, comptes/2FA). Temps d'indisponibilité visé : quelques minutes.

La pile tourne en Docker : base `db` (volume `pgdata`), application `app`
(uploads dans le volume `uploads`, `./templates` monté depuis le disque), et
`caddy` (TLS Let's Encrypt automatique, volumes `caddy_data`/`caddy_config`).
Les secrets sont dans `/opt/sgrhp/.env`.

> **Règle d'or : ne jamais faire pointer le DNS vers le nouveau serveur tant que
> les données n'y sont pas restaurées et testées.** On prépare le nouveau
> serveur à fond, puis on bascule le DNS en dernier.

---

## 0. Préparatifs (la veille)

1. **Abaisser le TTL DNS** de l'enregistrement A `portal.mboketech.com` à 300 s
   (5 min) chez votre registrar. Cela rend la bascule quasi immédiate le jour J.
2. Noter l'**IP de l'ancien** et de **nouveau** serveur.
3. S'assurer d'avoir un accès `root`/`sudo` SSH aux deux.

---

## 1. Sur l'ANCIEN serveur — sauvegarde complète

```bash
cd /opt/sgrhp

# (recommandé) Geler les écritures le temps de la copie : on coupe l'app,
# la base et Caddy restent up pour le dump. Prévenir les utilisateurs.
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app

# 1a. Dump de la base PostgreSQL (format custom) dans ./backups
mkdir -p backups
docker compose exec -T db pg_dump -U sgrhp --no-owner --format=custom sgrhp > backups/migrate.dump

# 1b. Nom réel des volumes (le préfixe = nom du dossier, souvent "sgrhp")
docker volume ls | grep -E 'uploads|pgdata'
#   -> note les noms exacts, ex. sgrhp_uploads

# 1c. Export du volume uploads (photos de pointage, lettres, pièces, docs générés)
docker run --rm -v sgrhp_uploads:/v -v "$PWD/backups":/out alpine \
  tar czf /out/uploads.tar.gz -C /v .

# 1d. Modèles (.docx) : montés depuis le disque, à copier aussi
tar czf backups/templates.tar.gz templates

# 1e. Le fichier de secrets
cp .env backups/env.backup
```

> Si vous utilisez **Azure Blob** pour les fichiers (`AZURE_STORAGE_ACCOUNT`
> renseigné dans `.env`), les uploads sont dans le cloud : sautez 1c, rien à
> copier côté fichiers.

Vous avez maintenant dans `/opt/sgrhp/backups/` : `migrate.dump`,
`uploads.tar.gz`, `templates.tar.gz`, `env.backup`.

---

## 2. Transférer les sauvegardes vers le NOUVEAU serveur

Depuis l'ancien (ou votre poste) :

```bash
# Crée le dossier côté nouveau serveur puis copie
ssh root@NOUVELLE_IP 'mkdir -p /opt/sgrhp-restore'
scp /opt/sgrhp/backups/{migrate.dump,uploads.tar.gz,templates.tar.gz,env.backup} \
    root@NOUVELLE_IP:/opt/sgrhp-restore/
```

---

## 3. Sur le NOUVEAU serveur — installation

```bash
# 3a. Docker + pare-feu
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# 3b. Code
git clone https://github.com/masso1987/sgrhp.git /opt/sgrhp
cd /opt/sgrhp

# 3c. Secrets : REPRENDRE le même .env (garde JWT_SECRET et DB_PASSWORD
#     identiques -> sessions, jetons et mots de passe restent valides)
cp /opt/sgrhp-restore/env.backup .env

# 3d. Modèles
tar xzf /opt/sgrhp-restore/templates.tar.gz -C /opt/sgrhp
```

---

## 4. Restaurer les données (AVANT la bascule DNS)

```bash
cd /opt/sgrhp

# 4a. Démarrer uniquement la base, attendre qu'elle soit "healthy"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db
until [ "$(docker compose exec -T db pg_isready -U sgrhp >/dev/null 2>&1; echo $?)" = 0 ]; do sleep 2; done

# 4b. Restaurer le dump dans la base (recrée tables + données)
cat /opt/sgrhp-restore/migrate.dump | \
  docker compose exec -T db pg_restore -U sgrhp --clean --if-exists --no-owner -d sgrhp

# 4c. Restaurer le volume uploads (vérifier d'abord le nom du volume créé)
docker volume ls | grep uploads   # ex. sgrhp_uploads
docker run --rm -v sgrhp_uploads:/v -v /opt/sgrhp-restore:/in alpine \
  sh -c 'cd /v && tar xzf /in/uploads.tar.gz'

# 4d. Démarrer l'application + Caddy (construit l'image)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose ps
```

---

## 5. Tester le nouveau serveur AVANT de basculer le DNS

Le certificat TLS ne peut s'émettre qu'une fois le DNS pointé, mais on peut déjà
vérifier l'app en direct par l'IP :

```bash
# Santé de l'app (via le réseau Docker interne)
docker compose exec -T app wget -qO- http://localhost:4000/health ; echo
```

Pour un test navigateur complet avant bascule, ajoutez temporairement sur **votre
poste** (pas le serveur) une ligne dans `/etc/hosts` (ou `C:\Windows\System32\drivers\etc\hosts`) :

```
NOUVELLE_IP   portal.mboketech.com
```

Ouvrez `https://portal.mboketech.com`, connectez-vous (ex. un compte réel),
vérifiez : employés présents, bulletins/duplicata, pièces téléversées qui
s'ouvrent, écritures comptables. **Retirez la ligne hosts** après le test.

---

## 6. Bascule DNS (le moment du transfert)

1. Chez le registrar, modifier l'enregistrement **A** `portal.mboketech.com`
   → **NOUVELLE_IP**.
2. Grâce au TTL abaissé, la propagation prend quelques minutes.
3. **Caddy émet automatiquement** le certificat Let's Encrypt dès que le domaine
   résout vers la nouvelle IP et que les ports 80/443 sont ouverts — rien à
   copier côté certificats. Suivre :
   ```bash
   docker compose logs -f caddy      # attendre "certificate obtained"
   ```
4. Vérifier en clair (sans bidouille hosts) :
   ```bash
   curl -sS https://portal.mboketech.com/health ; echo
   ```

> Les deux serveurs ne doivent pas répondre au domaine en même temps pour le défi
> ACME. Comme on a coupé l'app de l'ancien à l'étape 1 et qu'on bascule le DNS
> d'un coup, c'est net. Ne gardez pas l'ancien Caddy en train de servir le domaine.

---

## 7. Fenêtre d'écritures manquées (si l'app de l'ancien a tourné après le dump)

Si des utilisateurs ont pu écrire sur l'ancien serveur **entre** le dump (1a) et
la bascule, refaites un dump final sur l'ancien et réimportez-le sur le nouveau
pendant la fenêtre de bascule. Le plus simple : garder l'app de l'ancien **à
l'arrêt** depuis l'étape 1 jusqu'à la fin — ainsi aucune écriture n'est perdue.

---

## 8. Après bascule

1. Se connecter en admin, contrôler les effectifs, une paie clôturée, une pièce
   téléversée, une écriture comptable.
2. Vérifier l'application **mobile** (le domaine n'a pas changé, donc rien à
   reconstruire côté APK).
3. Reprogrammer la sauvegarde quotidienne sur le nouveau serveur :
   ```bash
   (crontab -l 2>/dev/null; echo "30 2 * * * cd /opt/sgrhp && ./scripts/backup.sh >> /var/log/sgrhp-backup.log 2>&1") | crontab -
   ```
4. **Garder l'ancien serveur intact 48–72 h** (sans servir le domaine) comme
   filet de sécurité, puis le décommissionner.
5. Remonter le TTL DNS à sa valeur habituelle.
6. Nettoyer : `rm -rf /opt/sgrhp-restore` sur le nouveau serveur (contient des
   secrets et des données).

---

## Annexe A — Transfert manuel des sauvegardes (si `scp` tombe en timeout)

Les 4 fichiers de l'étape 1 sont dans `/opt/sgrhp/backups/` sur l'ANCIEN serveur :
`migrate.dump`, `uploads.tar.gz`, `templates.tar.gz`, `env.backup`.

```bash
ls -lh /opt/sgrhp/backups/migrate.dump /opt/sgrhp/backups/uploads.tar.gz \
       /opt/sgrhp/backups/templates.tar.gz /opt/sgrhp/backups/env.backup
```

Au lieu de `scp`, utiliser un client SFTP (**WinSCP** ou **FileZilla**) qui
reprend automatiquement en cas de coupure : se connecter à l'ancien serveur,
télécharger les 4 fichiers depuis `/opt/sgrhp/backups/`, puis les téléverser sur
le nouveau serveur dans `/opt/sgrhp-restore/`.

Si un gros fichier (souvent `uploads.tar.gz`) coupe sans cesse, le découper :
```bash
# ANCIEN : morceaux de 100 Mo
split -b 100m /opt/sgrhp/backups/uploads.tar.gz /opt/sgrhp/backups/uploads.part-
# NOUVEAU : après avoir téléversé tous les morceaux dans /opt/sgrhp-restore/
cat /opt/sgrhp-restore/uploads.part-* > /opt/sgrhp-restore/uploads.tar.gz
```
Ou, si les deux serveurs se joignent, `rsync` avec reprise (depuis l'ancien) :
```bash
rsync --partial --progress -e ssh /opt/sgrhp/backups/uploads.tar.gz root@NOUVELLE_IP:/opt/sgrhp-restore/
```
> `env.backup` et `migrate.dump` contiennent des secrets et des données :
> supprimez-les de votre PC une fois en sécurité sur le nouveau serveur.

## Annexe B — DNS des conteneurs en panne (IPv6) → « timeouts » réseau

Symptôme : les conteneurs n'atteignent rien (pull d'images, `npm`, ACME) avec des
erreurs du type `lookup ... on [IPv6]:53 ... connect: network is unreachable`,
alors que l'hôte, lui, accède bien à Internet (`curl -4 https://... ` fonctionne).
Cause : Docker donne aux conteneurs un résolveur **IPv6** non routé. Forcer l'IPv4 :

```bash
cat >/etc/docker/daemon.json <<'EOF'
{ "dns": ["1.1.1.1", "8.8.8.8"] }
EOF
systemctl restart docker
```

Les conteneurs (policy `restart: unless-stopped`) repartent seuls. À faire **avant**
tout build/pull si les timeouts apparaissent. Nécessaire aussi pour que l'app
joigne le SMTP (digest e-mail) et le web.

## Annexe C — Le VPS héberge DÉJÀ un site sous nginx (ports 80/443 occupés)

Si `ss -tlnp '( sport = :80 or sport = :443 )'` montre **nginx** sur les ports web
et qu'on ne peut pas le retirer (un autre site l'utilise), alors **Caddy ne peut
pas servir le domaine**. On abandonne Caddy et on met nginx en reverse proxy vers
l'app (`127.0.0.1:4000`) avec certbot pour le TLS.

→ Procédure complète : **`docs/NGINX_REVERSE_PROXY.md`**.

En résumé : `docker rm -f sgrhp-caddy-1`, démarrer avec la seule base compose
(`docker compose -f docker-compose.yml up -d`), ajouter un `server_name
portal.mboketech.com` qui `proxy_pass http://127.0.0.1:4000`, puis
`certbot --nginx -d portal.mboketech.com`.

## Récapitulatif des éléments transférés

| Élément | Où | Comment |
|---|---|---|
| Base de données (tout le métier, comptes, 2FA) | volume `pgdata` | `pg_dump` → `pg_restore` |
| Fichiers téléversés (photos pointage, pièces, docs) | volume `uploads` | tar du volume (ou Azure Blob, rien à copier) |
| Modèles .docx | `./templates` (disque) | tar du dossier |
| Secrets (JWT, mot de passe DB, domaine) | `.env` | copie telle quelle |
| Certificat TLS | volume `caddy_data` | **non copié** — réémis automatiquement |
