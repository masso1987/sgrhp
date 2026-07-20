/**
 * M4 — Contract amendments (avenants, versioned), decisions & sanctions,
 * leave/permissions/final settlements with balance tracking (§3.2, §3.5).
 * Amendments and leave requests follow the standard 2-level workflow;
 * on RJ approval the amendment is applied / the leave is deducted.
 */
const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine, stamp } = require("../store");
const { audit } = require("../audit");
const notify = require("../notify");
const path = require("path");
const multer = require("multer");
const DEC_DIR = path.join(__dirname, "..", "..", "uploads", "decisions");
require("fs").mkdirSync(DEC_DIR, { recursive: true });
const decUpload = multer({ storage: multer.diskStorage({ destination: DEC_DIR,
  filename: (q, f, cb) => cb(null, `${Date.now()}-${f.originalname.replace(/[^\w.\-]/g, "_")}`) }),
  limits: { fileSize: 10 * 1024 * 1024 } });

const empOf = (req) => {
  let list = mine(db.employees, req);
  if (req.user.role === "GPF") {
    const u = db.users.find(x => x.id === req.user.id);
    list = list.filter(e => (u?.portfolioIds || []).includes(e.portfolioId));
  }
  return list.find(e => e.id === req.params.id);
};

/* ---------- Amendments (avenants) ---------- */
router.post("/:id/amendments", allow("GPF", "ADM"), (req, res) => {
  const emp = empOf(req);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const { changes, effectiveDate, reason } = req.body || {};
  if (!changes || typeof changes !== "object" || !Object.keys(changes).length)
    return res.status(400).json({ error: "changes object required (e.g. {category:'B3'})" });
  const avRef = mine(db.referentials, req).find(r => r.key === "avenantTypes");
  const avenantType = req.body.avenantType;
  if (!avenantType || !avRef.values.includes(avenantType))
    return res.status(400).json({ error: `avenantType must be one of: ${avRef.values.join(", ")} (managed by admin)` });
  const allowed = ["category", "step", "paymentMethod", "bankIban", "endDate", "type", "salary"];
  const bad = Object.keys(changes).filter(k => !allowed.includes(k));
  if (bad.length) return res.status(400).json({ error: `Fields not amendable: ${bad.join(",")}` });
  if (changes.type === "CDD" && !changes.endDate && !emp.contract?.endDate)
    return res.status(400).json({ error: "Switching to CDD requires an end date" });
  if (changes.type === "CDI") changes.endDate = null;
  if (changes.salary) {
    const names = mine(db.salaryElements, req).map(e => e.name);
    const bad = Object.keys(changes.salary).filter(k => !names.includes(k));
    if (bad.length) return res.status(400).json({ error: `Unknown salary elements: ${bad.join(", ")}` });
  }

  const version = (db.documents.filter(d => d.type === "AMENDMENT" && d.refId === emp.id).length) + 1;
  const doc = { id: id("doc"), tenantId: req.user.tenantId || "t1", type: "AMENDMENT", refId: emp.id,
    data: { changes, avenantType, effectiveDate: effectiveDate || null, reason: reason || "" }, version,
    title: `${avenantType} n°${version} — ${emp.firstName} ${emp.lastName}`,
    createdById: req.user.id, createdAt: new Date().toISOString(),
    status: "SUBMITTED", cycle: 1, steps: [], generatedFile: null,
    submittedAt: new Date().toISOString() };
  doc.steps.push({ id: id("stp"), stage: "CD", assignedAt: doc.submittedAt,
    warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
  db.documents.push(doc); save();
  audit(req.user, "CREATED", "Amendment", doc.id, { version, changes });
  notify.event("submitted", { role: "CD" }, { title: doc.title, initiator: req.user.fullName || "un gestionnaire", sla: 48, ref: doc.id });
  res.status(201).json(doc);
});

router.get("/:id/amendments", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const emp = empOf(req);
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json(db.documents.filter(d => d.type === "AMENDMENT" && d.refId === emp.id));
});

/* ---------- Decisions & sanctions ---------- */
const CAREER_DECISIONS = /Promotion|Mutation|Avancement/i;

router.post("/:id/decisions", allow("GPF", "ADM"), decUpload.single("file"), (req, res) => {
  const emp = empOf(req);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const { type, detail, date } = req.body || {};
  const ref = mine(db.referentials, req).find(r => r.key === "decisionTypes");
  if (!type || !ref.values.includes(type))
    return res.status(400).json({ error: `type must be one of: ${ref.values.join(", ")}` });

  const dec = { id: id("dec"), tenantId: req.user.tenantId || "t1", employeeId: emp.id, type, detail: detail || "",
    date: date || new Date().toISOString().slice(0, 10),
    fileName: req.file?.originalname || null, storedAs: req.file?.filename || null,
    createdBy: req.user.id, createdAt: new Date().toISOString(), amendmentId: null };

  // Promotion / mutation with salary or category changes -> automatic avenant (workflow)
  let salaryChanges = null, categoryChange = null;
  try { if (req.body.salaryChanges) salaryChanges = JSON.parse(req.body.salaryChanges); } catch { 
    return res.status(400).json({ error: "salaryChanges must be valid JSON" }); }
  if (req.body.newCategory) categoryChange = req.body.newCategory;

  if ((salaryChanges || categoryChange) && !CAREER_DECISIONS.test(type))
    return res.status(400).json({ error: "Salary/category changes only apply to promotions, mutations or avancements" });

  if (salaryChanges || categoryChange) {
    const names = mine(db.salaryElements, req).map(e => e.name);
    const bad = salaryChanges ? Object.keys(salaryChanges).filter(k => !names.includes(k)) : [];
    if (bad.length) return res.status(400).json({ error: `Unknown salary elements: ${bad.join(", ")}` });
    const changes = {};
    if (categoryChange) changes.category = categoryChange;
    if (salaryChanges) changes.salary = salaryChanges;
    const version = (db.documents.filter(d => d.type === "AMENDMENT" && d.refId === emp.id).length) + 1;
    const doc = { id: id("doc"), tenantId: req.user.tenantId || "t1", type: "AMENDMENT", refId: emp.id,
      data: { changes, avenantType: "Avenant salarial", effectiveDate: dec.date, reason: `${type} — ${detail || ""}` },
      version, title: `Avenant salarial n°${version} (${type}) — ${emp.firstName} ${emp.lastName}`,
      createdById: req.user.id, createdAt: new Date().toISOString(),
      status: "SUBMITTED", cycle: 1, steps: [], generatedFile: null, submittedAt: new Date().toISOString() };
    doc.steps.push({ id: id("stp"), stage: "CD", assignedAt: doc.submittedAt,
      warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
    db.documents.push(doc);
    dec.amendmentId = doc.id;
    notify.event("submitted", { role: "CD" }, { title: doc.title, initiator: req.user.fullName || "un gestionnaire", sla: 48, ref: doc.id });
    audit(req.user, "CREATED", "Amendment", doc.id, { auto: true, fromDecision: type, changes });
  }

  db.decisions.push(dec); save();
  audit(req.user, "CREATED", "Decision", dec.id, { employee: `${emp.firstName} ${emp.lastName}`, type, hasFile: !!req.file, autoAvenant: !!dec.amendmentId });
  res.status(201).json(dec);
});

router.get("/:id/decisions/:decId/file", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const d = db.decisions.find(x => x.id === req.params.decId && x.employeeId === req.params.id);
  if (!d || !d.storedAs) return res.status(404).json({ error: "No attachment" });
  audit(req.user, "DOWNLOADED", "Decision", d.id, {});
  res.download(path.join(DEC_DIR, d.storedAs), d.fileName);
});

router.get("/:id/decisions", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const emp = empOf(req);
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json(db.decisions.filter(d => d.employeeId === emp.id));
});

/* ---------- Leave / permissions / final settlement ---------- */
const ACCRUAL_PER_MONTH = 1.5; // configurable in M7

function leaveBalance(emp) {
  const months = Math.max(0, Math.floor((Date.now() - new Date(emp.hireDate)) / (30.44 * 86400e3)));
  const accrued = months * ACCRUAL_PER_MONTH;
  const taken = db.documents
    .filter(d => d.type === "LEAVE" && d.refId === emp.id && d.status === "GENERATED" && d.data.leaveType === "Congé annuel")
    .reduce((s, d) => s + d.data.days, 0);
  return { accrued: Math.round(accrued * 10) / 10, taken, remaining: Math.round((accrued - taken) * 10) / 10 };
}

router.get("/:id/leave", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const emp = empOf(req);
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json({ balance: leaveBalance(emp),
    requests: db.documents.filter(d => d.type === "LEAVE" && d.refId === emp.id) });
});

router.post("/:id/leave", allow("GPF", "ADM"), (req, res) => {
  const emp = empOf(req);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const { leaveType, startDate, endDate, reason } = req.body || {};
  const ref = mine(db.referentials, req).find(r => r.key === "leaveTypes");
  if (!leaveType || !ref.values.includes(leaveType))
    return res.status(400).json({ error: `leaveType must be one of: ${ref.values.join(", ")}` });
  let days = 0;
  if (leaveType !== "Solde de tout compte") {
    if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
    days = Math.round((new Date(endDate) - new Date(startDate)) / 86400e3) + 1;
    if (days <= 0) return res.status(400).json({ error: "endDate must be after startDate" });
    if (leaveType === "Congé annuel" && days > leaveBalance(emp).remaining)
      return res.status(400).json({ error: `Insufficient balance: ${leaveBalance(emp).remaining} days remaining, ${days} requested` });
  }
  const doc = { id: id("doc"), tenantId: req.user.tenantId || "t1", type: "LEAVE", refId: emp.id,
    data: { leaveType, startDate, endDate, days, reason: reason || "" },
    title: `${leaveType} (${days ? days + "j" : "—"}) — ${emp.firstName} ${emp.lastName}`,
    createdById: req.user.id, createdAt: new Date().toISOString(),
    status: "SUBMITTED", cycle: 1, steps: [], generatedFile: null,
    submittedAt: new Date().toISOString() };
  doc.steps.push({ id: id("stp"), stage: "CD", assignedAt: doc.submittedAt,
    warnedAt: null, breachedAt: null, decidedAt: null, decision: null, validatorId: null, rejectReason: null });
  db.documents.push(doc); save();
  audit(req.user, "CREATED", "Leave", doc.id, { leaveType, days });
  notify.event("submitted", { role: "CD" }, { title: doc.title, initiator: req.user.fullName || "un gestionnaire", sla: 48, ref: doc.id });
  res.status(201).json(doc);
});

module.exports = { router, leaveBalance };
