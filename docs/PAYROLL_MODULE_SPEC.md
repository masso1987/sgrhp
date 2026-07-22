# SGRHP — Payroll Module (Module Paie)
## Essential functionalities collected from Sage Paie i7 v10

**Jurisdiction observed in the screenshots:** Cameroon (IRPP, CAC, CNPS, Crédit Foncier/CFC, FNE, Redevance CRTV/RAV, Taxe communale/TDL). Rates are kept editable per tenant so the module also works for other OHADA/CEMAC countries.

**Principle:** keep only what's needed to actually produce a correct payslip and the mandatory declarations. Everything else in Sage (DSN, DADS-U, MSA, BTP, titres restaurant, épargne salariale, participation, bilan social, intranet, dématérialisation) is **excluded**.

---

## 1. Configuration (Paramétrage) — admin setup, done once

### 1.1 Rubriques (pay lines) — *Sage: Listes › Rubriques*
The core building block. Each rubrique has:
- **Code** (e.g. 1000) and **Libellé** (e.g. SALAIRE DE BASE)
- **Type / family:** `BRUT` (gain), `COTISATION` (social deduction), `RETENUE` (other deduction), `NON SOUMISE` (non-taxable)
- **Formula:** one of — `Nombre × Base`, `Base × Taux`, `Nombre × Base × Taux`, `Montant pris tel quel`, or `Calculé` (from a constant)
- **Sens:** Gain / Retenue
- **Which base(s) it feeds:** taxable base, CNPS base, IRPP base, congés base, 13e-mois base…
- **Taux salarial** and **Taux patronal** (for contributions, the split employee/employer)

Seed set (from the screenshots): 1000 Salaire de base, 1005 Salaire de base horaire, 1030 Sursalaire, 1040/1055/1060/1065 Prime & indemnité d'ancienneté, 1067 Jours fériés, 1068 Horaires accrus, 1080 Forfait heures supplémentaires, 2035 Rappel salaire, 2103 Prime de risque, 2106 Prime de chantier, 2117 Prime de panier, 2118 Prime de performance, 2119 Prime de précarité, 2127 Prime de rendement, 2128 Prime de responsabilité, plus deduction lines 5000 Pension vieillesse, 5010 Allocations familiales, 5020 Accident de travail, 5050/5060 Crédit Foncier (sal./pat.), 5070 FNE, 5080 Redevance CRTV, 5090 Taxe communale.

### 1.2 Constantes (calculation parameters) — *Sage: Listes › Constantes*
Named values used by formulas: rates, ceilings, and **tranches/barèmes** (progressive brackets for IRPP), bases like BASE CNPS, BASE 13e MOIS, BASE CONGÉS. Types seen: Valeur, Taux, Tranche, Calcul, Cumul, Test. All editable per tenant.

### 1.3 Caisses de cotisations (contribution funds) — *Sage: Listes › Caisses de cotisations*
Each fund groups its rubriques with rate + ceiling + who pays:
- **CNPS** — Pension vieillesse (employee + employer), Prestations familiales (employer), Risques professionnels/Accident de travail (employer), with the monthly ceiling
- **Trésor / Impôts** — IRPP (progressive), CAC (additional communal centimes on IRPP), TDL / taxe communale
- **Crédit Foncier (CFC)** — employee + employer
- **FNE** — employer
- **Redevance audiovisuelle (RAV / CRTV)** — from a bracket table

### 1.4 Bulletins modèles (payslip templates) — *Sage: Gestion › Bulletins modèles*
A reusable set of rubriques per population (e.g. EMPLOYÉ, CADRE), with monthly hours base (173.33), default Nombre/Base/Taux per line and a "G" (grouped) flag. New employees inherit a model so their payslip is pre-built.

### 1.5 Reuses what SGRHP already has
Conventions collectives, salary grid (catégorie → salaire de base), départements/services, employee files — already in the HR module and consumed directly.

---

## 2. Monthly inputs (Saisie des éléments variables) — *Sage: Gestion › Saisie…*
Per employee, per pay period:
- **Heures** — normal hours, **heures supplémentaires** (overtime at premium rates)
- **Congés / absences** — paid leave, unpaid absence, sickness (feeds proration)
- **Primes & indemnités** — one-off or recurring amounts on top of the model
- **Acomptes** (salary advances) and **Prêts** (loans with installment repayment deducted from net)
- **Rappels** (back-pay) and 13e mois when applicable

Bulk entry: grid entry (saisie en grille) and mass modification (modification en masse).

---

## 3. Calculation engine (Calcul des bulletins) — *Sage: Gestion › Calcul des bulletins*
The heart of the module. Per employee it computes, in order:
1. **Salaire brut** = base (prorated by days/hours) + sursalaire + ancienneté + primes + heures supp. + rappels
2. **Cotisations sociales** (CNPS) — employee share + employer share, each capped at the ceiling
3. **Retenues fiscales** — IRPP (progressive on net taxable), CAC, CFC, TDL, RAV
4. **Net à payer** = brut − cotisations salariales − retenues fiscales − acomptes/prêts
5. **Charges patronales** total (employer cost) computed alongside

Runs **one employee** or **the whole company in batch**. Each payslip line stores: Code, Libellé, Nombre, Base, **Taux salarial, Montant salarial, Taux patronal, Montant patronal, Sens**.

---

## 4. Payslips (Bulletins) — *Sage: Gestion › Édition des bulletins*
- **View / preview** the calculated payslip (onglet Bulletin calculé)
- **PDF bulletin de paie** per employee (printable, downloadable) — reuses the existing document-generation pipeline
- **Duplicata** (reprint) — logged in the audit trail
- Batch edition for all employees in the run

---

## 5. Period close (Clôture) — *Sage: Gestion › Clôtures*
- **Clôture mensuelle** — lock the month so calculated payslips can't change
- **Cumuls** — carry year-to-date totals forward (brut, net, IRPP, CNPS…) needed for progressive tax and year-end
- Clôture intermédiaire (optional, mid-month)

---

## 6. Reports & declarations (États) — *Sage: États*
- **Livre de paie** (payroll register/journal) — all employees × all rubriques for the period, groupable by département / service / catégorie / établissement; PDF + Excel
- **Bulletin / fiche individuelle**
- **États des cotisations** — Charges patronales, Charges salariales, Bases de cotisation, Résumé — the basis for the monthly **CNPS** and **impôts (DIPE)** declarations
- **Mouvements de personnel**, **État des absences**, **Suivi des heures**

---

## 7. Accounting export (Passation comptable) — *Sage: Gestion › Passation comptable / Modélisation comptable*
- Generate the accounting entries (journal de paie) from the run
- Ventilation par département / service / catégorie / établissement / salarié
- Export to the accounting module / Excel (bridge to the future "Comptabilité" module)

---

## 8. Cross-cutting (already in SGRHP)
- **Multi-société / multi-établissement** → already multi-tenant (`tenantId`)
- **Droits d'accès (RBAC)** → add a **Gestionnaire de paie** role; ADM/superadmin oversee
- **Audit trail** → every calculation, close, payslip print/duplicata logged
- **Sauvegarde / restauration** → already in the app

---

## Proposed build order (increments)
1. **Config foundation** — Rubriques, Constantes, Caisses de cotisations, Bulletins modèles (admin screens + seed Cameroon rules, editable rates)
2. **Calculation engine** — gross → CNPS → IRPP/CAC/CFC/FNE/TDL/RAV → net, salarial/patronal split, with unit tests on sample salaries
3. **Monthly run** — variable input (primes, HS, absences, acomptes/prêts) + batch calcul + payslip preview
4. **Payslip PDF + Livre de paie + États des cotisations**
5. **Clôture mensuelle + cumuls**
6. **Passation comptable (export)**

---

## Explicitly OUT of scope (Sage features we drop)
DSN, DADS-U, DTS-MSA, CICE, Plan de paie MSA/BTP, titres restaurant, épargne salariale, gestion participation, bilan social, DIF/CPF pilote, Sage dématérialisation, intranet/Connect, requêteur, publipostage G.A. (basic mail-merge only if needed later).
