/**
 * Facturation — per-tenant seed (idempotent).
 * Seeds the editable component catalogue (primes, HS, hors-charges, prestation,
 * retenues). Contracts are created by the admin (a client = configuration).
 */
const { db, save, id } = require("../store");

const COMPONENTS = [
  { code: "BASIC", label: "Salaire de base (Basic)", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 10 },
  { code: "SURSALAIRE", label: "Sursalaire", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 11 },
  { code: "RAPPEL_SAL", label: "Rappel sur salaire", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 12 },
  { code: "IND_TRANS", label: "Indemnité de transport", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 13 },
  { code: "IND_LOG", label: "Indemnité de logement", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 14 },
  { code: "IND_PREAVIS", label: "Indemnité compensatrice de préavis", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 15 },
  { code: "REPRESENTATION", label: "Prime de représentation", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 16 },
  { code: "PR_REND", label: "Prime de rendement", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 17 },
  { code: "PR_PERF", label: "Prime de performance", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 18 },
  { code: "PR_INTERIM", label: "Prime d'intérim", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 19 },
  { code: "PR_DOC", label: "Prime de documentation", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 20 },
  { code: "PR_CAISSE", label: "Prime de caisse", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 21 },
  { code: "SALISSURE", label: "Prime de salissure", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 22 },
  { code: "REPLACEMENT_ALLOW", label: "Replacement allowance", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 23 },
  { code: "PR_OBJECTIF", label: "Prime d'objectif", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 24 },
  { code: "IND_EAU", label: "Indemnité d'eau", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 25 },
  { code: "IND_ELEC", label: "Indemnité d'électricité", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 26 },
  { code: "PR_RISQUE", label: "Prime de risque", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 27 },
  { code: "PR_RESP", label: "Prime de responsabilité", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 28 },
  { code: "PR_NUIT", label: "Prime de nuit", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 29 },
  { code: "ASTREINTE", label: "Astreinte", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 30 },
  { code: "PR_EXCEPT", label: "Prime exceptionnelle", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 31 },
  { code: "PR_PANIER", label: "Prime de panier", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 32 },
  { code: "JOURS_FERIES", label: "Jours fériés", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 33 },
  { code: "RATION", label: "Ration", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 34 },
  { code: "ASSIDUITY", label: "Prime d'assiduité", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 35 },
  { code: "INTERESSEMENT", label: "Intéressement", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 36 },
  { code: "MEDAILLE", label: "Médaille d'honneur du travail", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 37 },
  { code: "BONUS_ANNUEL", label: "Bonus annuel", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 38 },
  { code: "HS_FORFAIT", label: "Forfait heures supplémentaires", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 39 },
  { code: "HS120", label: "Heures supp. 120 %", inputMode: "heures", formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.2, diviseur: 173.33, order: 40 },
  { code: "HS130", label: "Heures supp. 130 %", inputMode: "heures", formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.3, diviseur: 173.33, order: 41 },
  { code: "HS140", label: "Heures supp. 140 %", inputMode: "heures", formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.4, diviseur: 173.33, order: 42 },
  { code: "HS150", label: "Heures supp. 150 %", inputMode: "heures", formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 1.5, diviseur: 173.33, order: 43 },
  { code: "HS200", label: "Heures supp. 200 %", inputMode: "heures", formula: "BASE_DIV_TAUX", stage: "PRIME", taux: 2.0, diviseur: 173.33, order: 44 },
  { code: "PROV_13E", label: "13e mois / Provision 13e", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 45 },
  { code: "SENIORITY", label: "Prime d'ancienneté (saisie)", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 46 },
  { code: "ADVANCE", label: "Avancement automatique", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 47 },
  { code: "PAID_LEAVES", label: "Congés payés (provision saisie)", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 48 },
  { code: "FIN_CONTRAT", label: "Droits fin de contrat", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 49 },
  { code: "ASSURANCE", label: "Assurance maladie", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 50 },
  { code: "ASSUR_ACC", label: "Assurance accident", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 51 },
  { code: "DEPLACEMENT", label: "Frais de déplacement", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 52 },
  { code: "FRAIS_MISSION", label: "Frais de mission", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 53 },
  { code: "BADGES", label: "Badges", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 54 },
  { code: "VISITE_MED", label: "Visite médicale annuelle", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 55 },
  { code: "PR_FETE_TRAV", label: "Prime fête du travail", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 56 },
  { code: "COMM", label: "Communication", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 57 },
  { code: "DEBOURS", label: "Débours", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 58 },
  { code: "ADMIN", label: "Charges administratives", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 59 },
  { code: "FORFAIT_GESTION", label: "Forfait gestion individuelle employé", inputMode: "quantite", formula: "FORFAIT", stage: "PRESTATION", order: 60 },
  { code: "PREST_U", label: "Prestation (quantité × PU)", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 61 },
  { code: "TONNAGE", label: "Tonnage (qté × coût/T)", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 62 },
  { code: "ABSENCE", label: "Absence inopinée / maladie", inputMode: "montant", formula: "FIXE", stage: "RETENUE", order: 63 },
  { code: "RET_DIV", label: "Retenue diverse", inputMode: "montant", formula: "FIXE", stage: "RETENUE", order: 64 },
  { code: "PR_TECH", label: "Prime de technicité", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 65 },
  { code: "PANIER_NUIT", label: "Panier de nuit", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 66 },
  { code: "HS_REGUL", label: "Régularisation heures supp.", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 67 },
  { code: "BONUS_FIELD", label: "Bonus Field Sales", inputMode: "montant", formula: "FIXE", stage: "PRIME", order: 68 },
  { code: "REMB_TRANSPORT", label: "Remboursement transport (Field Sales)", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 69 },
  { code: "IND_LICENC", label: "Indemnité de licenciement", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 70 },
  { code: "PR_SEPARATION", label: "Prime de bonne séparation", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 71 },
  { code: "DOMMAGE_INT", label: "Dommages et intérêts", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 72 },
  { code: "CONSULT_MED", label: "Consultation médecin", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 73 },
  { code: "EPI", label: "Équipement de protection individuelle (EPI)", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 74 },
  { code: "ASSUR_INVAL", label: "Assurance invalidité", inputMode: "montant", formula: "FIXE", stage: "HORS_CHARGE", order: 75 },
  { code: "FORFAIT_POSTE", label: "Forfait mensuel par poste", inputMode: "quantite", formula: "FORFAIT", stage: "PRESTATION", order: 76 },
  { code: "OFFSHORE_ALLOW", label: "Offshore allowance", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 77 },
  { code: "MISSION_ALLOW", label: "Indemnité de mission (jours)", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 78 },
  { code: "SEWING_FEE", label: "Sewing fees / perdiem", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 79 },
  { code: "MEALS", label: "Repas (meals)", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 80 },
  { code: "PERDIEM", label: "Perdiem", inputMode: "quantite", formula: "QTE_PU", stage: "PRESTATION", order: 81 },
];

function seedBilling(tid) {
  for (const k of ["billingContracts", "billingComponents", "billingSheets", "billingAnnexeTemplates"]) if (!db[k]) db[k] = [];
  // Upsert-by-code: fresh tenants get all; existing tenants pick up newly-added components.
  const existingCodes = new Set((db.billingComponents || []).filter(c => (c.tenantId || "t1") === tid).map(c => c.code));
  let added = 0;
  for (const c of COMPONENTS) {
    if (existingCodes.has(c.code)) continue;
    db.billingComponents.push({ id: id("bcmp"), tenantId: tid, ...c, active: true, system: true, createdAt: new Date().toISOString() });
    added++;
  }
  if (added) save();
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
        { key: "LODGING", expr: "IND_LOG", label: "LODGING", w: 55 },
        { key: "TRANSPORTATION", expr: "IND_TRANS", label: "TRANSPORTATION", w: 66 },
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
        { key: "MEDICAL", expr: "VISITE_MED", label: "MEDICAL VISIT", w: 60 },
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
