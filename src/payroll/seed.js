/**
 * Payroll module — per-tenant seed (idempotent).
 * Seeds the calculation config (editable rates/brackets), the rubriques catalogue
 * (Sage: Listes › Rubriques) and a default payslip template (bulletin modèle).
 */
const { db, save, id } = require("../store");
const { DEFAULT_CONFIG } = require("./engine");

/* Rubriques catalogue mirrored from the Sage screenshots, trimmed to essentials. */
const RUBRIQUES = [
  // Gains (brut)
  ["1000", "Salaire de base", "BRUT", "Nombre x Base", "GAIN", true],
  ["1030", "Sursalaire", "BRUT", "Montant pris tel quel", "GAIN", true],
  ["1040", "Prime d'ancienneté", "BRUT", "Base x Taux", "GAIN", true],
  ["1067", "Jours fériés", "BRUT", "Nombre x Base", "GAIN", true],
  ["1081", "Heures supplémentaires (+20%)", "BRUT", "Nombre x Base x Taux", "GAIN", true],
  ["1082", "Heures supplémentaires (+30%)", "BRUT", "Nombre x Base x Taux", "GAIN", true],
  ["1083", "Heures supplémentaires (+40%)", "BRUT", "Nombre x Base x Taux", "GAIN", true],
  ["1084", "Heures de nuit (+50%)", "BRUT", "Nombre x Base x Taux", "GAIN", true],
  ["2035", "Rappel de salaire", "BRUT", "Montant pris tel quel", "GAIN", true],
  ["2103", "Prime de risque", "BRUT", "Montant pris tel quel", "GAIN", true],
  ["2106", "Prime de chantier", "BRUT", "Montant pris tel quel", "GAIN", true],
  ["2118", "Prime de performance", "BRUT", "Montant pris tel quel", "GAIN", true],
  ["2127", "Prime de rendement", "BRUT", "Montant pris tel quel", "GAIN", true],
  ["2128", "Prime de responsabilité", "BRUT", "Montant pris tel quel", "GAIN", true],
  // Indemnités non imposables
  ["3100", "Indemnité de transport", "NON_SOUMISE", "Montant pris tel quel", "GAIN", false],
  ["3110", "Prime de panier", "NON_SOUMISE", "Montant pris tel quel", "GAIN", false],
  // Cotisations sociales (CNPS)
  ["5000", "CNPS Pension (PVID)", "COTISATION", "Base x Taux", "RETENUE", false],
  ["5010", "CNPS Prestations familiales", "COTISATION", "Base x Taux", "PATRONAL", false],
  ["5020", "CNPS Risques professionnels", "COTISATION", "Base x Taux", "PATRONAL", false],
  // Impôts & retenues Trésor
  ["6000", "IRPP", "COTISATION", "Barème", "RETENUE", false],
  ["6010", "CAC (10% IRPP)", "COTISATION", "Base x Taux", "RETENUE", false],
  ["5050", "Crédit Foncier (CFC)", "COTISATION", "Base x Taux", "RETENUE", false],
  ["5070", "FNE", "COTISATION", "Base x Taux", "PATRONAL", false],
  ["5080", "Redevance audiovisuelle (RAV)", "COTISATION", "Barème", "RETENUE", false],
  ["5090", "Taxe communale (TDL)", "COTISATION", "Barème", "RETENUE", false],
  // Autres retenues
  ["7000", "Acompte sur salaire", "RETENUE", "Montant pris tel quel", "RETENUE", false],
  ["7010", "Remboursement de prêt", "RETENUE", "Montant pris tel quel", "RETENUE", false],
];

function seedPayroll(tid) {
  db.payrollConfig = db.payrollConfig || [];
  db.payRubriques = db.payRubriques || [];
  db.bulletinModels = db.bulletinModels || [];
  db.payRuns = db.payRuns || [];
  db.payslips = db.payslips || [];
  db.payElements = db.payElements || [];

  const has = (coll) => (db[coll] || []).some(x => (x.tenantId || "t1") === tid);

  // 1) Calculation config (one editable doc per tenant)
  if (!db.payrollConfig.some(c => (c.tenantId || "t1") === tid)) {
    db.payrollConfig.push({ id: id("pcfg"), tenantId: tid, ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)) });
  }

  // 2) Rubriques catalogue
  if (!has("payRubriques")) {
    for (const [code, label, family, formula, sens, taxable] of RUBRIQUES) {
      db.payRubriques.push({ id: id("rub"), tenantId: tid, code, label, family, formula, sens, taxable, active: true });
    }
  }

  // 3) Default payslip template
  if (!has("bulletinModels")) {
    db.bulletinModels.push({
      id: id("bmod"), tenantId: tid, code: "EMPLOYE", label: "Employé (mensuel)",
      type: "Mensuel", monthlyHours: 173.33,
      lines: [
        { code: "1000", label: "Salaire de base", auto: true },
        { code: "1040", label: "Prime d'ancienneté", auto: true },
        { code: "5000", label: "CNPS Pension (PVID)", auto: true },
        { code: "6000", label: "IRPP", auto: true },
      ],
    });
  }
  save();
}

module.exports = { seedPayroll, RUBRIQUES };
