/**
 * Two-level validation workflow (§5): GPF submits → CD (48h) → RJ (48h) → generation → UI prints.
 * Mandatory rejection reason (§4.2); resubmission cycles counted for evaluation (§4.3).
 */
const fs = require("fs");
const path = require("path");
const { db, save, id } = require("./store");
const { audit } = require("./audit");
const notify = require("./notify");
const { elapsedBusinessHours } = require("./businessHours");
const engine = require("./templateEngine");

const SLA = 48, WARN = 36;
const initiatorName = (uid) => (db.users.find(u => u.id === uid) || {}).fullName || "un gestionnaire";

function docOf(documentId) {
  const d = db.documents.find(x => x.id === documentId);
  if (!d) { const e = new Error("Document not found"); e.status = 404; throw e; }
  return d;
}
const openStep = d => d.steps.find(s => !s.decidedAt);

/* ---- Workflow configurable par tenant (Administration › Circuits de validation) ---- */
const WF_KEY = (type) => ({ EMPLOYEE_FILE: "employee_file", TEMPLATE_DOC: "template_doc", AMENDMENT: "amendment", AVI: "avi", CONTRACT_END: "contract_end" }[type] || "template_doc");
const WF_DEFAULT = { employee_file: ["CD", "RJ"], template_doc: ["CD", "RJ"], amendment: ["CD", "RJ"], avi: ["CD", "RJ"], contract_end: ["RJ"] };
function wfRoles(type) {
  const key = WF_KEY(type);
  let cfg = null; try { cfg = require("./routes/settings").settings().workflows; } catch (e) {}
  const w = cfg && cfg[key];
  if (w) { if (w.enabled === false) return []; if (Array.isArray(w.steps)) return w.steps.filter(Boolean); }
  return WF_DEFAULT[key] || ["CD", "RJ"];
}
const mkStep = (role, at) => ({ id: id("stp"), stage: role, assignedAt: at || new Date().toISOString(),
  warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
/* Démarre (ou finalise si aucun niveau de validation) le circuit d'un document. */
function startWorkflow(doc, user) {
  const roles = wfRoles(doc.type);
  doc.flowRoles = roles; doc.flowPos = 0;
  doc.submittedAt = new Date().toISOString();
  if (!roles.length) {                       // aucun niveau -> génération immédiate
    doc.status = "GENERATED"; doc.generatedAt = new Date().toISOString();
    doc.generatedFile = generateOfficial(doc); setEmpStatus(doc, "VALIDATED");
    audit(user, "GENERATED", "Document", doc.id, { noWorkflow: true });
    notify.event("validated", { userId: doc.createdById }, { title: doc.title, ref: doc.id });
    try { notify.toRole("UI", "Nouveau document disponible", doc.title, doc.id); } catch (e) {}
    return;
  }
  doc.status = "SUBMITTED";
  doc.steps.push(mkStep(roles[0], doc.submittedAt));
  setEmpStatus(doc, "SUBMITTED");
  notify.event("submitted", { role: roles[0] }, { title: doc.title, initiator: initiatorName(doc.createdById), sla: SLA, ref: doc.id });
}

/** M3: create a document from an uploaded template. Missing tags must be provided (form). */
function createFromTemplate(templateId, employeeId, provided, user) {
  const emp = db.employees.find(e => e.id === employeeId);
  if (!emp) { const e = new Error("Employee not found"); e.status = 404; throw e; }
  const { resolved, missing, template } = engine.resolve(templateId, employeeId, provided);
  if (missing.length) {
    const e = new Error("Missing information: " + missing.join(", "));
    e.status = 422; e.missing = missing; throw e;
  }
  const doc = { id: id("doc"), tenantId: user.tenantId || "t1", type: "TEMPLATE_DOC", refId: employeeId,
    templateId, data: resolved,
    title: `${template.name} — ${emp.firstName} ${emp.lastName}`,
    createdById: user.id, createdAt: new Date().toISOString(),
    status: "DRAFT", cycle: 1, steps: [], generatedFile: null };
  db.documents.push(doc);
  audit(user, "CREATED", "Document", doc.id, { template: template.name });
  startWorkflow(doc, user); save();
  audit(user, "SUBMITTED", "Document", doc.id, { cycle: 1 });
  return doc;
}

/** Resubmit a rejected template document with corrected data. */
function resubmitTemplateDoc(documentId, provided, user) {
  const doc = db.documents.find(d => d.id === documentId);
  if (!doc || doc.type !== "TEMPLATE_DOC") { const e = new Error("Not found"); e.status = 404; throw e; }
  if (doc.status !== "DRAFT") { const e = new Error(`Cannot resubmit (status ${doc.status})`); e.status = 409; throw e; }
  const { resolved, missing } = engine.resolve(doc.templateId, doc.refId, { ...doc.data, ...provided });
  if (missing.length) { const e = new Error("Missing information: " + missing.join(", ")); e.status = 422; throw e; }
  doc.data = resolved; doc.cycle += 1;
  startWorkflow(doc, user); save();
  audit(user, "SUBMITTED", "Document", doc.id, { cycle: doc.cycle });
  return doc;
}

/** GPF submits an employee file. Gate: all required portfolio docs uploaded (§2.3). */
function submitEmployeeFile(employeeId, user, opts = {}) {
  const emp = db.employees.find(e => e.id === employeeId);
  if (!emp) { const e = new Error("Employee not found"); e.status = 404; throw e; }
  const pf = db.portfolios.find(p => p.id === emp.portfolioId);
  const uploaded = new Set(db.files.filter(f => f.employeeId === employeeId).map(f => f.docType));
  // Gate à la création : seuls les documents "requis à la création" (CNI + choix admin) sont obligatoires.
  // Les autres documents requis peuvent être fournis après création et sont suivis dans le SMQ (conformité).
  const gateList = (pf && Array.isArray(pf.requiredCreation) && pf.requiredCreation.length) ? pf.requiredCreation : ["V"];
  const missing = gateList.filter(c => !uploaded.has(c));
  if (!opts.skipGate && missing.length) {
    const e = new Error(`Cannot submit: required documents missing (${missing.join(", ")}) — §2.3`);
    e.status = 400; throw e;
  }
  let doc = db.documents.find(d => d.type === "EMPLOYEE_FILE" && d.refId === employeeId);
  if (doc && !["DRAFT"].includes(doc.status)) {
    const e = new Error(`Already in workflow (status ${doc.status})`); e.status = 409; throw e;
  }
  if (!doc) {
    doc = { id: id("doc"), tenantId: user.tenantId || "t1", type: "EMPLOYEE_FILE", refId: employeeId,
      title: `Employee file — ${emp.firstName} ${emp.lastName}`,
      createdById: user.id, createdAt: new Date().toISOString(),
      status: "DRAFT", cycle: 0, steps: [], generatedFile: null };
    db.documents.push(doc);
  }
  doc.cycle += 1;
  startWorkflow(doc, user); save();
  audit(user, "SUBMITTED", "Document", doc.id, { cycle: doc.cycle, title: doc.title });
  return doc;
}

function approve(documentId, user) {
  const doc = docOf(documentId);
  const step = openStep(doc);
  assertStage(doc, step, user);
  step.decidedAt = new Date().toISOString();
  step.decision = "APPROVED"; step.validatorId = user.id;
  step.elapsedH = elapsedBusinessHours(step.assignedAt);

  const roles = (Array.isArray(doc.flowRoles) && doc.flowRoles.length) ? doc.flowRoles : wfRoles(doc.type);
  doc.flowPos = (doc.flowPos || 0) + 1;
  if (doc.flowPos < roles.length) {
    const nextRole = roles[doc.flowPos];
    doc.status = "SUBMITTED";              // encore en cours de validation
    doc.steps.push(mkStep(nextRole));
    notify.event("submitted", { role: nextRole }, { title: doc.title, initiator: initiatorName(doc.createdById), stage: nextRole, sla: SLA, ref: doc.id });
  } else {
    doc.status = "GENERATED";
    doc.generatedAt = new Date().toISOString();
    doc.generatedFile = generateOfficial(doc);
    setEmpStatus(doc, "VALIDATED");
    notify.event("validated", { userId: doc.createdById }, { title: doc.title, ref: doc.id });
    try { notify.toRole("UI", "New document available for printing", doc.title, doc.id); } catch (e) {}
    audit(user, "GENERATED", "Document", doc.id);
  }
  save();
  audit(user, "VALIDATED", "Document", doc.id, { stage: user.role, elapsedBusinessHours: step.elapsedH });
  return doc;
}

function reject(documentId, user, reason) {
  if (!reason || !String(reason).trim()) {
    const e = new Error("Rejection reason is mandatory (§4.2)"); e.status = 400; throw e;
  }
  const doc = docOf(documentId);
  const step = openStep(doc);
  assertStage(doc, step, user);
  step.decidedAt = new Date().toISOString();
  step.decision = "REJECTED"; step.validatorId = user.id; step.rejectReason = reason;
  step.elapsedH = elapsedBusinessHours(step.assignedAt);
  doc.status = "DRAFT"; doc.flowPos = 0; // retour au GPF, resoumission relance le circuit
  setEmpStatus(doc, "DRAFT");
  save();
  audit(user, "REJECTED", "Document", doc.id, { stage: user.role, reason });
  notify.event("rejected", { userId: doc.createdById, role: user.role === "RJ" ? "CD" : undefined },
    { title: doc.title, validator: user.role, reason, ref: doc.id });
  return doc;
}

function assertStage(doc, step, user) {
  if (!step) { const e = new Error("No pending validation step"); e.status = 409; throw e; }
  if (step.stage !== user.role) {
    const e = new Error(`This document is at stage ${step.stage}; role ${user.role} cannot decide it`);
    e.status = 403; throw e;
  }
}
function setEmpStatus(doc, status) {
  if (doc.type === "EMPLOYEE_FILE") {
    const emp = db.employees.find(e => e.id === doc.refId);
    if (emp) emp.status = status;
  }
}

/* Écrit un fichier généré dans uploads/generated et renvoie son nom. */
function writeGenerated(docId, ext, buffer) {
  const dir = path.join(__dirname, "..", "uploads", "generated");
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${docId}${ext}`;
  fs.writeFileSync(path.join(dir, fname), buffer);
  return fname;
}
function companyInfo() {
  const b = (db.settings && db.settings.branding) || {};
  const c = b.company || {};
  return { name: c.name || b.appName || "CIBLE RH EMPLOI S.A.", bp: c.address || "BP 3462 Douala",
    dg: c.dg || "le Directeur Général", dga: c.dga || "",
    city: c.city || "Douala", niu: c.niu || "" };
}
const _fr = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || ""); };
function aviParagraphs(doc) {
  const d = doc.data || {}; const co = companyInfo();
  const civ = d.civility || "Monsieur"; const name = d.employeeName || "";
  const duree = (d.contractType === "CDD") ? "durée déterminée" : "durée indéterminée";
  const p1 = d.variant === "mission"
    ? `1- Attestons que ${civ} ${name} est employé dans notre société depuis le ${_fr(d.hireDate)}, occupe à ce jour la fonction de ${d.fonction || "……"} et présentement en mission auprès de l'entreprise ${d.missionCompany || "……"}.`
    : `1- Attestons que ${civ} ${name} est employé permanent dans notre société depuis le ${_fr(d.hireDate)} et occupe à ce jour la fonction de ${d.fonction || "……"}.`;
  return [
    { text: `Réf : ${d.ref || co.name.split(" ")[0] + "/DG/DGA/RH"}`, size: 20 },
    { text: "ATTESTATION DE VIREMENT IRRÉVOCABLE DE SALAIRE, D'EMPLOI ET DE NON ENDETTEMENT AUPRÈS DE L'EMPLOYEUR", bold: true, align: "center", size: 24 },
    { text: `Nous soussignée ${co.name}, ${co.bp}, représentée par le Président Directeur Général ${co.dg},` },
    { text: p1 },
    { text: `2- Attestons qu'à la date de signature de la présente, le salarié est engagé en vertu d'un contrat à ${duree}.` },
    { text: `3- Attestons que le salarié n'est pas redevable à ce jour vis-à-vis de ${co.name} d'une quelconque dette. Nous nous engageons sur son ordre formel à virer irrévocablement à son compte N° Compte : ${d.accountNumber || "…………"} ouvert à la ${d.bankName || "…………"}, toutes sommes qui lui seraient dues dans notre société au titre de salaire, indemnités et soldes.` },
    { text: "4- Nous nous engageons également à virer toutes indemnités qui lui seraient dues s'il venait à quitter pour quelque raison que ce soit notre société et à aviser le Chef d'Agence et/ou le Directeur Clientèle des Particuliers de la banque de ce départ définitif au plus tard 05 jours ouvrés et/ou en même temps que le virement de liquidation de ses droits." },
    { text: "5- Nous nous engageons à ne donner aucun acompte au salarié, et dès lors à virer la totalité de son salaire jusqu'à modification ou suspension suivant les termes du point 6 ci-dessous." },
    { text: `6- Cet ordre ne pourra être modifié ou suspendu qu'après accord donné par le Chef d'Agence et/ou le Directeur Clientèle des Particuliers de la banque, ou après délivrance d'une attestation de non endettement, conjointement avec l'intéressé, ${civ} ${name}.` },
    { text: "En foi de quoi, la présente attestation lui est délivrée pour servir et valoir ce que de droit. /." },
    { text: "NB : Cette attestation doit être utilisée dans un délai de 15 jours à compter de la date de signature. " + co.name + " n'est en aucun cas une caution en cas d'octroi de prêts.", italic: true, size: 18 },
    { text: `Fait à ${co.city}, le ${_fr(d.date) || new Date().toLocaleDateString("fr-FR")}.`, align: "right" },
    { text: "LA DIRECTRICE GÉNÉRALE ADJOINTE,", bold: true, align: "right", size: 20 },
    { text: `${co.dga || ""}`, bold: true, align: "right" },
  ];
}
function contractEndParagraphs(doc) {
  const d = doc.data || {}; const co = companyInfo();
  const civ = d.civility || "Monsieur"; const name = d.employeeName || "";
  return [
    { text: `Réf : ${d.ref || ""}`, size: 20 },
    { text: `${co.city}, le ${_fr(d.date) || new Date().toLocaleDateString("fr-FR")}`, align: "right", size: 20 },
    { text: `À l'attention du Chef d'Agence,\n${d.bankName || "…………"}`, bold: true },
    { text: `Objet : Fin de contrat — ${civ} ${name}`, bold: true },
    { text: `Madame, Monsieur,` },
    { text: `Nous vous informons que ${civ} ${name}, matricule ${d.matricule || "……"}, employé(e) de ${co.name}, a cessé ses fonctions au sein de notre société le ${_fr(d.endDate)}${d.motif ? " (motif : " + d.motif + ")" : ""}.` },
    { text: `Le virement correspondant à son dernier salaire${d.lastNet ? " (net : " + Number(d.lastNet).toLocaleString("fr-FR") + " FCFA)" : ""} et au solde de tout compte sera effectué sur le compte N° ${d.accountNumber || "…………"} ouvert dans vos livres. En conséquence, l'attestation de virement irrévocable établie au profit de l'intéressé(e) prend fin à cette date.` },
    { text: `Nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.` },
    { text: "LA DIRECTRICE GÉNÉRALE ADJOINTE,", bold: true, align: "right", size: 20 },
    { text: `${co.dga || ""}`, bold: true, align: "right" },
  ];
}
/** Official document generation (§7.1): Word template rendering for template docs. */
function generateOfficial(doc) {
  if (doc.type === "AVI") return writeGenerated(doc.id, ".docx", require("./docgen").buildDocx(aviParagraphs(doc)));
  if (doc.type === "CONTRACT_END") return writeGenerated(doc.id, ".docx", require("./docgen").buildDocx(contractEndParagraphs(doc)));
  if (doc.type === "AMENDMENT") {
    // Apply the approved amendment to the live contract (history stays in the document)
    const emp = db.employees.find(e => e.id === doc.refId);
    if (emp) {
      const { salary, ...contractChanges } = doc.data.changes;
      emp.contract = { ...(emp.contract || {}), ...contractChanges };
      if (salary) emp.salary = { ...(emp.salary || {}), ...salary };
    }
  }
  if (doc.templateId) return engine.render(doc.templateId, doc.data, doc.id);
  const dir = path.join(__dirname, "..", "uploads", "generated");
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${doc.id}.html`;
  const emp = doc.type === "EMPLOYEE_FILE" ? db.employees.find(e => e.id === doc.refId) : null;
  fs.writeFileSync(path.join(dir, fname), `<html><body style="font-family:serif">
    <h2>CIBLE RH EMPLOI S.A. — OFFICIAL DOCUMENT</h2><h3>${doc.title}</h3>
    ${emp ? `<p>Employee: ${emp.firstName} ${emp.lastName}<br>CNI: ${emp.cniNumber}<br>CNPS: ${emp.cnpsNumber || ""}<br>Hired: ${emp.hireDate}</p>` : ""}
    <p>Generated: ${new Date().toISOString()}</p>
    <p><i>M3 will generate this from your uploaded Word template.</i></p></body></html>`);
  return fname;
}

/** SLA scan (§5.4) — run every minute; also invoked lazily on queue reads. */
function slaScan() {
  let changed = false;
  for (const doc of db.documents) {
    const step = openStep(doc);
    if (!step) continue;
    const h = elapsedBusinessHours(step.assignedAt);
    if (h >= WARN && !step.warnedAt) {
      step.warnedAt = new Date().toISOString(); changed = true;
      notify.event("slaWarning", { role: step.stage }, { title: doc.title, elapsed: h, stage: step.stage, ref: doc.id });
      notify.event("slaWarning", { role: "ADM" }, { title: doc.title, elapsed: h, stage: step.stage, ref: doc.id }); // supervisor
    }
    if (h > SLA && !step.breachedAt) {
      step.breachedAt = new Date().toISOString(); changed = true;
      notify.event("slaBreach", { role: step.stage }, { title: doc.title, elapsed: h, stage: step.stage, ref: doc.id });
      notify.event("slaBreach", { role: "ADM" }, { title: doc.title, elapsed: h, stage: step.stage, ref: doc.id });
    }
  }
  if (changed) save();
}

const withTimer = d => {
  const step = openStep(d);
  return { ...d, currentStage: step?.stage || null,
    elapsedH: step ? elapsedBusinessHours(step.assignedAt) : null,
    slaState: !step ? null : step.breachedAt ? "BREACH" : step.warnedAt ? "WARNING" : "OK" };
};

module.exports = { submitEmployeeFile, createFromTemplate, resubmitTemplateDoc, approve, reject, slaScan, withTimer, startWorkflow, SLA, WARN };
