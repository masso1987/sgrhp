/**
 * Facturation — per-tenant seed (idempotent).
 * Seeds the editable component catalogue (primes, HS, hors-charges, prestation,
 * retenues). Contracts are created by the admin (a client = configuration).
 */
const { db, save, id } = require("../store");

const COMPONENTS = [
  // PRIMES — entrent dans le brut
  { code: "PR_REND",  label: "Prime de rendement",      inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 10 },
  { code: "PR_TECH",  label: "Prime de technicité",     inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 11 },
  { code: "PR_NUIT",  label: "Prime de nuit",           inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 12 },
  { code: "PR_PERF",  label: "Prime de performance",    inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 13 },
  { code: "IND_TRANS", label: "Indemnité de transport", inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 14 },
  { code: "IND_LOG",  label: "Indemnité de logement",   inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 15 },
  { code: "TREIZE",   label: "13e mois",                inputMode: "montant", formula: "FIXE",         stage: "PRIME", order: 16 },
  { code: "HS120",    label: "Heures supp. 120 %",      inputMode: "heures",  formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.2, diviseur: 173.33, order: 20 },
  { code: "HS130",    label: "Heures supp. 130 %",      inputMode: "heures",  formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.3, diviseur: 173.33, order: 21 },
  { code: "HS150",    label: "Heures supp. 150 %",      inputMode: "heures",  formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.5, diviseur: 173.33, order: 22 },
  { code: "HS200",    label: "Heures supp. 200 %",      inputMode: "heures",  formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 2.0, diviseur: 173.33, order: 23 },
  // HORS CHARGES — après charges patronales, avant frais de gestion
  { code: "ASSUR",    label: "Assurance",               inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 30 },
  { code: "COMM",     label: "Communication",           inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 31 },
  { code: "DEPL",     label: "Déplacement",             inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 32 },
  { code: "VIS_MED",  label: "Visite médicale",         inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 33 },
  { code: "DEBOURS",  label: "Débours",                 inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 34 },
  // PRESTATION — types non-MAD
  { code: "PREST_U",  label: "Prestation (quantité × PU)", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 40 },
  { code: "TONNAGE",  label: "Tonnage (qté × coût/T)",     inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 41 },
  // RETENUES — déduites du net
  { code: "RET_DIV",  label: "Retenue diverse",         inputMode: "montant", formula: "FIXE", stage: "RETENUE", order: 50 },
];

function seedBilling(tid) {
  for (const k of ["billingContracts", "billingComponents", "billingSheets", "billingAnnexeTemplates"]) if (!db[k]) db[k] = [];
  const has = (db.billingComponents || []).some(c => (c.tenantId || "t1") === tid);
  if (!has) {
    for (const c of COMPONENTS)
      db.billingComponents.push({ id: id("bcmp"), tenantId: tid, ...c, active: true, system: true, createdAt: new Date().toISOString() });
    save();
  }
  // Example annexe template (configurable) — CIMPOR MAD
  if (!(db.billingAnnexeTemplates || []).some(t => (t.tenantId || "t1") === tid && t.code === "CIMPOR_MAD")) {
    db.billingAnnexeTemplates.push({ id: id("batpl"), tenantId: tid, code: "CIMPOR_MAD",
      title: "ANNEXE DE FACTURATION : CIMPOR MAD", groupBy: null,
      taxes: { tva: 0.1925, is: 0 }, signatures: ["La Comptabilité", "Le Responsable GPF", "Direction Générale"],
      etabliPar: "", system: true,
      columns: [
        { key: "NOMS", source: "field", field: "name", label: "NOMS ET PRENOMS", align: "left", w: 150 },
        { key: "POSITION", source: "field", field: "poste", label: "POSITION", align: "left", w: 100 },
        { key: "PRES", expr: "PRES", label: "PRÉS.", w: 40 },
        { key: "BASICS", expr: "BASE", label: "BASICS", w: 66 },
        { key: "TRANSP", expr: "IND_TRANS", label: "TRANSP.", w: 60 },
        { key: "LOGEM", expr: "IND_LOG", label: "LOGEM.", w: 60 },
        { key: "SALIS", expr: "SALIS", label: "SALIS.", w: 55 },
        { key: "RISQUE", expr: "RISQUE", label: "RISQUE", w: 55 },
        { key: "RESP", expr: "RESP", label: "RESP.", w: 55 },
        { key: "HS120", expr: "HS120", label: "HS120", w: 50 },
        { key: "GROSS", expr: "BASICS + TRANSP + LOGEM + SALIS + RISQUE + RESP + HS120", label: "GROSS", w: 70, bold: true },
        { key: "PROV_CG", expr: "GROSS / 12", label: "PROV.CG", w: 60 },
        { key: "CH_PAT", expr: "(GROSS + PROV_CG) * 0.162", label: "CH.PAT", w: 60 },
        { key: "FG", expr: "(GROSS + PROV_CG + CH_PAT) * 0.10", label: "FG 10%", w: 60 },
        { key: "TOTAL_HT", expr: "GROSS + PROV_CG + CH_PAT + FG", label: "TOTAL HT", w: 72, bold: true },
        { key: "TVA", expr: "TOTAL_HT * 0.1925", label: "TVA", w: 62 },
        { key: "TOTAL_TTC", expr: "TOTAL_HT + TVA", label: "TOTAL TTC", w: 76, bold: true },
      ], createdAt: new Date().toISOString() });
  }
  if (!(db.billingAnnexeTemplates || []).some(t => (t.tenantId || "t1") === tid && t.code === "CIMPOR_PRESTATION")) {
    db.billingAnnexeTemplates.push({ id: id("batpl"), tenantId: tid, code: "CIMPOR_PRESTATION",
      title: "ANNEXE DE FACTURATION : CIMPOR PRESTATION", groupBy: "poste",
      taxes: { tva: 0.1925, is: 0 }, signatures: ["La Comptabilité", "Le Responsable GPF", "Direction Générale"], system: true,
      columns: [
        { key: "NOMS", source: "field", field: "name", label: "NOMS ET PRENOMS", align: "left", w: 150 },
        { key: "POSITION", source: "field", field: "poste", label: "POSITION", align: "left", w: 110 },
        { key: "SALAIRES_NETS", expr: "SALAIRES_NETS", label: "SALAIRES NETS", w: 66 },
        { key: "JOURS", expr: "JOURS", label: "JOURS", w: 44 },
        { key: "COUT_MENSUEL", expr: "COUT_MENSUEL", label: "COÛT MENSUEL", w: 70 },
        { key: "HS120", expr: "HS120", label: "HS120", w: 52 },
        { key: "HS130", expr: "HS130", label: "HS130", w: 52 },
        { key: "HS_FERIE", expr: "HS_FERIE", label: "HS FÉRIÉ", w: 55 },
        { key: "PANIER_NUIT", expr: "PANIER_NUIT", label: "PANIER NUIT", w: 60 },
        { key: "REMB_TRANSP", expr: "REMB_TRANSP", label: "REMB.TRANSP", w: 62 },
        { key: "COUT_HT", expr: "COUT_MENSUEL * JOURS / 30 + HS120 + HS130 + HS_FERIE + PANIER_NUIT + REMB_TRANSP", label: "COÛT HT", w: 70, bold: true },
        { key: "FG", expr: "COUT_HT * 0.10", label: "FG 10%", w: 60 },
        { key: "MONTANT_HT", expr: "COUT_HT + FG", label: "MONTANT HT", w: 72, bold: true },
        { key: "TVA", expr: "MONTANT_HT * 0.1925", label: "TVA", w: 62 },
        { key: "TOTAL_TTC", expr: "MONTANT_HT + TVA", label: "TOTAL TTC", w: 76, bold: true },
      ], createdAt: new Date().toISOString() });
  }
  save();
}

module.exports = { seedBilling, COMPONENTS };
