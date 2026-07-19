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

/** M3: create a document from an uploaded template. Missing tags must be provided (form). */
function createFromTemplate(templateId, employeeId, provided, user) {
  const emp = db.employees.find(e => e.id === employeeId);
  if (!emp) { const e = new Error("Employee not found"); e.status = 404; throw e; }
  const { resolved, missing, template } = engine.resolve(templateId, employeeId, provided);
  if (missing.length) {
    const e = new Error("Missing information: " + missing.join(", "));
    e.status = 422; e.missing = missing; throw e;
  }
  const doc = { id: id("doc"), type: "TEMPLATE_DOC", refId: employeeId,
    templateId, data: resolved,
    title: `${template.name} — ${emp.firstName} ${emp.lastName}`,
    createdById: user.id, createdAt: new Date().toISOString(),
    status: "SUBMITTED", cycle: 1, steps: [], generatedFile: null,
    submittedAt: new Date().toISOString() };
  doc.steps.push({ id: id("stp"), stage: "CD", assignedAt: doc.submittedAt,
    warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
  db.documents.push(doc); save();
  audit(user, "CREATED", "Document", doc.id, { template: template.name });
  audit(user, "SUBMITTED", "Document", doc.id, { cycle: 1 });
  notify.event("submitted", { role: "CD" }, { title: doc.title, initiator: initiatorName(doc.createdById), sla: SLA, ref: doc.id });
  return doc;
}

/** Resubmit a rejected template document with corrected data. */
function resubmitTemplateDoc(documentId, provided, user) {
  const doc = db.documents.find(d => d.id === documentId);
  if (!doc || doc.type !== "TEMPLATE_DOC") { const e = new Error("Not found"); e.status = 404; throw e; }
  if (doc.status !== "DRAFT") { const e = new Error(`Cannot resubmit (status ${doc.status})`); e.status = 409; throw e; }
  const { resolved, missing } = engine.resolve(doc.templateId, doc.refId, { ...doc.data, ...provided });
  if (missing.length) { const e = new Error("Missing information: " + missing.join(", ")); e.status = 422; throw e; }
  doc.data = resolved; doc.status = "SUBMITTED"; doc.cycle += 1;
  doc.submittedAt = new Date().toISOString();
  doc.steps.push({ id: id("stp"), stage: "CD", assignedAt: doc.submittedAt,
    warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
  save();
  audit(user, "SUBMITTED", "Document", doc.id, { cycle: doc.cycle });
  notify.event("submitted", { role: "CD" }, { title: doc.title, initiator: initiatorName(doc.createdById), sla: SLA, ref: doc.id });
  return doc;
}

/** GPF submits an employee file. Gate: all required portfolio docs uploaded (§2.3). */
function submitEmployeeFile(employeeId, user) {
  const emp = db.employees.find(e => e.id === employeeId);
  if (!emp) { const e = new Error("Employee not found"); e.status = 404; throw e; }
  const pf = db.portfolios.find(p => p.id === emp.portfolioId);
  const uploaded = new Set(db.files.filter(f => f.employeeId === employeeId).map(f => f.docType));
  const missing = (pf?.required || []).filter(c => !uploaded.has(c));
  if (missing.length) {
    const e = new Error(`Cannot submit: required documents missing (${missing.join(", ")}) — §2.3`);
    e.status = 400; throw e;
  }
  let doc = db.documents.find(d => d.type === "EMPLOYEE_FILE" && d.refId === employeeId);
  if (doc && !["DRAFT"].includes(doc.status)) {
    const e = new Error(`Already in workflow (status ${doc.status})`); e.status = 409; throw e;
  }
  if (!doc) {
    doc = { id: id("doc"), type: "EMPLOYEE_FILE", refId: employeeId,
      title: `Employee file — ${emp.firstName} ${emp.lastName}`,
      createdById: user.id, createdAt: new Date().toISOString(),
      status: "DRAFT", cycle: 0, steps: [], generatedFile: null };
    db.documents.push(doc);
  }
  doc.status = "SUBMITTED"; doc.cycle += 1;
  doc.submittedAt = new Date().toISOString();
  doc.steps.push({ id: id("stp"), stage: "CD", assignedAt: doc.submittedAt,
    warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
  emp.status = "SUBMITTED";
  save();
  audit(user, "SUBMITTED", "Document", doc.id, { cycle: doc.cycle, title: doc.title });
  notify.event("submitted", { role: "CD" }, { title: doc.title, initiator: initiatorName(doc.createdById), sla: SLA, ref: doc.id });
  return doc;
}

function approve(documentId, user) {
  const doc = docOf(documentId);
  const step = openStep(doc);
  assertStage(doc, step, user);
  step.decidedAt = new Date().toISOString();
  step.decision = "APPROVED"; step.validatorId = user.id;
  step.elapsedH = elapsedBusinessHours(step.assignedAt);

  if (user.role === "CD") {
    doc.status = "CD_APPROVED";
    doc.steps.push({ id: id("stp"), stage: "RJ", assignedAt: new Date().toISOString(),
      warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
    notify.event("submitted", { role: "RJ" }, { title: doc.title, initiator: initiatorName(doc.createdById), stage: "RJ", sla: SLA, ref: doc.id });
  } else {
    doc.status = "GENERATED";
    doc.generatedAt = new Date().toISOString();
    doc.generatedFile = generateOfficial(doc);   // M3 replaces with template engine
    setEmpStatus(doc, "VALIDATED");
    notify.event("validated", { userId: doc.createdById }, { title: doc.title, ref: doc.id });
    notify.toRole("UI", "New document available for printing", doc.title, doc.id);
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
  doc.status = "DRAFT"; // returns to GPF for correction + full resubmission cycle (§5.3)
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

/** Official document generation (§7.1): Word template rendering for template docs. */
function generateOfficial(doc) {
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

module.exports = { submitEmployeeFile, createFromTemplate, resubmitTemplateDoc, approve, reject, slaScan, withTimer, SLA, WARN };
