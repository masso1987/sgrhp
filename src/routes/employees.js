const router = require("express").Router();
const path = require("path");
const multer = require("multer");
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine, stamp } = require("../store");
const { audit } = require("../audit");

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "..", "uploads"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// GPF scope: only employees of their portfolios
const scoped = (req) => {
  let list = mine(db.employees, req);
  if (req.user.role === "GPF") {
    const u = db.users.find(x => x.id === req.user.id);
    list = list.filter(e => (u?.portfolioIds || []).includes(e.portfolioId));
  }
  return list;
};

router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  res.json(scoped(req).map(e => ({ ...e, checklist: checklist(e) })));
});

router.get("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const emp = scoped(req).find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json({ ...emp, checklist: checklist(emp), files: db.files.filter(f => f.employeeId === emp.id) });
});

router.post("/", allow("GPF", "ADM"), (req, res) => {
  const b = req.body;
  for (const f of ["firstName", "lastName", "portfolioId", "hireDate", "birthDate", "cniNumber", "cniExpiry"])
    if (!b[f]) return res.status(400).json({ error: `Missing field: ${f}` });
  if (!db.portfolios.find(p => p.id === b.portfolioId))
    return res.status(400).json({ error: "Unknown portfolio" });
  // GPF may only create employees inside portfolios linked to them
  if (req.user.role === "GPF") {
    const u = db.users.find(x => x.id === req.user.id);
    if (!(u?.portfolioIds || []).includes(b.portfolioId))
      return res.status(403).json({ error: "This portfolio is not linked to you. Ask the administrator." });
  }
  // No two employees can share a CNI or CNPS number
  if (db.employees.find(e => e.cniNumber === b.cniNumber))
    return res.status(409).json({ error: `CNI number ${b.cniNumber} already belongs to another employee` });
  if (b.cnpsNumber && db.employees.find(e => e.cnpsNumber && e.cnpsNumber === b.cnpsNumber))
    return res.status(409).json({ error: `CNPS number ${b.cnpsNumber} already belongs to another employee` });
  // Category must exist in the referential when provided
  if (b.contract?.category) {
    const cats = db.referentials.find(x => x.key === "categories")?.values || [];
    if (!cats.includes(b.contract.category))
      return res.status(400).json({ error: `Unknown category. Configured: ${cats.join(", ")}` });
  }
  if (b.contract) {
    const ct = db.contractTypes.find(t => t.name === b.contract.type);
    if (!ct) return res.status(400).json({ error: `Unknown contract type. Configured types: ${db.contractTypes.map(t => t.name).join(", ")}` });
    if (!ct.fixedTerm) b.contract.endDate = null;          // open-ended: end date unknown by definition
    else if (!b.contract.endDate)
      return res.status(400).json({ error: `A ${ct.name} contract requires an end date` });
  }
  if (b.salary) {
    const names = db.salaryElements.map(e => e.name);
    const bad = Object.keys(b.salary).filter(k => !names.includes(k));
    if (bad.length) return res.status(400).json({ error: `Unknown salary elements: ${bad.join(", ")}. Admin must create them first.` });
    for (const [k, v] of Object.entries(b.salary)) {
      if (!(Number(v) >= 0)) return res.status(400).json({ error: `Invalid amount for ${k}` });
      b.salary[k] = Number(v);
    }
  }
  const emp = stamp({ id: id("emp"), status: "DRAFT", createdBy: req.user.id, createdAt: new Date().toISOString(), ...b }, req);
  db.employees.push(emp); save();
  audit(req.user, "CREATED", "Employee", emp.id, { name: `${b.firstName} ${b.lastName}` });
  res.status(201).json({ ...emp, checklist: checklist(emp) });
});

router.put("/:id", allow("GPF", "ADM"), (req, res) => {
  const emp = scoped(req).find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found" });
  const before = { ...emp };
  if (req.body.cniNumber && db.employees.find(e => e.id !== emp.id && e.cniNumber === req.body.cniNumber))
    return res.status(409).json({ error: "CNI number already belongs to another employee" });
  if (req.body.cnpsNumber && db.employees.find(e => e.id !== emp.id && e.cnpsNumber === req.body.cnpsNumber))
    return res.status(409).json({ error: "CNPS number already belongs to another employee" });
  Object.assign(emp, req.body, { id: emp.id }); save();
  audit(req.user, "UPDATED", "Employee", emp.id, { changed: Object.keys(req.body) });
  res.json(emp);
});

// Upload a hiring document for an employee (§2.3) — local storage dev adapter;
// swapped for Azure Blob (Managed Identity + SSE) in M7.
router.post("/:id/files", allow("GPF", "ADM"), upload.single("file"), (req, res) => {
  const emp = scoped(req).find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found" });
  const { docType, expiryDate } = req.body;
  if (!db.docTypes.find(d => d.code === docType))
    return res.status(400).json({ error: "Unknown docType" });
  if (docType === "V" && !expiryDate)
    return res.status(400).json({ error: "CNI requires a validity/expiry date (§2.3)" });
  const f = {
    id: id("file"), employeeId: emp.id, docType,
    fileName: req.file.originalname, storedAs: req.file.filename,
    contentType: req.file.mimetype, size: req.file.size,
    expiryDate: expiryDate || null,
    uploadedBy: req.user.id, uploadedAt: new Date().toISOString(),
  };
  stamp(f, req); db.files.push(f); save();
  audit(req.user, "UPLOADED", "DocFile", f.id, { employeeId: emp.id, docType, fileName: f.fileName });
  res.status(201).json(f);
});

router.get("/:id/files/:fileId/download", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = db.files.find(x => x.id === req.params.fileId && x.employeeId === req.params.id);
  if (!f) return res.status(404).json({ error: "Not found" });
  audit(req.user, "DOWNLOADED", "DocFile", f.id, { fileName: f.fileName });
  res.download(path.join(__dirname, "..", "..", "uploads", f.storedAs), f.fileName);
});

/** Required-document checklist inherited from the portfolio (§2.3.3). */
function checklist(emp) {
  const pf = db.portfolios.find(p => p.id === emp.portfolioId);
  const uploaded = new Set(db.files.filter(f => f.employeeId === emp.id).map(f => f.docType));
  const required = pf ? pf.required : ["V"];
  return required.map(code => {
    const dt = db.docTypes.find(d => d.code === code);
    return { code, label: dt?.label, formats: dt?.formats, uploaded: uploaded.has(code), locked: code === "V" };
  });
}

// Delete an employee (ADM). Blocked if referenced by generated documents or payroll,
// to protect payroll/audit integrity.
router.delete("/:id", allow("ADM"), (req, res) => {
  const emp = scoped(req).find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found" });
  const inPayroll = (db.payslips || []).some(s => s.employeeId === emp.id);
  const inDocs = (db.documents || []).some(d => d.refId === emp.id && d.status === "GENERATED");
  if ((inPayroll || inDocs) && req.query.force !== "1")
    return res.status(409).json({ error: "Cet employé a des bulletins de paie ou documents générés",
      requiresConfirmation: true,
      warning: `${emp.firstName} ${emp.lastName} possède des documents ou bulletins générés. ` +
        `La suppression retirera son dossier (les pièces déjà générées restent archivées). Confirmez pour supprimer.` });
  db.employees = db.employees.filter(e => e.id !== emp.id);
  db.files = (db.files || []).filter(f => f.employeeId !== emp.id);
  save();
  audit(req.user, "DELETED", "Employee", emp.id, { name: `${emp.firstName} ${emp.lastName}` });
  res.json({ ok: true });
});

module.exports = router;

// --- M2: submit employee file for validation (§5 step 1) ---
const wf = require("../workflow");
router.post("/:id/submit", allow("GPF", "ADM"), (req, res, next) => {
  try {
    const emp = scoped(req).find(e => e.id === req.params.id);
    if (!emp) return res.status(404).json({ error: "Not found" });
    res.json(wf.submitEmployeeFile(emp.id, req.user));
  } catch (e) { next(e); }
});
