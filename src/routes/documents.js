const router = require("express").Router();
const path = require("path");
const { db, save } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const wf = require("../workflow");

// Validation queue for the caller's stage (CD or RJ), with live timers
router.get("/queue", allow("CD", "RJ"), (req, res) => {
  wf.slaScan();
  const list = db.documents
    .map(wf.withTimer)
    .filter(d => d.currentStage === req.user.role)
    .sort((a, b) => b.elapsedH - a.elapsedH);
  res.json(list);
});

// All documents (dashboard/history)
router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  wf.slaScan();
  let list = db.documents.map(wf.withTimer);
  if (req.user.role === "GPF") list = list.filter(d => d.createdById === req.user.id);
  res.json(list.reverse());
});

// Generated documents — visible to EVERY role once the workflow is complete (§5.2).
// Each entry is linked to its employee so any account can find it by person.
router.get("/generated", allow("GPF", "CD", "RJ", "UI", "ADM"), (req, res) => {
  const list = db.documents
    .filter(d => d.status === "GENERATED")
    .map(d => {
      const emp = db.employees.find(e => e.id === d.refId);
      return {
        id: d.id,
        title: d.title,
        generatedAt: d.generatedAt,
        type: d.type,
        employeeId: d.refId,
        employeeName: emp ? `${emp.firstName} ${emp.lastName}` : null,
        portfolioId: emp ? emp.portfolioId : null,
      };
    })
    .sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));
  res.json(list);
});

router.get("/:id", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => {
  const d = db.documents.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  res.json(wf.withTimer(d));
});

// M3: GPF creates+submits a document from a template (auto-fill + provided values)
router.post("/from-template", allow("GPF", "ADM"), (req, res, next) => {
  try {
    const { templateId, employeeId, values } = req.body || {};
    res.status(201).json(wf.createFromTemplate(templateId, employeeId, values || {}, req.user));
  } catch (e) {
    if (e.missing) return res.status(422).json({ error: e.message, missing: e.missing });
    next(e);
  }
});
router.post("/:id/resubmit", allow("GPF", "ADM"), (req, res, next) => {
  try { res.json(wf.resubmitTemplateDoc(req.params.id, req.body?.values || {}, req.user)); }
  catch (e) { next(e); }
});

router.post("/:id/approve", allow("CD", "RJ"), (req, res, next) => {
  try { res.json(wf.approve(req.params.id, req.user)); } catch (e) { next(e); }
});

router.post("/:id/reject", allow("CD", "RJ"), (req, res, next) => {
  try { res.json(wf.reject(req.params.id, req.user, req.body?.reason)); } catch (e) { next(e); }
});

// Print/download a generated document — every role may consult it once generated.
// Still fully logged: who, when, which, print vs download (§5.2 step 4).
router.get("/:id/download", allow("GPF", "CD", "RJ", "UI", "ADM"), (req, res) => {
  const d = db.documents.find(x => x.id === req.params.id);
  if (!d || d.status !== "GENERATED") return res.status(404).json({ error: "Not generated" });
  const emp = db.employees.find(e => e.id === d.refId);
  audit(req.user, req.query.print === "1" ? "PRINTED" : "DOWNLOADED", "Document", d.id, {
    title: d.title, employeeId: d.refId,
    employeeName: emp ? `${emp.firstName} ${emp.lastName}` : null });
  res.download(path.join(__dirname, "..", "..", "uploads", "generated", d.generatedFile),
    d.title.replace(/[^\w \-]/g, "") + (d.generatedFile.endsWith(".docx") ? ".docx" : ".html"));
});

module.exports = router;
