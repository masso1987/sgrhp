const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine, stamp } = require("../store");
const { audit } = require("../audit");
const CNI = "V";

router.get("/", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(mine(db.portfolios, req).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" }))));
router.get("/doc-types", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(db.docTypes));

const _norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
router.post("/", allow("ADM"), (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nom du portefeuille requis." });
  // Anti-doublon : un portefeuille de même nom (à la casse/espaces près) ne peut être recréé.
  if (mine(db.portfolios, req).some(p => _norm(p.name) === _norm(name)))
    return res.status(409).json({ error: `Un portefeuille nommé « ${name} » existe déjà.` });
  // CNI is mandatory in every new portfolio (§2.3.3)
  const required = [...new Set([CNI, ...(req.body.required || [])])];
  const requiredCreation = [...new Set([CNI, ...((req.body.requiredCreation || []).filter(c => required.includes(c)))])];
  const pf = stamp({ id: id("pf"), name, required, requiredCreation }, req);
  db.portfolios.push(pf); save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { created: pf.name, required });
  res.status(201).json(pf);
});

// Renommer un portefeuille (anti-doublon)
router.put("/:id", allow("ADM"), (req, res) => {
  const pf = mine(db.portfolios, req).find(p => p.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Portefeuille introuvable" });
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nom du portefeuille requis." });
  if (mine(db.portfolios, req).some(p => p.id !== pf.id && _norm(p.name) === _norm(name)))
    return res.status(409).json({ error: `Un portefeuille nommé « ${name} » existe déjà.` });
  const before = pf.name; pf.name = name; save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { renamedFrom: before, renamedTo: name });
  res.json(pf);
});

// Supprimer un portefeuille - bloqué s'il est encore rattaché à des salariés ou à des utilisateurs GPF.
router.delete("/:id", allow("ADM"), (req, res) => {
  const pf = mine(db.portfolios, req).find(p => p.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Portefeuille introuvable" });
  const empCount = mine(db.employees, req).filter(e => e.portfolioId === pf.id).length;
  if (empCount) return res.status(409).json({ error: `Suppression impossible : ${empCount} salarié(s) rattaché(s) à « ${pf.name} ». Réaffectez-les d'abord.` });
  const usrCount = mine(db.users, req).filter(u => (u.portfolioIds || []).includes(pf.id)).length;
  if (usrCount) return res.status(409).json({ error: `Suppression impossible : ${usrCount} utilisateur(s) GPF rattaché(s) à « ${pf.name} ». Détachez-les d'abord (écran Utilisateurs).` });
  db.portfolios = db.portfolios.filter(p => p.id !== pf.id); save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { deleted: pf.name });
  res.json({ ok: true });
});

// Update required documents - CNI cannot be removed; change traced (§2.3.3)
router.put("/:id/requirements", allow("ADM"), (req, res) => {
  const pf = mine(db.portfolios, req).find(p => p.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Not found" });
  const docTypes = req.body.required || [];
  if (!docTypes.includes(CNI))
    return res.status(400).json({ error: "CNI is mandatory for all portfolios and cannot be removed (§2.3.3)" });
  const invalid = docTypes.filter(c => !db.docTypes.find(d => d.code === c));
  if (invalid.length) return res.status(400).json({ error: `Unknown doc types: ${invalid}` });
  const before = pf.required;
  pf.required = [...new Set(docTypes)];
  // Sous-ensemble requis à la création (CNI toujours inclus) ; le reste est exigé pour le dossier mais peut être fourni après création (suivi SMQ).
  const rc = Array.isArray(req.body.requiredCreation) ? req.body.requiredCreation : (pf.requiredCreation || [CNI]);
  pf.requiredCreation = [...new Set([CNI, ...rc.filter(c => pf.required.includes(c))])];
  save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { name: pf.name, before, after: pf.required, requiredCreation: pf.requiredCreation });
  res.json(pf);
});

// ADM attaches a convention collective to a portfolio
router.put("/:id/convention", allow("ADM"), (req, res) => {
  const pf = mine(db.portfolios, req).find(x => x.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Not found" });
  const cnv = mine(db.conventions, req).find(c => c.id === req.body?.conventionId);
  if (!cnv) return res.status(400).json({ error: "Unknown convention" });
  const before = pf.conventionId;
  pf.conventionId = cnv.id; save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { conventionBefore: before, conventionAfter: cnv.id, name: cnv.name });
  res.json(pf);
});

// Allocate the salary elements (rubriques) used for employees of this portfolio.
router.put("/:id/epi", allow("ADM"), (req, res) => {
  const pf = mine(db.portfolios, req).find(p => p.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Portefeuille introuvable" });
  pf.epiEnabled = !!(req.body && req.body.epiEnabled);
  save(); audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { epiEnabled: pf.epiEnabled });
  res.json({ id: pf.id, epiEnabled: pf.epiEnabled });
});
router.put("/:id/salary-elements", allow("ADM"), (req, res) => {
  const pf = mine(db.portfolios, req).find(p => p.id === req.params.id);
  if (!pf) return res.status(404).json({ error: "Portefeuille introuvable" });
  const valid = mine(db.salaryElements, req).map(e => e.name);
  pf.salaryElements = [...new Set((req.body.elements || []).filter(n => valid.includes(n)))];
  save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", pf.id, { salaryElements: pf.salaryElements });
  res.json({ id: pf.id, salaryElements: pf.salaryElements });
});

module.exports = router;
