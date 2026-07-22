/**
 * Payroll module — per-tenant seed (idempotent).
 * Seeds the calculation config, the full rubriques catalogue (from Sage T_RUB, 163
 * lines — the admin baseline), and a default payslip template.
 */
const { db, save, id } = require("../store");
const { DEFAULT_CONFIG } = require("./engine");
const CATALOGUE = require("./rubriques.seed");

function seedPayroll(tid) {
  for (const k of ["payrollConfig", "payRubriques", "bulletinModels", "payRuns", "payslips", "payElements", "payCumuls"])
    if (!db[k]) db[k] = [];
  const has = (coll) => (db[coll] || []).some(x => (x.tenantId || "t1") === tid);

  // 1) Calculation config (one editable doc per tenant)
  if (!db.payrollConfig.some(c => (c.tenantId || "t1") === tid))
    db.payrollConfig.push({ id: id("pcfg"), tenantId: tid, ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)) });

  // 2) Rubriques catalogue (baseline; system=true so admins know it's seeded)
  if (!has("payRubriques")) {
    for (const r of CATALOGUE)
      db.payRubriques.push({
        id: id("rub"), tenantId: tid, code: r.code, label: r.label, family: r.family,
        formula: r.formula, base: r.base || null, nombre: r.nombre || null,
        taux: r.taux != null ? r.taux : null, tauxPat: r.tauxPat != null ? r.tauxPat : null,
        cnps: !!r.cnps, impo: !!r.impo, sens: r.sens || "GAIN",
        active: true, system: true, createdAt: new Date().toISOString(),
      });
  }

  // 3) Default payslip template
  if (!has("bulletinModels"))
    db.bulletinModels.push({
      id: id("bmod"), tenantId: tid, code: "EMPLOYE", label: "Employé (mensuel)",
      type: "Mensuel", monthlyHours: 173.33,
      lines: [{ code: "1000", label: "Salaire de base", auto: true }],
    });
  save();
}

module.exports = { seedPayroll, CATALOGUE };
