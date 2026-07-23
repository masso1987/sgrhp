/**
 * M3 — Template-based document generation.
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

/** Output formatting: ISO dates -> DD/MM/YYYY, plain numbers -> thousands spacing. */
function fmtValue(v) {
  const s = String(v).trim();
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return `${d[3]}/${d[2]}/${d[1]}`;
  if (/^\d{4,9}$/.test(s)) return Number(s).toLocaleString("fr-FR").replace(/\u202f|,/g, " ");
  return s;
}
fs.mkdirSync(TPL_DIR, { recursive: true });

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

  // Salary elements: expose configured tags + gross total; salary-grid fallback for base
  let gross = 0;
  for (const el of _mine("salaryElements")) {
    const amount = (e.salary || {})[el.name];
    if (amount !== undefined) { gross += Number(amount) || 0; if (el.tag) base[el.tag] = amount; }
  }
  if (gross > 0) base.salary_gross = gross;
  // Convention collective of the employee's portfolio: name + salary figures
  const cnv = _mine("conventions").find(x => x.id === pf?.conventionId);
  if (cnv) base.collective_agreement = cnv.name;
  if (base.salary_base === undefined && c.category) {
    const row = (cnv?.grid || []).find(g => g.category === c.category)
      || _mine("salaryGrid").find(g => g.category === c.category);
    if (row && row.baseSalary > 0) { base.salary_base = row.baseSalary; if (!gross) base.salary_gross = row.baseSalary; }
  }
  return base;
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
  const zip = new PizZip(fs.readFileSync(path.join(TPL_DIR, tpl.storedAs)));
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

/** Register any .docx dropped in templates/ that is not yet in the DB (seed sync). */
function syncSeedTemplates() {
  const { save, id } = require("./store");
  for (const f of fs.readdirSync(TPL_DIR).filter(x => x.endsWith(".docx"))) {
    if (db.templates.find(t => t.storedAs === f)) continue;
    try {
      const tags = scanTags(path.join(TPL_DIR, f));
      if (!tags.length) continue;
      db.templates.push({ id: id("tpl"), name: f.replace(/\.docx$/i, "").replace(/_/g, " "),
        docType: "CONTRACT", storedAs: f, originalName: f, tags,
        uploadedBy: "seed", uploadedAt: new Date().toISOString() });
      console.log("Template registered:", f, `(${tags.length} tags)`);
    } catch (err) { console.error("Template sync failed:", f, err.message); }
  }
  save();
}
module.exports = { scanTags, autoContext, resolve, render, fmtValue, TPL_DIR, syncSeedTemplates };
