# SGRHP — Guide de déploiement

## 1. Démarrage rapide (développement)

```bash
npm install
npm start                      # http://localhost:4000 — stockage JSON
```
Comptes de démonstration (mot de passe `demo123`) : `gpf@`, `cd@`, `rj@`, `ui@`, `admin@cible-rh.ci`

## 2. Production avec Docker (recommandé)

```bash
cp .env.example .env           # renseigner JWT_SECRET, DB_PASSWORD
docker compose up -d --build
docker compose logs -f app
```
L'application démarre sur le port 4000 avec PostgreSQL, la 2FA administrateur activée
et le contrôle de débit. Vérification : `curl http://localhost:4000/health`

### Migration des données existantes
```bash
DATABASE_URL=postgres://... node db/migrate.js data/db.json
```

## 3. Déploiement Azure

| Composant | Service | Configuration |
|---|---|---|
| Application | Azure App Service (conteneur) | image construite depuis `Dockerfile` |
| Base de données | Azure Database for PostgreSQL | `DATABASE_URL`, `PGSSL=require` |
| Fichiers | Azure Blob Storage | `AZURE_STORAGE_ACCOUNT`, Managed Identity |
| Secrets | Azure Key Vault | `JWT_SECRET`, mot de passe base |
| Sauvegardes | Blob GRS/ZRS + PITR PostgreSQL | rétention 30 jours |

Étapes :
1. Créer le compte de stockage et activer une **Managed Identity** sur l'App Service.
2. Attribuer le rôle **Storage Blob Data Contributor** à cette identité (aucune clé dans le code).
3. Renseigner les variables d'environnement (voir `.env.example`).
4. Déployer l'image, puis exécuter la migration des données.

## 4. Sécurité

- Mots de passe : scrypt, politique 10 caractères minimum avec majuscule, minuscule et chiffre
- 2FA TOTP obligatoire pour les administrateurs (`ENFORCE_2FA=true`)
- Verrouillage du compte après 5 échecs (15 minutes), tentatives journalisées
- Limitation de débit sur `/api/login` et sur l'API
- En-têtes de sécurité (helmet), TLS assuré par le reverse proxy / App Service
- Journal d'audit en ajout seul (déclencheur PostgreSQL empêchant modification et suppression)

## 5. Sauvegardes

```bash
./scripts/backup.sh                       # dump base + fichiers, rétention 30 j
./scripts/restore.sh backups/sgrhp-....dump
```
Planifier via cron : `0 2 * * * cd /opt/sgrhp && ./scripts/backup.sh`

## 6. Tests

```bash
bash test/run-all.sh          # 159 vérifications automatisées
```
Exécutés automatiquement sur chaque push par GitHub Actions (`.github/workflows/ci.yml`).

## 7. Reste à faire avant la mise en production

- [ ] Fournir l'abonnement Azure et créer les ressources (stockage, base, Key Vault)
- [ ] Migrer les dossiers du personnel existants
- [ ] Charger les modèles restants (mise à disposition, attestations, certificats)
- [ ] Configurer SMTP/SMS pour les notifications par email et SMS
- [ ] Former les administrateurs et utilisateurs clés (phase 2 du cahier des charges)
- [ ] Recette utilisateur puis bascule progressive par module
