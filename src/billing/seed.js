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
  // HORS-CHARGES — libellés étendus (annexes Barry & assimilés)
  { code: "ASSURANCE",     label: "Assurance",                   inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 35 },
  { code: "ASSUR_ACC",     label: "Assurance accident",          inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 36 },
  { code: "DEPLACEMENT",   label: "Déplacement",                 inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 37 },
  { code: "FRAIS_MISSION", label: "Frais de mission",            inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 38 },
  { code: "VISITE_MED",    label: "Visite médicale",             inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 39 },
  { code: "MEDICAL",       label: "Visite médicale (LG)",        inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 40 },
  { code: "ADMIN",         label: "Charges administratives",     inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 41 },
  // GAINS / INDEMNITÉS — modèles multi-pays (LG & assimilés), saisis au montant
  { code: "BASIC",          label: "Salaire de base (Basic)",       inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 60 },
  { code: "RATION",         label: "Ration",                        inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 61 },
  { code: "SALISSURE",      label: "Prime de salissure",            inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 62 },
  { code: "ASSIDUITY",      label: "Prime d'assiduité",             inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 63 },
  { code: "LODGING",        label: "Indemnité de logement (Lodging)", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 64 },
  { code: "TRANSPORTATION", label: "Indemnité de transport (Transportation)", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 65 },
  { code: "REPRESENTATION", label: "Indemnité de représentation",   inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 66 },
  { code: "INTERESSEMENT",  label: "Intéressement",                 inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 67 },
  // PROVISIONS / AVANCES (LG)
  { code: "PROV_13E",       label: "Provision 13e mois",            inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 70 },
  { code: "SENIORITY",      label: "Prime d'ancienneté (saisie)",   inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 71 },
  { code: "ADVANCE",        label: "Avance automatique",            inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 72 },
  { code: "PAID_LEAVES",    label: "Congés payés (provision)",      inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 73 },
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
  if (!(db.billingAnnexeTemplates || []).some(t => (t.tenantId || "t1") === tid && t.code === "BARRY")) {
    db.billingAnnexeTemplates.push({ id: id("batpl"), tenantId: tid, code: "BARRY",
      title: "ANNEXE DE FACTURATION DU PERSONNEL : BARRY CALLEBAUT", groupBy: null, roundMode: "unrounded",
      taxes: { tva: 0.1925, is: 0.022 }, signatures: ["La Comptabilité", "Le Responsable GPF", "Direction Générale"], system: true,
      columns: [
        { key: "MAT", source: "field", field: "matricule", label: "MAT", align: "left", w: 55 },
        { key: "CNPS", source: "field", field: "cnps", label: "CNPS", align: "left", w: 80 },
        { key: "NOMS", source: "field", field: "name", label: "NOMS ET PRENOMS", align: "left", w: 140 },
        { key: "POSTE", source: "field", field: "poste", label: "POSTE", align: "left", w: 120 },
        { key: "JRS", expr: "JOURS", label: "JRS", w: 40 },
        { key: "SAL_BRUT", expr: "BASE", label: "SAL BRUT", w: 66 },
        { key: "ALLOC_CONGE", expr: "SAL_BRUT / 12", label: "ALLOC CONGE", w: 62 },
        { key: "CHARGES", expr: "(SAL_BRUT + ALLOC_CONGE) * 0.162", label: "CHARGES 16,2%", w: 66 },
        { key: "ASSURANCE", expr: "ASSURANCE", label: "ASSURANCE", w: 60 },
        { key: "ASSUR_ACC", expr: "ASSUR_ACC", label: "ASSUR. ACC.", w: 60 },
        { key: "DEPLACEMENT", expr: "DEPLACEMENT", label: "DEPLACEMENT", w: 66 },
        { key: "FRAIS_MISSION", expr: "FRAIS_MISSION", label: "FRAIS MISSION", w: 66 },
        { key: "VISITE_MED", expr: "VISITE_MED", label: "VISITE MED.", w: 60 },
        { key: "TOTAL_A", expr: "SAL_BRUT + ALLOC_CONGE + CHARGES + ASSURANCE + ASSUR_ACC + DEPLACEMENT + FRAIS_MISSION + VISITE_MED", label: "TOTAL A", w: 70, bold: true },
        { key: "FRAIS_GEST", expr: "TOTAL_A * 0.10", label: "FRAIS GEST. 10%", w: 66 },
        { key: "TOTAL_HT", expr: "TOTAL_A + FRAIS_GEST", label: "TOTAL HT", w: 70, bold: true },
        { key: "RET_IS", expr: "TOTAL_HT * 0.022", label: "RET. IS 2,2%", w: 62 },
        { key: "NET_PERC", expr: "TOTAL_HT - RET_IS", label: "NET A PERC.", w: 66 },
        { key: "TVA", expr: "TOTAL_HT * 0.1925", label: "TVA 19,25%", w: 62 },
        { key: "TOTAL_B", expr: "TOTAL_HT + TVA", label: "TOTAL B", w: 76, bold: true },
      ], createdAt: new Date().toISOString() });
  }
  if (!(db.billingAnnexeTemplates || []).some(t => (t.tenantId || "t1") === tid && t.code === "LG")) {
    db.billingAnnexeTemplates.push({ id: id("batpl"), tenantId: tid, code: "LG",
      title: "Annexe Mensuelle - LG", groupBy: "poste", etabliPar: "Administrator", roundMode: "rounded",
      taxes: { tva: 0.1925, is: 0 }, signatures: [], system: true,
      columns: [
        { key: "REF", source: "field", field: "ref", label: "REF.", align: "left", w: 70 },
        { key: "EMPLOYE", source: "field", field: "name", label: "EMPLOYE", align: "left", w: 130 },
        { key: "CAT", source: "field", field: "cat", label: "CAT", align: "left", w: 36 },
        { key: "BASIC", expr: "BASIC", label: "BASIC", w: 58 },
        { key: "RATION", expr: "RATION", label: "RATION", w: 52 },
        { key: "SALISSURE", expr: "SALISSURE", label: "SALISSURE", w: 58 },
        { key: "ASSIDUITY", expr: "ASSIDUITY", label: "ASSIDUITY", w: 55 },
        { key: "LODGING", expr: "LODGING", label: "LODGING", w: 55 },
        { key: "TRANSPORTATION", expr: "TRANSPORTATION", label: "TRANSPORTATION", w: 66 },
        { key: "REPRESENTATION", expr: "REPRESENTATION", label: "REPRESENTATION", w: 66 },
        { key: "INTERESSEMENT", expr: "INTERESSEMENT", label: "INTERESSEMENT", w: 60 },
        { key: "SALAIRE_BRUT", expr: "BASIC + RATION + SALISSURE + ASSIDUITY + LODGING + TRANSPORTATION + REPRESENTATION + INTERESSEMENT", label: "SALAIRE BRUT", w: 66, bold: true },
        { key: "PROV_13E", expr: "PROV_13E", label: "PROV.13E", w: 55 },
        { key: "SENIORITY", expr: "SENIORITY", label: "SENIORITY", w: 55 },
        { key: "ADVANCE", expr: "ADVANCE", label: "AUTOMATIC ADVANCE", w: 66 },
        { key: "PAID_LEAVES", expr: "PAID_LEAVES", label: "PAID LEAVES", w: 60 },
        { key: "SOUS_TOTAL_1", expr: "SALAIRE_BRUT + PROV_13E + SENIORITY + ADVANCE + PAID_LEAVES", label: "SOUS-TOTAL 1", w: 66, bold: true },
        { key: "CHARGES", expr: "SOUS_TOTAL_1 * 0.162", label: "CHARGES 16,20%", w: 62 },
        { key: "ASSURANCE", expr: "ASSURANCE", label: "ASSURANCE", w: 58 },
        { key: "MEDICAL", expr: "MEDICAL", label: "MEDICAL VISIT", w: 60 },
        { key: "TOTAL_CHARGES", expr: "SOUS_TOTAL_1 + CHARGES + ASSURANCE + MEDICAL", label: "TOTAL CHARGES", w: 66 },
        { key: "FRAIS_GESTION", expr: "TOTAL_CHARGES * 0.10", label: "FRAIS GESTION", w: 62 },
        { key: "ADMIN", expr: "ADMIN", label: "ADMIN. CHARGES", w: 60 },
        { key: "SOUS_TOTAL_2", expr: "TOTAL_CHARGES + FRAIS_GESTION + ADMIN", label: "SOUS-TOTAL 2", w: 66, bold: true },
        { key: "MONTANT_HT", expr: "SOUS_TOTAL_2", label: "MONTANT HT", w: 66, bold: true },
        { key: "TVA", expr: "MONTANT_HT * 0.1925", label: "TVA", w: 58 },
        { key: "MONTANT_TTC", expr: "MONTANT_HT + TVA", label: "MONTANT TTC", w: 70, bold: true },
      ], createdAt: new Date().toISOString() });
  }
  save();
}

module.exports = { seedBilling, COMPONENTS };
