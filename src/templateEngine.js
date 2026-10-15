/**
 * M3 - Template-based document generation.
 * Admin uploads a Word (.docx) template containing {{placeholders}}.
 * At generation: known placeholders auto-fill from the employee file;
 * unknown ones are collected from the GPF via a form before submission.
 * Final DOCX is rendered when the RJ gives final approval (§5.2, §7.1).
 */
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const { db } = require("./store");

const TPL_DIR = path.join(__dirname, "..", "templates");
// Répertoire INSCRIPTIBLE pour les modèles téléversés (le dossier bundlé /app/templates
// est monté en lecture seule dans Docker). On écrit dans le volume persistant "uploads".
const TPL_WRITE_DIR = process.env.TEMPLATES_DIR || path.join(__dirname, "..", "uploads", "templates");
try { fs.mkdirSync(TPL_WRITE_DIR, { recursive: true }); } catch (e) {}
/** Chemin d'un modèle : priorité au dossier inscriptible, sinon dossier bundlé (seed). */
function tplPath(storedAs) {
  const w = path.join(TPL_WRITE_DIR, storedAs);
  if (fs.existsSync(w)) return w;
  return path.join(TPL_DIR, storedAs);
}

/** Nom -> tag normalisé (minuscules, sans accents, underscores). */
function slugTag(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Output formatting: ISO dates -> DD/MM/YYYY, plain numbers -> thousands spacing. */
function fmtValue(v) {
  const s = String(v).trim();
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return `${d[3]}/${d[2]}/${d[1]}`;
  if (/^\d{4,9}$/.test(s)) return Number(s).toLocaleString("fr-FR").replace(/\u202f|,/g, " ");
  return s;
}
try { fs.mkdirSync(TPL_DIR, { recursive: true }); } catch (e) {}

/** Scan a .docx for {{tags}} */
function scanTags(filePath) {
  const zip = new PizZip(fs.readFileSync(filePath));
  const xml = zip.file("word/document.xml").asText();
  const text = xml.replace(/<[^>]+>/g, "");
  return [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]))];
}

/** Values the system can resolve automatically from the employee record (auto-fill). */
function autoContext(employeeId) {
  const e = db.employees.find(x => x.id === employeeId) || {};
  const _tid = e.tenantId || "t1";
  const _mine = (coll) => (db[coll] || []).filter(x => (x.tenantId || "t1") === _tid);
  const pf = db.portfolios.find(p => p.id === e.portfolioId);
  const c = e.contract || {};
  const today = new Date().toLocaleDateString("fr-FR");
  const base = {
    employee_fullName: [e.firstName, e.lastName].filter(Boolean).join(" "),
    employee_firstName: e.firstName, employee_lastName: e.lastName,
    employee_birthDate: e.birthDate, employee_birthPlace: e.birthPlace,
    employee_maritalStatus: e.maritalStatus, employee_residence: e.address,
    employee_phone: e.phone, employee_cniNumber: e.cniNumber,
    employee_cnpsNumber: e.cnpsNumber, employee_hireDate: e.hireDate,
    employee_matricule: e.matricule, work_city: (c.workCity || e.workCity || "Douala"),
    contract_type: c.type, contract_category: c.category, contract_step: c.step,
    contract_startDate: c.startDate || e.hireDate,
    contract_position: c.position || e.position,          // Emploi/poste (auto)
    contract_paymentMethod: c.paymentMethod,
    portfolio_name: pf?.name,
    client_company: pf?.clientCompany || pf?.name,        // portefeuille = entreprise utilisatrice (auto)
    signature_city: "Douala", signature_date: today, today,
    company_name: "CIBLE RH EMPLOI S.A.", company_bp: "BP 3462 Douala",
    work_hours: "40 heures / semaine",
  };
  // Open-ended (CDI) contracts have no end date / mission duration -> "indéterminée"
  const _ct = _mine("contractTypes").find(t => t.name === c.type);
  const _openEnded = _ct ? !_ct.fixedTerm : (String(c.type).toUpperCase() === "CDI");
  // CDI (open-ended): auto "indéterminée". CDD (fixed-term): a specific end date,
  // so leave contract_endDate & mission_duration to be entered manually at generation.
  if (_openEnded) {
    base.contract_endDate = "indéterminée";
    base.mission_duration = "indéterminée";
  }

  // Salary elements: expose EVERY selected rubrique that has a figure for this employee.
  //   - its configured {{tag}} (if any)
  //   - a deterministic auto-tag  salary_<slug du nom>  (ex. « Salaire de base » -> salary_salaire_de_base)
  //   - salary_<code rubrique Paie>  si la rubrique est liée à une rubrique de paie
  // Ainsi tous les éléments de salaire saisis (avec montant) sont disponibles dans les modèles.
  let gross = 0;
  for (const el of _mine("salaryElements")) {
    const amount = (e.salary || {})[el.name];
    if (amount === undefined || amount === null || amount === "") continue;
    gross += Number(amount) || 0;
    if (el.tag) base[el.tag] = amount;
    const slug = "salary_" + slugTag(el.name);
    if (base[slug] === undefined) base[slug] = amount;
    if (el.rubriqueCode) { const rk = "salary_" + String(el.rubriqueCode).replace(/[^a-z0-9]/gi, ""); if (base[rk] === undefined) base[rk] = amount; }
  }
  if (gross > 0) base.salary_gross = gross;
  // Convention collective of the employee's portfolio: name + salary figures
  const cnv = _mine("conventions").find(x => x.id === (c.conventionId || pf?.conventionId));
  if (cnv) base.collective_agreement = cnv.name;
  else if (c.conventionName) base.collective_agreement = c.conventionName;
  if (base.salary_base === undefined && c.category) {
    const row = (cnv?.grid || []).find(g => g.category === c.category)
      || _mine("salaryGrid").find(g => g.category === c.category);
    if (row && row.baseSalary > 0) { base.salary_base = row.baseSalary; if (!gross) base.salary_gross = row.baseSalary; }
  }
  return base;
}

/**
 * Catalogue des variables disponibles pour les modèles (sans employé précis) :
 * employé, contrat, portefeuille, société, et un tag par élément de salaire sélectionné.
 * Sert à guider l'admin (« quelles {{variables}} puis-je mettre dans mon modèle »).
 */
function catalogVariables(tid) {
  tid = tid || "t1";
  const _mine = (coll) => (db[coll] || []).filter(x => (x.tenantId || "t1") === tid);
  const groups = [
    { group: "Employé", vars: [
      ["employee_fullName", "Nom et prénom"], ["employee_firstName", "Prénom"], ["employee_lastName", "Nom"],
      ["employee_birthDate", "Date de naissance"], ["employee_birthPlace", "Lieu de naissance"],
      ["employee_maritalStatus", "Situation familiale"], ["employee_residence", "Adresse / résidence"],
      ["employee_phone", "Téléphone"], ["employee_cniNumber", "N° CNI"], ["employee_cnpsNumber", "N° CNPS"],
      ["employee_matricule", "Matricule"], ["employee_hireDate", "Date d'embauche"],
    ]},
    { group: "Contrat", vars: [
      ["contract_type", "Type de contrat"], ["contract_category", "Catégorie"], ["contract_step", "Échelon"],
      ["contract_startDate", "Date de début"], ["contract_endDate", "Date de fin (CDI = indéterminée)"],
      ["contract_position", "Emploi / poste"], ["contract_paymentMethod", "Mode de paiement"],
      ["mission_duration", "Durée de mission"], ["work_city", "Ville de travail"], ["work_hours", "Horaire de travail"],
      ["collective_agreement", "Convention collective"],
    ]},
    { group: "Société & portefeuille", vars: [
      ["company_name", "Raison sociale (employeur)"], ["company_bp", "Boîte postale"],
      ["portfolio_name", "Portefeuille"], ["client_company", "Entreprise utilisatrice (client)"],
      ["signature_city", "Ville de signature"], ["signature_date", "Date de signature"], ["today", "Date du jour"],
    ]},
  ];
  const sal = [["salary_gross", "Salaire brut (total)"], ["salary_base", "Salaire de base"]];
  for (const el of _mine("salaryElements")) {
    sal.push(["salary_" + slugTag(el.name), el.name + (el.rubriqueCode ? " (rubrique " + el.rubriqueCode + ")" : "")]);
    if (el.tag) sal.push([el.tag, el.name + " — tag personnalisé"]);
  }
  groups.push({ group: "Éléments de salaire", vars: sal });
  return groups;
}

/** Resolve tags: returns { resolved: {tag: value}, missing: [tags] } */
function resolve(templateId, employeeId, provided = {}) {
  const tpl = db.templates.find(t => t.id === templateId);
  if (!tpl) { const e = new Error("Template not found"); e.status = 404; throw e; }
  const auto = autoContext(employeeId);
  const resolved = {}, missing = [];
  for (const tag of tpl.tags) {
    const v = provided[tag] ?? auto[tag];
    if (v === undefined || v === null || v === "") missing.push(tag);
    else resolved[tag] = fmtValue(v);
  }
  return { resolved, missing, template: tpl };
}

/** Render final DOCX with the stored data. */
function render(templateId, data, outName) {
  const tpl = db.templates.find(t => t.id === templateId);
  const zip = new PizZip(fs.readFileSync(tplPath(tpl.storedAs)));
  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{{", end: "}}" },
    paragraphLoop: true, linebreaks: true,
    nullGetter: () => "________",
  });
  const formatted = {};
  for (const [k, v] of Object.entries(data)) formatted[k] = fmtValue(v);
  doc.render(formatted);
  const outDir = path.join(__dirname, "..", "uploads", "generated");
  fs.mkdirSync(outDir, { recursive: true });
  const fname = `${outName}.docx`;
  fs.writeFileSync(path.join(outDir, fname), doc.getZip().generate({ type: "nodebuffer" }));
  return fname;
}

/** Métadonnées des modèles fournis (nom lisible + type de document / processus). */
const SEED_TPL_META = {
  "AVI_Attestation_Virement_Irrevocable.docx": { name: "Attestation de virement irrévocable (AVI)", docType: "ATTESTATION" },
  "Solde_de_tout_compte.docx": { name: "Solde de tout compte", docType: "SOLDE_TOUT_COMPTE" },
  "Avenant_Renouvellement_Contrat.docx": { name: "Avenant / Renouvellement de contrat", docType: "AVENANT" },
  "Avertissement.docx": { name: "Lettre d'avertissement", docType: "AVERTISSEMENT" },
  "Certificat_de_travail.docx": { name: "Certificat de travail", docType: "CERTIFICAT" },
  "Decision_de_mise_en_conge.docx": { name: "Décision de mise en congé", docType: "DECISION_CONGE" },
  "CDD_template.docx": { name: "Contrat à durée déterminée (CDD)", docType: "CONTRACT" },
  "CDI_template.docx": { name: "Contrat à durée indéterminée (CDI)", docType: "CONTRACT" },
};
/** Register any .docx dropped in templates/ that is not yet in the DB (seed sync). */
function syncSeedTemplates() {
  const { save, id } = require("./store");
  for (const f of fs.readdirSync(TPL_DIR).filter(x => x.endsWith(".docx"))) {
    if (db.templates.find(t => t.storedAs === f)) continue;
    try {
      const tags = scanTags(path.join(TPL_DIR, f));
      if (!tags.length) continue;
      const meta = SEED_TPL_META[f] || {};
      db.templates.push({ id: id("tpl"), name: meta.name || f.replace(/\.docx$/i, "").replace(/_/g, " "),
        docType: meta.docType || "CONTRACT", storedAs: f, originalName: f, tags,
        uploadedBy: "seed", uploadedAt: new Date().toISOString() });
      console.log("Template registered:", f, `(${tags.length} tags)`);
    } catch (err) { console.error("Template sync failed:", f, err.message); }
  }
  save();
}
module.exports = { scanTags, autoContext, resolve, render, fmtValue, slugTag, catalogVariables, TPL_DIR, TPL_WRITE_DIR, tplPath, syncSeedTemplates };
