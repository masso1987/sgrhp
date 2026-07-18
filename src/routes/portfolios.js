const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const CNI = "V";

router.get("/", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(db.portfolios));
router.get("/doc-types", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(db.docTypes));

router.post("/", allow("ADM"), (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: "Name required" });
  // CNI is mandatory in every new portfolio (§2.3.3)
  const required = [...new Set([CNI, ...(req.body.required || [])])];
  const pf = { id: id("pf"), name: req.body.name, required };
  db.portfolios.push(pf); save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { created: pf.name, required });
  res.status(201).json(pf);
});

// Update required documents — CNI cannot be removed; change traced (§2.3.3)
router.put("/:id/requirements", allow("ADM"), (req, res) => {
  const pf = db.portfolios.find(p => p.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Not found" });
  const docTypes = req.body.required || [];
  if (!docTypes.includes(CNI))
    return res.status(400).json({ error: "CNI is mandatory for all portfolios and cannot be removed (§2.3.3)" });
  const invalid = docTypes.filter(c => !db.docTypes.find(d => d.code === c));
  if (invalid.length) return res.status(400).json({ error: `Unknown doc types: ${invalid}` });
  const before = pf.required;
  pf.required = [...new Set(docTypes)]; save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { name: pf.name, before, after: pf.required });
  res.json(pf);
});

// ADM attaches a convention collective to a portfolio
router.put("/:id/convention", allow("ADM"), (req, res) => {
  const pf = db.portfolios.find(x => x.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Not found" });
  const cnv = db.conventions.find(c => c.id === req.body?.conventionId);
  if (!cnv) return res.status(400).json({ error: "Unknown convention" });
  const before = pf.conventionId;
  pf.conventionId = cnv.id; save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { conventionBefore: before, conventionAfter: cnv.id, name: cnv.name });
  res.json(pf);
});

module.exports = router;
