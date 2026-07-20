const router = require("express").Router();
const path = require("path");
const { db, save } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");
const wf = require("../workflow");

// Validation queue for the caller's stage (CD or RJ), with live timers
router.get("/queue", allow("CD", "RJ"), (req, res) => {
  wf.slaScan();
  const list = mine(db.documents, req)
    .map(wf.withTimer)
    .filter(d => d.currentStage === req.user.role)
    .sort((a, b) => b.elapsedH - a.elapsedH);
  res.json(list);
});

// All documents (dashboard/history)
router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  wf.slaScan();
  let list = mine(db.documents, req).map(wf.withTimer);
  if (req.user.role === "GPF") list = list.filter(d => d.createdById === req.user.id);
  res.json(list.reverse());
});

router.get("/generated", allow("UI", "ADM", "CD", "RJ"), (req, res) => {
  res.json(mine(db.documents, req).filter(d => d.status === "GENERATED").map(d => ({
    id: d.id, title: d.title, generatedAt: d.generatedAt, type: d.type })));
});

router.get("/:id", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => {
  const d = mine(db.documents, req).find(x => x.id === req.params.id);
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

// Print/download a generated document — logged: who, when, which (§5.2 step 4)
router.get("/:id/download", allow("UI", "CD", "RJ", "ADM"), (req, res) => {
  const d = mine(db.documents, req).find(x => x.id === req.params.id);
  if (!d || d.status !== "GENERATED") return res.status(404).json({ error: "Not generated" });
  audit(req.user, req.query.print === "1" ? "PRINTED" : "DOWNLOADED", "Document", d.id, { title: d.title });
  res.download(path.join(__dirname, "..", "..", "uploads", "generated", d.generatedFile),
    d.title.replace(/[^\w \-]/g, "") + (d.generatedFile.endsWith(".docx") ? ".docx" : ".html"));
});

module.exports = router;
