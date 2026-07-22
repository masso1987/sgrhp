/** Seeds demo users (password: demo123), the 20 document types (§2.3) and portfolios. */
const { db, save, id } = require("./store");
const { hash } = require("./auth");

const DOC_TYPES = [
  ["I","Employment application to the General Manager","PDF"],
  ["II","Detailed location plan","PDF/IMG"],
  ["III","ID photo","IMG"],
  ["IV","Birth certificate","PDF"],
  ["V","National ID card (CNI) — with validity date","PDF/IMG"],
  ["VI","Marriage certificate (if applicable)","PDF"],
  ["VII","Diplomas / certificates / habilitations","PDF"],
  ["VIII","Previous work certificates","PDF"],
  ["IX","Updated CV","PDF/DOCX"],
  ["X","Bank identity statement (RIB)","PDF/IMG"],
  ["XI","CNPS affiliation certificate","PDF"],
  ["XII","Previous employer termination notice","PDF"],
  ["XIII","Hiring notice","PDF"],
  ["XIV","Affiliation control statement","PDF"],
  ["XV","Sanctions (positive or negative)","PDF"],
  ["XVI","Medical visits (history) — expiry alert","PDF"],
  ["XVII","Criminal record extract","PDF"],
  ["XVIII","Job description (PDF/Excel upload)","PDF/XLSX"],
  ["XIX","Decision management (PDF/Excel upload)","PDF/XLSX"],
  ["XX","Other complementary documents","PDF/XLSX"],
];
const CNI = "V";


/** Baseline data for one tenant (referentials, conventions, contract config, career
 *  paths, default portfolios), all stamped with tenantId. Idempotent per tenant. */
function seedTenantData(tid) {
  const has = (coll) => (db[coll] || []).some(x => (x.tenantId || "t1") === tid);
  try { require("./payroll/seed").seedPayroll(tid); } catch (e) { console.error("payroll seed:", e.message); }

  if (!has("referentials")) {
    const R = [
      { key: "collectiveAgreements", label: "Conventions collectives", tag: "collective_agreement", system: true,
        values: ["Convention collective nationale du Commerce","Convention collective des Industries de Transformation",
                 "Convention collective des Entreprises de Prestations de Services","Convention collective de la Sécurité privée"] },
      { key: "categories", label: "Catégories / échelons (convention)", tag: "contract_category", system: true,
        values: ["A1","A2","A3","B1","B2","B3","C1","C2","C3","D1","D2","D3","E1","E2"] },
      { key: "positions", label: "Postes / métiers", tag: "contract_position", system: true,
        values: ["Assistant RH","Technicien électricien","Agent de sécurité","Comptable","Chauffeur","Secrétaire de direction","Agent d'entretien"] },
      { key: "workCities", label: "Lieux de travail", tag: "contract_workCity", system: true,
        values: ["Douala","Yaoundé","Bafoussam","Garoua","Limbé","Kribi","Maroua"] },
      { key: "signatureCities", label: "Lieux de signature", tag: "signature_city", system: true, values: ["Douala","Yaoundé"] },
      { key: "maritalStatuses", label: "Situations matrimoniales", tag: "employee_maritalStatus", system: true,
        values: ["Célibataire","Marié(e)","Divorcé(e)","Veuf/Veuve"] },
      { key: "paymentMethods", label: "Modes de paiement", tag: "contract_paymentMethod", system: true,
        values: ["Virement","Chèque","Espèces","Orange Money","MOMO"] },
      { key: "clientCompanies", label: "Entreprises utilisatrices (clients)", tag: "client_company", system: true,
        values: ["ENEO","Orange Cameroun S.A.","MTN Cameroon","Société Générale Cameroun","Dangote Cement"] },
      { key: "decisionTypes", label: "Types de décisions & sanctions", tag: null, system: true,
        values: ["Promotion","Mutation","Avancement","Félicitations (sanction positive)","Avertissement","Blâme","Mise à pied (sanction négative)"] },
      { key: "leaveTypes", label: "Types de congés & permissions", tag: null, system: true,
        values: ["Congé annuel","Permission exceptionnelle","Congé maladie","Congé maternité","Solde de tout compte"] },
      { key: "avenantTypes", label: "Types d'avenants", tag: null, system: true,
        values: ["Avenant salarial","Avenant de catégorie","Avenant de durée","Avenant de mutation","Avenant de renouvellement"] },
    ];
    // referentials are keyed by `key`; give each a composite id so tenants don't collide
    for (const r of R) db.referentials.push({ ...r, id: id("ref"), tenantId: tid });
  }

  const defaultGrid = [
    { category: "A1", baseSalary: 45000 }, { category: "A2", baseSalary: 55000 }, { category: "A3", baseSalary: 65000 },
    { category: "B1", baseSalary: 80000 }, { category: "B2", baseSalary: 95000 }, { category: "B3", baseSalary: 115000 },
    { category: "C1", baseSalary: 140000 }, { category: "C2", baseSalary: 170000 }, { category: "C3", baseSalary: 200000 },
    { category: "D1", baseSalary: 250000 }, { category: "D2", baseSalary: 310000 }, { category: "D3", baseSalary: 380000 },
    { category: "E1", baseSalary: 460000 }, { category: "E2", baseSalary: 560000 }];

  if (!has("conventions")) {
    const names = (db.referentials.find(r => (r.tenantId||"t1")===tid && r.key === "collectiveAgreements")?.values)
      || ["Convention collective nationale du Commerce"];
    for (const name of names)
      db.conventions.push({ id: id("cnv"), tenantId: tid, name, grid: defaultGrid.map(g => ({ ...g })) });
  }
  if (!has("contractTypes")) {
    db.contractTypes.push(
      { id: id("ctt"), tenantId: tid, name: "CDI", fixedTerm: false, system: true, versions: [{ v: 1, at: new Date().toISOString(), by: "seed", changes: "created" }] },
      { id: id("ctt"), tenantId: tid, name: "CDD", fixedTerm: true, system: true, versions: [{ v: 1, at: new Date().toISOString(), by: "seed", changes: "created" }] });
  }
  if (!has("salaryElements")) {
    db.salaryElements.push(
      { id: id("sel"), tenantId: tid, name: "Salaire de base", tag: "salary_base" },
      { id: id("sel"), tenantId: tid, name: "Indemnité de transport", tag: "allowance_transport" },
      { id: id("sel"), tenantId: tid, name: "Indemnité de logement", tag: "allowance_housing" },
      { id: id("sel"), tenantId: tid, name: "Indemnité de salissure", tag: "allowance_dirt" },
      { id: id("sel"), tenantId: tid, name: "Prime de rendement", tag: "bonus_performance" });
  }
  if (!has("salaryGrid"))
    for (const g of defaultGrid) db.salaryGrid.push({ ...g, id: id("sg"), tenantId: tid });
  if (!has("careerPaths")) {
    db.careerPaths.push(
      { id: id("path"), tenantId: tid, name: "Filière technique", stages: ["Technicien","Technicien senior","Chef d'équipe","Superviseur de site","Responsable d'exploitation"] },
      { id: id("path"), tenantId: tid, name: "Filière administrative", stages: ["Assistant","Chargé de dossier","Chef de service","Directeur adjoint"] });
  }
}

function seed() {
  if (db.users.length) return;
  db.docTypes = DOC_TYPES.map(([code, label, formats]) => ({ code, label, formats }));

  const pf1 = { id: id("pf"), tenantId: "t1", name: "Industrial Clients", required: ["I","III","IV","V","VII","IX","X","XI","XVI"] };
  const pf2 = { id: id("pf"), tenantId: "t1", name: "Banking & Services", required: ["I","III","IV","V","VII","VIII","IX","X","XVII"] };
  const pf3 = { id: id("pf"), tenantId: "t1", name: "Head Office Staff",  required: ["III","IV","V","IX","X"] };
  db.portfolios.push(pf1, pf2, pf3);

  const mk = (email, fullName, role, portfolioIds = []) =>
    db.users.push({ id: id("usr"), tenantId: "t1", email, fullName, role, portfolioIds, password: hash("demo123"), active: true });
  mk("gpf@cible-rh.ci", "Aïcha KABORÉ", "GPF", [pf1.id, pf2.id]);
  mk("cd@cible-rh.ci", "Jean-Marc TANO", "CD");
  mk("rj@cible-rh.ci", "Me. Solange BAMBA", "RJ");
  mk("ui@cible-rh.ci", "Paul N'GUESSAN", "UI");
  mk("admin@cible-rh.ci", "Ferdine MASSO", "ADM");


  if (!db.tenants.length) db.tenants.push({
    id: "t1", status: "ACTIVE", createdAt: new Date().toISOString(), createdBy: "seed",
    name: "Cible RH Emploi S.A.", acronym: "CRHE", legalForm: "SA",
    rccm: "RC/DLA/2018/M/5228", niu: "M10300015976N", cnpsEmployer: "",
    shareCapital: "35000000", sector: "Gestion des ressources humaines",
    hqAddress: "Immeuble Chine/Cameroun, Akwa", hqCity: "Douala", bp: "3462",
    phone: "+237 699 68 36 03", email: "contact@ciblerh-emploi.com",
    legalRep: "Dr Théodoret-Marie FANSI", legalRepTitle: "Directeur Général",
    website: "", logo: "", modules: ["hr", "careers"] });
  db.employees.push({
    id: id("emp"), tenantId: "t1", portfolioId: pf1.id,
    firstName: "Karim", lastName: "OUATTARA",
    hireDate: "2026-03-02", birthDate: "1994-06-14", birthPlace: "Bouaké",
    maritalStatus: "Married", address: "Cocody, Abidjan", phone: "+225 07 09 44 12",
    email: "k.ouattara@mail.ci", emergencyContact: "Awa Ouattara — +225 05 40 22 18",
    cniNumber: "CI00248837", cniExpiry: "2026-09-04", cnpsNumber: "118-224-587",
    contract: { type: "CDI", category: "B2", step: "3", paymentMethod: "TRANSFER", bankIban: "CI042 01001 ****8817", startDate: "2026-03-02" },
    status: "DRAFT", createdBy: "seed", createdAt: new Date().toISOString(),
  });
  seedTenantData("t1");
  { const cnv = db.conventions.find(c => (c.tenantId||"t1")==="t1");
    for (const pf of db.portfolios) if (!pf.conventionId && (pf.tenantId||"t1")==="t1") pf.conventionId = cnv && cnv.id; }
  save();
  console.log("Seeded: 5 users (password demo123), 3 portfolios, 20 doc types, 1 employee");
}
function seedCareer() {
  if (!db.careerPaths.length) {
    db.careerPaths.push(
      { id: id("path"), name: "Filière technique", stages: ["Technicien", "Technicien senior", "Chef d'équipe", "Superviseur de site", "Responsable d'exploitation"] },
      { id: id("path"), name: "Filière administrative", stages: ["Assistant", "Chargé de dossier", "Chef de service", "Directeur adjoint"] });
  }
}
function seedConventions() {
  if (db.conventions.length) return;
  const defaultGrid = [
    { category: "A1", baseSalary: 45000 }, { category: "A2", baseSalary: 55000 }, { category: "A3", baseSalary: 65000 },
    { category: "B1", baseSalary: 80000 }, { category: "B2", baseSalary: 95000 }, { category: "B3", baseSalary: 115000 },
    { category: "C1", baseSalary: 140000 }, { category: "C2", baseSalary: 170000 }, { category: "C3", baseSalary: 200000 },
    { category: "D1", baseSalary: 250000 }, { category: "D2", baseSalary: 310000 }, { category: "D3", baseSalary: 380000 },
    { category: "E1", baseSalary: 460000 }, { category: "E2", baseSalary: 560000 }];
  const names = (db.referentials.find(r => r.key === "collectiveAgreements")?.values) ||
    ["Convention collective nationale du Commerce"];
  for (const name of names)
    db.conventions.push({ id: id("cnv"), name, grid: defaultGrid.map(g => ({ ...g })) });
  for (const pf of db.portfolios) if (!pf.conventionId) pf.conventionId = db.conventions[0].id;
}
function seedContractConfig() {
  seedConventions();
  if (!db.contractTypes.length) {
    db.contractTypes.push(
      { id: id("ctt"), name: "CDI", fixedTerm: false, system: true, versions: [{ v: 1, at: new Date().toISOString(), by: "seed", changes: "created" }] },
      { id: id("ctt"), name: "CDD", fixedTerm: true, system: true, versions: [{ v: 1, at: new Date().toISOString(), by: "seed", changes: "created" }] });
  }
  if (!db.salaryElements.length) {
    db.salaryElements.push(
      { id: id("sel"), name: "Salaire de base", tag: "salary_base" },
      { id: id("sel"), name: "Indemnité de transport", tag: "allowance_transport" },
      { id: id("sel"), name: "Indemnité de logement", tag: "allowance_housing" },
      { id: id("sel"), name: "Indemnité de salissure", tag: "allowance_dirt" },
      { id: id("sel"), name: "Prime de rendement", tag: "bonus_performance" });
  }
  if (!db.salaryGrid.length) {
    db.salaryGrid = [
      { category: "A1", baseSalary: 45000 }, { category: "A2", baseSalary: 55000 }, { category: "A3", baseSalary: 65000 },
      { category: "B1", baseSalary: 80000 }, { category: "B2", baseSalary: 95000 }, { category: "B3", baseSalary: 115000 },
      { category: "C1", baseSalary: 140000 }, { category: "C2", baseSalary: 170000 }, { category: "C3", baseSalary: 200000 },
      { category: "D1", baseSalary: 250000 }, { category: "D2", baseSalary: 310000 }, { category: "D3", baseSalary: 380000 },
      { category: "E1", baseSalary: 460000 }, { category: "E2", baseSalary: 560000 }];
  }
}
function seedReferentials() {
  if (db.referentials.length) return;
  db.referentials.push(
    { key: "collectiveAgreements", label: "Conventions collectives", tag: "collective_agreement", system: true,
      values: ["Convention collective nationale du Commerce",
               "Convention collective des Industries de Transformation",
               "Convention collective des Entreprises de Prestations de Services",
               "Convention collective de la Sécurité privée"] },
    { key: "categories", label: "Catégories / échelons (convention)", tag: "contract_category", system: true,
      values: ["A1","A2","A3","B1","B2","B3","C1","C2","C3","D1","D2","D3","E1","E2"] },
    { key: "positions", label: "Postes / métiers", tag: "contract_position", system: true,
      values: ["Assistant RH","Technicien électricien","Agent de sécurité","Comptable",
               "Chauffeur","Secrétaire de direction","Agent d'entretien"] },
    { key: "workCities", label: "Lieux de travail", tag: "contract_workCity", system: true,
      values: ["Douala","Yaoundé","Bafoussam","Garoua","Limbé","Kribi","Maroua"] },
    { key: "signatureCities", label: "Lieux de signature", tag: "signature_city", system: true,
      values: ["Douala","Yaoundé"] },
    { key: "maritalStatuses", label: "Situations matrimoniales", tag: "employee_maritalStatus", system: true,
      values: ["Célibataire","Marié(e)","Divorcé(e)","Veuf/Veuve"] },
    { key: "paymentMethods", label: "Modes de paiement", tag: "contract_paymentMethod", system: true,
      values: ["Virement","Chèque","Espèces","Orange Money","MOMO"] },
    { key: "clientCompanies", label: "Entreprises utilisatrices (clients)", tag: "client_company", system: true,
      values: ["ENEO","Orange Cameroun S.A.","MTN Cameroon","Société Générale Cameroun","Dangote Cement"] },
    { key: "decisionTypes", label: "Types de décisions & sanctions", tag: null, system: true,
      values: ["Promotion","Mutation","Avancement","Félicitations (sanction positive)",
               "Avertissement","Blâme","Mise à pied (sanction négative)"] },
    { key: "leaveTypes", label: "Types de congés & permissions", tag: null, system: true,
      values: ["Congé annuel","Permission exceptionnelle","Congé maladie","Congé maternité","Solde de tout compte"] },
    { key: "avenantTypes", label: "Types d'avenants", tag: null, system: true,
      values: ["Avenant salarial","Avenant de catégorie","Avenant de durée","Avenant de mutation","Avenant de renouvellement"] }
  );
}
// Ensure referentials exist even on older databases
function ensureAccounts() {
  const { hash } = require("./auth");
  // Platform super-administrator (added after initial deployments)
  if (!db.users.some(u => u.role === "SADM")) {
    db.users.push({ id: id("usr"), email: "superadmin@sgrhp.io", fullName: "Super Administrateur",
      role: "SADM", tenantId: "platform", portfolioIds: [], password: hash("Superadmin2026"), active: true });
    console.log("Ensured super-admin account: superadmin@sgrhp.io");
  }
  // First tenant record if the platform has none
  if (!db.tenants || !db.tenants.length) {
    db.tenants = db.tenants || [];
    db.tenants.push({ id: "t1", status: "ACTIVE", createdAt: new Date().toISOString(), createdBy: "seed",
      name: "Cible RH Emploi S.A.", acronym: "CRHE", legalForm: "SA",
      rccm: "RC/DLA/2018/M/5228", niu: "M10300015976N", cnpsEmployer: "",
      shareCapital: "35000000", sector: "Gestion des ressources humaines",
      hqAddress: "Immeuble Chine/Cameroun, Akwa", hqCity: "Douala", bp: "3462",
      phone: "+237 699 68 36 03", email: "contact@ciblerh-emploi.com",
      legalRep: "Dr Théodoret-Marie FANSI", legalRepTitle: "Directeur Général",
      website: "", logo: "", modules: ["hr", "careers"] });
  }
  save();
}
function ensureReferentials() { seedTenantData("t1"); ensureAccounts(); save(); }
module.exports = { seed, ensureReferentials, seedTenantData, CNI };
