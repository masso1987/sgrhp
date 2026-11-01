# MBOKA Paie — Analyse et optimisation de la structure salariale : conception

Fonctionnalité qui **analyse la structure de rémunération d'un salarié**, dit si elle est
optimisée et conforme, **compare** avec une structure optimisée et produit un **rapport avec
conseils**, références légales et niveau de risque.

Statut : conception à valider, aucun code écrit. Décisions prises avec le client le 31/10/2026.

| Décision | Choix retenu |
|---|---|
| Modes | **3 modes** : (1) net maximal à coût employeur constant ; (2) coût employeur minimal à net constant (jamais inférieur) ; (3) audit de conformité seul |
| Niveau de conseil | **Règles sûres + justifiées** : textes explicites, plus indemnités de frais uniquement si l'emploi les justifie, chaque conseil étiqueté *sûr / à justifier* avec les pièces à conserver ; pas de montage agressif |
| Utilisateurs | **Équipe paie (Cible RH)** sur tous les portefeuilles, **ADM client** sur ses propres salariés |
| Logement et CNPS | **Selon le profil de paie** (voir « Profils de paie ») ; l'analyse montre l'impact de chaque option |
| CFC patronal | **1,5 %** (valeur Sage/app conservée) |
| Emplacement | **Module RH** : bouton « Analyser la rémunération » sur la fiche salarié et menu RH › Analyse salariale |
| Moment d'utilisation | **Avant la paie** : dès que le salarié est créé (Gestion Admin › Employés) avec ses éléments de salaire ; aucun bulletin nécessaire |
| Nature | **Simulation** : rien n'est modifié ; le résultat compare la structure actuelle et la structure optimisée et explique **pourquoi** c'est mieux, **pour le salarié et pour l'employeur** |

### Parcours type

1. **Gestion Admin › Employés** : création du salarié avec contrat, catégorie, salaire de base et
   éléments de salaire (primes, indemnités) — comme aujourd'hui.
2. **RH › Analyse salariale** (ou bouton **« Analyser la rémunération »** sur sa fiche) : choix du
   mode et des leviers, puis lancement de la simulation.
3. **Résultat** : bulletin simulé actuel vs bulletin simulé optimisé, côte à côte, avec les
   gains et les raisons, vus des deux côtés (salarié / employeur).
4. Si la proposition convient, l'utilisateur **modifie lui-même** les éléments de salaire dans la
   fiche (avec avenant au contrat si nécessaire), puis lance la paie normalement.

---

## 1. Principes

1. **La loi d'abord** : chaque règle cite son texte (CGI 2022, circulaire CNPS, arrêté de 1974,
   Code du travail). Pas de règle sans référence.
2. **Ne jamais baisser un salaire** (Code du travail art. 61, droits acquis) : en mode 2, le
   net du salarié reste au moins égal ; aucune optimisation ne réduit le salaire de base ni ne
   passe sous le minimum conventionnel de la catégorie.
3. **Simulation uniquement** : l'analyse **ne modifie jamais** la paie, les rubriques ni les
   bulletins. Appliquer une recommandation reste une décision humaine (avenant au contrat,
   puis saisie dans la paie).
4. **Même moteur que la paie** : les calculs avant/après utilisent `computePayslip` et le profil
   de paie du salarié — pas de second moteur qui pourrait diverger.
5. **Deux sens** : l'outil signale les économies possibles **et** les risques de redressement
   (indemnité exonérée excessive ou injustifiée, rubrique mal paramétrée).

---

## 2. Base de règles légales

Chaque rubrique d'un profil de paie reçoit une **nature légale** (nouveau champ `legalNature`).
L'analyse raisonne sur la nature, pas sur le code : le même code n'a pas le même sens d'une
base Sage à l'autre (ex. 3513 transport chez PERENCO, déplacement chez WORK OVER).

| Nature légale | IRPP | CNPS | Plafond / condition | Référence | Risque |
|---|---|---|---|---|---|
| `SALAIRE_BASE`, `SURSALAIRE`, `ANCIENNETE`, `HS`, primes liées au travail | imposable | cotisable | base ≥ minimum de catégorie ; ancienneté légale | CGI art. 30, 32 ; Code du travail | — |
| `GRATIFICATION` (13e mois, bonus) | imposable | cotisable | — | CGI art. 30 | — |
| `TRANSPORT` (prime de transport domicile-travail) | imposable | **non cotisable** | montant conventionnel | convention collective ; pratique CNPS | sûr |
| `AN_LOGEMENT` (indemnité représentative de logement) | imposable **dans la limite de 15 %** du salaire brut taxable | selon profil | excédent non imposable | CGI art. 33 (1)(2) ; lettres MINFI 0474 et 4156 de 2003 | sûr |
| `AN_ELECTRICITE` | imposable ≤ 4 % | non cotisable* | idem | CGI art. 33 | sûr |
| `AN_EAU` | imposable ≤ 2 % | non cotisable* | idem | CGI art. 33 | sûr |
| `AN_DOMESTIQUE` | imposable ≤ 5 % par domestique | non cotisable* | idem | CGI art. 33 | sûr |
| `AN_VEHICULE` | imposable ≤ 10 % par véhicule | non cotisable* | idem | CGI art. 33 | sûr |
| `AN_NOURRITURE` | imposable ≤ 10 % | non cotisable* | idem | CGI art. 33 | sûr |
| `FRAIS_PANIER`, `FRAIS_SALISSURE`, `FRAIS_OUTILLAGE`, `FRAIS_KILOMETRIQUE`, `FRAIS_MISSION`, `FRAIS_REPRESENTATION` | **exonéré** | **non cotisable** | « effectivement utilisées conformément à leur objet et non exagérées » ; emploi qui le justifie ; plafond paramétrable | CGI art. 31-1 ; arrêté 003/MTPS-94/MINFI du 01/03/1974 ; circulaire CNPS 021/1991 | **à justifier** |
| `RUPTURE_LICENCIEMENT` (part dommages-intérêts) | exonéré | non cotisable | hors perte de salaire | CGI art. 31-12 ; circulaire CNPS 021/1991 | sûr |
| `RUPTURE_FIN_CARRIERE`, `BONNE_SEPARATION`, `DEPART_RETRAITE` | imposable | non cotisable | — | circulaire CNPS 021/1991 | sûr |
| `PREAVIS`, `CONGES`, `CHOMAGE_TECHNIQUE` | imposable | cotisable | — | circulaire CNPS 021/1991 | — |
| `SOCIAL_EXONERE` (médaille du travail, allocations familiales) | exonéré | non cotisable | — | CGI art. 31-2, 31-11 | sûr |

\* Valeur par défaut, modifiable dans le profil de paie (les bases Sage diffèrent).

**Paramètres transverses** (repris du moteur, déjà conformes aux textes) : IRPP = 70 % ×
imposable − pension CNPS − 500 000/12, barème 10/15/25/35 %, CAC 10 % (art. 29, 34, 69, 71) ;
plafond CNPS 750 000 (pension et prestations familiales), accident du travail non plafonné ;
CFC 1 % salarié (base arrondie au millier inférieur) et 1,5 % patronal ; FNE 1 % ;
RAV et TDL par tranches (RAV : borne haute incluse, ex. 800 000 → 9 750).

**Plafonds des indemnités de frais** (paramètres du profil, car non chiffrés par la loi) : pour
chaque nature `FRAIS_*`, un plafond en montant ou en % du salaire, et une liste d'emplois
éligibles (ex. salissure : entretien, magasin, laboratoire ; panier : travail de nuit ou
chantier). Au-delà du plafond, l'audit signale un **risque de requalification**.

---

## 3. Données d'entrée

| Source | Contenu |
|---|---|
| Salarié | contrat, catégorie/échelon, emploi, ancienneté, portefeuille, **profil de paie** |
| Structure actuelle | **éléments de salaire de la fiche salarié** (salaire de base, sursalaire, primes et indemnités saisis à la création ou à la modification), convertis en bulletin simulé par les fonctions existantes de la paie (`structureToInput`, `elementsToInput`). Aucun bulletin préalable n'est nécessaire ; si un bulletin existe déjà, il peut servir de référence en option |
| Profil de paie | catalogue de rubriques avec `legalNature`, paramètres (taux, plafonds), politique logement/CNPS, plafonds de frais |
| Convention collective | minimum de la catégorie (grille), pour la contrainte « base ≥ minimum » |
| Options de l'analyse | mode (1, 2 ou 3) ; leviers autorisés (cases à cocher) ; « pièces justificatives disponibles » par nature de frais |

---

## 4. Moteur d'analyse

### 4.1 Diagnostic (commun aux 3 modes)

Pour chaque rubrique du bulletin actuel :
1. **Traitement appliqué** : imposable / cotisable tel que paramétré dans le profil.
2. **Traitement légal** : déduit de la nature légale (tableau §2).
3. **Écart** et son impact chiffré (IRPP, CAC, CNPS salarié/patronal, net, coût) :
   - **Surimposition** : ex. indemnité de logement imposée en totalité alors que la limite de
     15 % s'applique ; transport ou électricité traités en salaire plein ; RAV à la borne.
   - **Sous-déclaration (risque)** : indemnité de frais exonérée au-delà du plafond ou sans
     emploi éligible ; avantage en nature non déclaré ; base sous le minimum de catégorie.
   - **Paramétrage incohérent** : même nature traitée différemment dans deux rubriques du profil.

Sortie : liste de **constats** `{ rubrique, type: surimposition|risque|paramétrage, impact
mensuel, impact annuel, référence, niveau: sûr|à justifier, action conseillée }`.

### 4.2 Optimisation (modes 1 et 2)

**Leviers** (chacun activable dans l'écran, tous bornés par la loi et le profil) :

| Levier | Effet | Contraintes |
|---|---|---|
| L1 Appliquer la limite d'art. 33 aux indemnités représentatives existantes | baisse de l'imposable, net ↑ | sûr ; aucun changement de montant versé |
| L2 Reclasser une prime « fourre-tout » en indemnité représentative (logement…) jusqu'à la limite | imposable ↓ ; CNPS selon profil | avenant ; montant total versé inchangé |
| L3 Reclasser en indemnités de frais (panier, salissure, outillage…) | IRPP et CNPS ↓ | **à justifier** ; seulement si l'emploi est éligible et les pièces disponibles ; dans le plafond |
| L4 Transport au montant conventionnel | CNPS ↓ | sûr |
| L5 Corriger les erreurs de paramétrage (RAV, nature mal réglée) | net ↑ | sûr |

**Contraintes dures** (vérifiées à chaque essai) :
- salaire de base inchangé et ≥ minimum de catégorie ;
- net ≥ net actuel (mode 2 : égal ; mode 1 : maximal) ;
- coût employeur ≤ coût actuel (mode 1 : égal ; mode 2 : minimal) ;
- chaque indemnité dans sa limite légale et son plafond de profil ;
- aucune rubrique contractuelle supprimée sans être remplacée à montant égal ou supérieur.

**Algorithme** (déterministe, explicable) :
1. Partir de la structure actuelle ; appliquer les corrections sûres (L1, L5) — elles n'exigent
   aucun avenant.
2. Pour chaque levier autorisé, par ordre de risque croissant puis de gain décroissant :
   déplacer un montant d'une rubrique imposable et cotisable « déplaçable » (prime non liée au
   salaire de base) vers la nature cible, par paliers, en recalculant le bulletin avec
   `computePayslip` ; garder le palier s'il améliore l'objectif sans violer de contrainte.
3. **Mode 1** : à coût constant, le gain de charges est reversé au salarié (hausse d'une prime
   de réajustement jusqu'à épuiser l'écart de coût — même principe que `reverseSolve`).
   **Mode 2** : à net constant, on réduit la prime de réajustement jusqu'à retrouver exactement
   le net actuel (`reverseSolve`), l'économie restant à l'employeur.
4. Résultat : structure optimisée + liste ordonnée des changements, chacun avec son gain propre.

### 4.3 Audit de conformité (mode 3)

Diagnostic seul (§4.1) sur un salarié, un portefeuille ou toute l'entreprise, sans proposition
de restructuration. Utile avant un contrôle CNPS ou fiscal.

---

## 5. Résultats et rapport

### Par salarié
- **Tableau avant / après** : lignes du bulletin, brut, bases CNPS et imposable, IRPP, CAC, CFC,
  RAV, TDL, CNPS salarié et patronal, **net**, **coût employeur total**.
- **Gains** : mensuels et annuels pour le salarié, l'employeur, et l'effet sur les recettes
  publiques (transparence).
- **Recommandations** : pour chacune, texte clair, montant, référence légale, niveau (*sûr /
  à justifier*), **pièces à conserver** (ex. note de frais, attestation d'utilisation du véhicule
  personnel), et **actions** (avenant au contrat, mise à jour de la rubrique dans le profil).
- **Pourquoi c'est mieux, des deux côtés** : chaque recommandation est expliquée deux fois.
  - *Pour le salarié* : effet sur son net, sur sa base imposable et ses impôts, sur sa base
    CNPS (et donc sur sa future pension : une baisse de la base CNPS est signalée honnêtement).
  - *Pour l'employeur* : effet sur les charges patronales, le coût total, le risque de
    redressement et les obligations (pièces justificatives, avenant).
  - Exemple : « Indemnité de logement 113 038 F imposée en totalité. *Salarié* : l'article 33
    limite la part imposable à 15 % du salaire taxable (≈ 51 271 F) ; IRPP + CAC ≈ −11 900 F/mois,
    net +11 900 F. *Employeur* : coût inchangé, aucune pièce supplémentaire, risque nul (texte
    explicite). »
- **Constats de conformité** : surimpositions et risques, avec l'impact chiffré.

### Par portefeuille / entreprise
- Nombre de salariés analysés, optimisés / non optimisés, en risque.
- Gain potentiel total (mois / an), par levier.
- Top des constats récurrents (ex. « logement imposé en totalité sur 42 salariés »), qui
  révèlent souvent un **problème de paramétrage du profil** plutôt qu'individuel.

### Exports
- **Rapport PDF** par salarié (une page avant/après + recommandations) et rapport de synthèse.
- **Excel** des résultats d'un portefeuille.

---

## 6. Écrans (module RH)

1. **Bouton « Analyser la rémunération »** sur la fiche salarié (RH et Gestion Admin › Employés) :
   lance la simulation pour ce salarié à partir de ses éléments de salaire.
2. **Analyse salariale** (menu RH › Analyse salariale) : choix du périmètre (un salarié, un
   portefeuille, toute l'entreprise), du mode et des leviers autorisés.
3. **Résultats** : liste triée par gain potentiel, avec indicateurs (optimisé ✓, gain, risques).
4. **Détail salarié** : bulletin simulé actuel et bulletin simulé optimisé côte à côte, gains,
   constats, recommandations avec la double explication salarié / employeur, export PDF.
5. **Paramétrage** (dans les paramètres de paie, puis le profil de paie) : nature légale de
   chaque rubrique et élément de salaire, plafonds des frais et emplois éligibles, politique
   logement/CNPS.

La fonctionnalité utilise le moteur de calcul de la paie mais **ne requiert pas l'activation du
module Paie** : une entreprise qui n'a que le module RH peut simuler et optimiser avant de
calculer ses paies ailleurs.

Rien n'est appliqué automatiquement : un bouton « Préparer l'avenant » pourra être ajouté plus
tard, mais la mise à jour de la paie reste manuelle et tracée.

---

## 7. Droits, données, sécurité

- **Rôles** : équipe paie / RH (RP, ADM, CD, et GPF sur ses portefeuilles) ; **ADM client**
  limité à son entreprise (isolation par `tenantId`, comme le reste de l'application).
- **Lecture seule** : aucune écriture dans la fiche salarié, ses éléments de salaire, les
  rubriques ou les bulletins. Les changements sont faits par l'utilisateur, après la simulation.
- **Historique** : chaque analyse est enregistrée (`payAnalyses`) avec ses paramètres, la
  version des règles et le profil utilisé, pour pouvoir la rejouer et la justifier.
- **Journal d'audit** sur chaque analyse lancée et chaque export.

---

## 8. Dépendance avec les profils de paie

L'analyse fonctionne avec le moteur actuel, mais elle est **plus juste avec les profils de
paie** (catalogue et paramètres par client, voir `payroll-profiles` en cours de conception) :
la nature légale et les plafonds de frais vivent dans le profil, et une analyse « ancienne vs
nouvelle méthode » compare deux profils sur le même salarié.

---

## 9. Tests

- **Tests unitaires** par règle (limites d'art. 33, plafond CNPS, frais plafonnés, RAV à la borne).
- **Cas réels** : bulletins d'août 2026 (COTCO, COTCO_NEW, PERENCO, PERENCO_NEW, WORK OVER,
  PARTICULIER) recalculés à l'identique avant optimisation.
- **Invariants vérifiés sur chaque résultat** : net jamais inférieur, coût jamais supérieur au
  mode choisi, base ≥ minimum, indemnités dans leurs limites, total versé cohérent.

---

## 10. Phasage proposé

| Phase | Contenu | Valeur |
|---|---|---|
| 1 | Nature légale des rubriques + **audit de conformité** (mode 3) sur un salarié et un portefeuille | détecte surimpositions et risques immédiatement |
| 2 | **Optimisation** modes 1 et 2 sur un salarié, avant/après, recommandations | conseil chiffré par salarié |
| 3 | Analyse de portefeuille / entreprise, **PDF et Excel** | outil d'audit client |
| 4 | Intégration aux profils de paie et comparaison de deux profils | ancienne vs nouvelle méthode |

---

## 11. Points ouverts

1. **CNPS sur l'indemnité de logement en espèces** : réglé par profil, mais une position de
   l'expert-comptable sur la règle par défaut est souhaitable.
2. **Plafonds des indemnités de frais** : valeurs par défaut à fixer avec l'équipe paie
   (montant ou % du salaire, emplois éligibles).
3. **Rubriques « déplaçables »** : quelles primes peuvent être restructurées (ex. prime de
   rotation, prime de sécurité) et lesquelles sont figées par la convention ou le contrat.
4. **Avenant** : faut-il générer le projet d'avenant depuis l'outil (phase ultérieure) ?

---

## Sources

- Code Général des Impôts du Cameroun, édition 2022 (DGI) : art. 29 à 34, 69, 71 ; redevance
  audiovisuelle art. 3 ; contribution au Crédit Foncier ; taxe de développement local art. C 58.
- Séminaire CADEV « Fiscalité des salaires et rémunérations », Kribi, 2009 : circulaire CNPS
  n° 021/91/DR/DG/CNPS du 17/05/1991, arrêté 003/MTPS-94/MINFI du 01/03/1974, lettres
  MINFI 0474 et 4156 de 2003.
- Analyse de 135 bulletins Sage d'août 2026 (COTCO, COTCO_NEW, PERENCO, PERENCO_NEW,
  PERENCO WORK OVER, PERENCO PARTICULIER) comparés au moteur MBOKA.
