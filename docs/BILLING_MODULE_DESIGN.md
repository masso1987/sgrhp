# SGRHP — Module Facturation : conception & plan de programmation

Refonte du module Odoo `cible_gpf_suivi` (30+ modèles par client) en **un moteur unique
paramétrable, automatisé et auditable**, intégré à l'application SGRHP (même socle
Node.js/Express + JSON/PostgreSQL que les modules RH et Paie).

Principe directeur du cahier de charges : **ajouter un client = configurer, pas coder.**
Un seul moteur de calcul testé au franc CFA près, piloté par un contrat client.

---

## 1. Architecture cible (dans le socle SGRHP)

Quatre collections (persistées comme les autres : JSON en dev, `store` PostgreSQL en prod,
scopées par `tenantId`) + un moteur générique.

### `billingContracts` — paramétrage par client (le cœur du savoir)
```
{ id, tenantId, clientCode, clientName,
  billingType: "MAD" | "PRESTATION" | "TONNAGE" | "RECAP" | "PORTAGE" | "CONSULTANT",
  clientBlock: { adresse, rccm, niu, contact },        // bloc client sur la facture
  bankBlock:   { banque, compte, swift },              // bloc banque
  numberFormat: "CLIENT/AAAA/MM/####",                 // numérotation par mois de la fiche
  prorate: "base" | "base+primes",                     // F6
  anciennete: true,                                    // ancienneté auto ON/OFF
  tvaExonere: false,                                   // exonération TVA gérée
  rates: {                                             // tous configurables, sans code
    chargesPatronales: 0.162, tva: 0.1925, ir: 0, fraisGestion: 0.10,
    congesDivisor: 16, finContrat: 0, finDivisor: 3, finPct: 0,
    hsDivisor: 173.33, ancienneteRate: 0.02, ancienneteMinYears: 2,
    margeCRH: 0, standardDays: 30 },
  components: [ /* composants actifs pour ce client, cf. ci-dessous */ ],
  columnMapping: { /* mémoire du mapping Excel par colonne (F1) */ } }
```

### `billingComponents` — catalogue des composants activables
Un composant = une prime / indemnité / HS / panier / assurance / débours / retenue…
```
{ code, label,
  inputMode: "montant" | "heures" | "quantite",
  formula:   "FIXE" | "PCT_BASE" | "BASE_DIV_TAUX" | "FORFAIT" | "QTE_PU",
  stage:     "PRIME" | "HORS_CHARGE" | "PRESTATION" | "RETENUE",   // place dans la cascade
  taux, diviseur, forfait,                                          // paramètres de la formule
  order,                                                            // ordre d'affichage
  active }
```
`stage` détermine **où** le composant entre dans la cascade :
`PRIME` (dans le brut) · `HORS_CHARGE` (après charges, avant frais de gestion) ·
`PRESTATION` (ligne de prestation, type non-MAD) · `RETENUE` (déduite du net, ex. IR).

### `billingSheets` — fiche = client × période, et ses lignes
```
{ id, tenantId, contractId, period: "AAAA-MM", number, status: "draft"|"validated",
  lines: [ { id, employeeId?, name, poste,
             salaireBase, jours, years, primes, horsCharges,
             components: { <code>: { montant|heures|quantite|pu|taux } } } ],
  totals: { brut, charges, fraisGestion, HT, TVA, TTC, IR, netAPayer, count } }
```

### Moteur — `src/billing/engine.js` (livré, testé 16/16)
`computeLine(input, contract)` déroule la cascade selon `billingType` ;
`computeSheet(sheet, contract)` calcule toutes les lignes, **regroupe par poste**, trie
les noms **alphabétiquement**, produit sous-totaux + total général + HT/TVA/TTC de la fiche.

**Cascade MAD (patron dominant)** — intermédiaires non arrondis, arrondi HALF_UP à l'affichage :
```
base_proratée   = salaire_base × jours / 30
ancienneté      = 2 % × base × années           (si années ≥ 2)
brut            = base_proratée + Σ primes + ancienneté
congés          = brut ÷ 16 (ou ÷ 12)
fin de contrat  = congés ÷ 3 (ou × 35 %)         [optionnel]
sous_total      = brut + congés + fin
charges         = sous_total × 16,2 %
total_2         = sous_total + charges + Σ(assurance, communication, déplacement,
                  visite médicale, débours…)     [optionnels]
frais_gestion   = total_2 × 10 % (ou 15 %)
HT              = total_2 + frais_gestion
TVA             = HT × 19,25 %  (ou 0 si exonéré)
TTC             = HT + TVA
IR (retenue)    = HT × 2,2 %                      [ADDAX/SOCAPALM]
```
Autres types : **PRESTATION/TONNAGE** (Σ quantité × PU, + marge CRH 8,5 % pour ADDAX) ·
**RECAP** (HT saisi par ligne, TVA/TTC auto — HEVECAM) · **PORTAGE/CONSULTANT** (montants saisis).

---

## 2. Comment les 34 clients tiennent dans une seule config

| Client | billingType | Config (rates + composants), zéro code |
|---|---|---|
| MIZAO, DENIZOT, SOPURA | MAD | congés ÷16 ou ÷12, FG 10/15 %, ancienneté auto |
| SOLEVO, DHL, SUNU, NESTLE, MAJESTIC, WWF, WCS, CAMRAIL | MAD | composants variables activés au contrat |
| LG / DANGOTE | MAD | séniorité, prime perf, 13ᵉ mois / HS 200 %, technicité |
| CIMPOR MAD | MAD | HS 120–200 via `BASE_DIV_TAUX` (÷173,33), prime nuit |
| CIMPOR PREST / CLEANER | PRESTATION | forfaits 570/744, taux horaire |
| COTCO (BASE/NG/ACCESS) | PRESTATION | U.P × jours, OT = U.P/8, par poste |
| SOSUCAM | TONNAGE | quantité × coût/T, + rému fixe |
| ADDAX (+ réimbursables) | PRESTATION | marge CRH 8,5 %, IR 2,2 %, net à payer |
| SOCAPALM | PRESTATION | prestations + retenues (IR) éditables |
| HEVECAM | RECAP | TOTAL HT saisi, TVA/TTC auto |
| PERENCO | PRESTATION | site/fonction, jours × PU |
| SIC CACAO | PRESTATION | 3 types : Heure / Projet / Sourcing |
| BARRY | MAD/PRESTATION | regroupé par poste, noms alphabétiques |
| STAT / GEB | PORTAGE / CONSULTANT | montants unitaires, multi-pays |

---

## 3. Liens avec les deux autres modules

- **Paie → Facturation** : la fiche facturation récupère, par employé, le `salaire_base`,
  les primes et l'**ancienneté** (calculée depuis `hireDate`, déjà dans le dossier RH) et les
  **jours travaillés**. Le bouton *« Importer depuis la paie »* pré-remplit les lignes MAD
  à partir des employés d'un portefeuille — pas de re-saisie.
- **Facturation → Comptabilité** : chaque facture validée produit des écritures (comme la
  *passation comptable* de la paie) : `411 Client` (débit TTC), `7xx Produits` (crédit HT),
  `4432 TVA collectée` (crédit TVA), et le cas échéant la retenue IR. Le futur module Compta
  consomme ce journal — le pont est prévu dès la conception (modèle comptable paramétrable).

---

## 4. Disposition de l'interface (layout)

Nouvelle entrée de menu **🧾 Facturation** (gated par le module, comme la Paie), avec :

1. **Clients & contrats** — liste des clients ; fiche contrat = type de facturation, taux,
   composants actifs, blocs client/banque, format de numéro, exonération TVA. *(Manager)*
2. **Catalogue des composants** — primes/indemnités/HS/retenues et leurs formules. *(Manager)*
3. **Fiches (annexes)** — par client × période : statut (brouillon/validée), total HT/TVA/TTC.
   - **Détail de la fiche** : onglets *Import Excel* · *Lignes (saisie Entrées/Calculé)* ·
     *Annexe calculée* (regroupée par poste, sous-totaux, noms A→Z) · *Facture*.
   - Actions : *Calculer* · *Reprendre le mois précédent* · *Générer PDF/Excel* · *Valider*.
4. **Génération de masse** — un mois, un clic : toutes les annexes + factures en brouillon.
5. **Récapitulatif mensuel** — une ligne par facture (Source/Client · N° · Date · HT · TVA ·
   TTC), nombre de factures, ΣHT/ΣTVA/ΣTTC ; sortie écran / PDF / Excel.
6. **Contrôle qualité** — rapprochement annexe ↔ Excel source (écarts au franc), contrôles de
   cohérence (jours ≤ 30, taux renseignés, doublon employé/période).
7. **Paramètres facturation** *(ADM)* — taux par défaut, modèle comptable, format de numéro.

Accès : rôle **Agent** (saisie, pas de suppression) et **Manager** (tout + impression),
**restriction par client** possible — réutilise le modèle de droits déjà en place (rôles +
permissions attribuables + portefeuilles).

---

## 5. Automatisation (exigences A1–A4 + F1/F10/F12/F14)

- **Import Excel** (F1) : téléverser le fichier client, mapper les colonnes (mémorisé par
  contrat via `columnMapping`), créer les lignes automatiquement.
- **Génération de masse** (F10) : toutes les annexes/factures d'un mois en un clic.
- **Récapitulatif mensuel consolidé** (F12) : ΣHT/ΣTVA/ΣTTC tous clients, PDF + Excel.
- **Contrôle qualité automatique** (F14/F15) : comparaison annexe ↔ source, alertes d'écart.
- **Génération planifiée fin de mois** (A2) : brouillons prêts à valider (tâche programmée).
- **Alertes** (A3) : fiches incomplètes, écarts détectés, périodes non facturées.
- **Piste d'audit** (A4) : chaque calcul journalisé (qui, quand, quelles valeurs) — réutilise
  l'`audit` existant.
- **Sauvegarde** (A1) : la sauvegarde quotidienne chiffrée (base + module) est déjà en place au
  niveau infra ; la facturation en hérite.

---

## 6. Plan de programmation (par phases, comme la Paie)

- **Phase 1 — Socle & moteur** ✅ *(démarré)* : `billing.engine` paramétrable + tests au franc
  (16/16). Collections `billingContracts/Components/Sheets`. Moteur validé.
- **Phase 2 — Contrats & composants (config)** : écrans Clients/Contrats + Catalogue,
  CRUD, taux par client, activation des composants. *(ajouter un client = configurer)*
- **Phase 3 — Fiches & calcul** : saisie par ligne (Entrées/Calculé), *Calculer*, *Reprendre
  le mois précédent*, import depuis la Paie, regroupement par poste + total général.
- **Phase 4 — Import Excel + génération** : mapping mémorisé, annexe + facture (en-tête CIBLE,
  bloc client/banque, **montant en toutes lettres**, TVA exonérée), numérotation par mois,
  PDF + Excel, génération de masse.
- **Phase 5 — Récapitulatif mensuel + contrôle qualité** : récap consolidé (PDF/Excel),
  rapprochement annexe ↔ Excel, contrôles de cohérence.
- **Phase 6 — Automatisation & comptabilité** : génération planifiée, alertes, piste d'audit
  détaillée, **pont vers la Comptabilité** (journal des ventes paramétrable).

Chaque phase se termine par : tests, validation au franc contre une annexe réelle si possible,
commit + push, note de déploiement — méthode identique à celle de la Paie.

---

## 7. Points de vigilance repris du cahier (§3.3)

- Arrondi : intermédiaires **non** arrondis, arrondi HALF_UP à l'affichage (déjà appliqué).
- Séquence de numéro reflétant **le mois de la fiche** (préfixe `CLIENT/AAAA/MM`).
- Droits : un écran n'apparaît que si l'utilisateur a le droit sur le modèle sous-jacent
  (déjà le comportement du menu SGRHP).
- En-tête PDF répété par page, sans dépendre d'un layout fragile.
