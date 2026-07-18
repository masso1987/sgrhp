/**
 * §3.2 + §3.4 — Contract types (parameterizable, versioned), salary elements,
 * and the salary grid linking base salary to categories.
 */
const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

/* ---- Contract types: CDI/CDD + custom, with version history ---- */
router.get("/contract-types", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(db.contractTypes));

router.post("/contract-types", allow("ADM"), (req, res) => {
  const { name, fixedTerm } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (db.contractTypes.find(t => t.name === name)) return res.status(409).json({ error: "Type exists" });
  const t = { id: id("ctt"), name, fixedTerm: !!fixedTerm, system: false,
    versions: [{ v: 1, at: new Date().toISOString(), by: req.user.id, changes: "created" }] };
  db.contractTypes.push(t); save();
  audit(req.user, "CONFIG_CHANGED", "ContractType", t.id, { created: name, fixedTerm: !!fixedTerm });
  res.status(201).json(t);
});

router.put("/contract-types/:id", allow("ADM"), (req, res) => {
  const t = db.contractTypes.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  const before = { name: t.name, fixedTerm: t.fixedTerm };
  if (req.body.name) t.name = req.body.name;
  if (req.body.fixedTerm !== undefined) t.fixedTerm = !!req.body.fixedTerm;
  t.versions.push({ v: t.versions.length + 1, at: new Date().toISOString(), by: req.user.id,
    changes: JSON.stringify({ before, after: { name: t.name, fixedTerm: t.fixedTerm } }) });
  save();
  audit(req.user, "CONFIG_CHANGED", "ContractType", t.id, { before, after: { name: t.name, fixedTerm: t.fixedTerm }, version: t.versions.length });
  res.json(t);
});

/* ---- Salary elements (ADM): selected by GPF at employee creation ---- */
router.get("/salary-elements", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(db.salaryElements));

router.post("/salary-elements", allow("ADM"), (req, res) => {
  const { name, tag } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (db.salaryElements.find(e => e.name === name)) return res.status(409).json({ error: "Element exists" });
  const e = { id: id("sel"), name, tag: tag || null };
  db.salaryElements.push(e); save();
  audit(req.user, "CONFIG_CHANGED", "SalaryElement", e.id, { created: name, tag });
  res.status(201).json(e);
});

router.delete("/salary-elements/:id", allow("ADM"), (req, res) => {
  const e = db.salaryElements.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Not found" });
  db.salaryElements = db.salaryElements.filter(x => x.id !== req.params.id); save();
  audit(req.user, "CONFIG_CHANGED", "SalaryElement", e.id, { deleted: e.name });
  res.json({ ok: true });
});

/* ---- Salary grid (barème): category -> base salary; editable GPF/CD/ADM ---- */
router.get("/salary-grid", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(db.salaryGrid));

router.put("/salary-grid", allow("GPF", "CD", "ADM"), (req, res) => {
  const grid = req.body?.grid;
  if (!Array.isArray(grid)) return res.status(400).json({ error: "grid array required [{category, baseSalary}]" });
  const cats = db.referentials.find(r => r.key === "categories")?.values || [];
  const bad = grid.filter(g => !cats.includes(g.category) || !(Number(g.baseSalary) > 0));
  if (bad.length) return res.status(400).json({ error: "Invalid rows (unknown category or salary <= 0): " + bad.map(b => b.category).join(",") });
  const before = db.salaryGrid;
  db.salaryGrid = grid.map(g => ({ category: g.category, baseSalary: Number(g.baseSalary) })); save();
  audit(req.user, "CONFIG_CHANGED", "SalaryGrid", "grid", { before, after: db.salaryGrid });
  res.json(db.salaryGrid);
});

/* ---- Conventions collectives: own salary figures, attachable to portfolios ---- */
router.get("/conventions", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(db.conventions));

router.post("/conventions", allow("ADM"), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (db.conventions.find(c => c.name === name)) return res.status(409).json({ error: "Convention exists" });
  const cats = db.referentials.find(r => r.key === "categories")?.values || [];
  const cnv = { id: id("cnv"), name, grid: cats.map(cat => ({ category: cat, baseSalary: 0 })) };
  db.conventions.push(cnv); save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { created: name });
  res.status(201).json(cnv);
});

router.put("/conventions/:id/grid", allow("GPF", "CD", "ADM"), (req, res) => {
  const cnv = db.conventions.find(c => c.id === req.params.id);
  if (!cnv) return res.status(404).json({ error: "Not found" });
  const grid = req.body?.grid;
  if (!Array.isArray(grid) || !grid.length) return res.status(400).json({ error: "grid array required" });
  const cats = db.referentials.find(r => r.key === "categories")?.values || [];
  const bad = grid.filter(g => !cats.includes(g.category) || !(Number(g.baseSalary) >= 0));
  if (bad.length) return res.status(400).json({ error: "Invalid rows: " + bad.map(b => b.category).join(",") });
  const before = cnv.grid;
  cnv.grid = grid.map(g => ({ category: g.category, baseSalary: Number(g.baseSalary) })); save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { name: cnv.name, before, after: cnv.grid });
  res.json(cnv);
});

module.exports = router;
