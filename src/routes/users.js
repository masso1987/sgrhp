const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine, stamp } = require("../store");
const { audit } = require("../audit");
const { hash, passwordPolicy } = require("../auth");

router.get("/", allow("ADM"), (req, res) =>
  res.json(mine(db.users, req).map(({ password, ...u }) => u)));

router.post("/", allow("ADM"), (req, res) => {
  const { email, fullName, role, portfolioIds = [], password } = req.body;
  if (!email || !fullName || !["GPF","CD","RJ","UI","ADM"].includes(role) || !password)
    return res.status(400).json({ error: "email, fullName, valid role and password required" });
  if (db.users.find(u => u.email === email)) return res.status(409).json({ error: "Email exists" });
  const pwErr = passwordPolicy(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const u = stamp({ id: id("usr"), email, fullName, role, portfolioIds, password: hash(password), active: true }, req);
  db.users.push(u); save();
  audit(req.user, "CREATED", "User", u.id, { email, role });
  const { password: _, ...safe } = u;
  res.status(201).json(safe);
});
// ADM links portfolios to a GPF user (one GPF can hold several portfolios)
router.put("/:id/portfolios", allow("ADM"), (req, res) => {
  const user = db.users.find(x => x.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  if (user.role !== "GPF") return res.status(400).json({ error: "Portfolio assignment applies to GPF users only" });
  const ids = req.body?.portfolioIds || [];
  const invalid = ids.filter(i => !db.portfolios.find(p => p.id === i));
  if (invalid.length) return res.status(400).json({ error: "Unknown portfolios: " + invalid.join(",") });
  const before = user.portfolioIds;
  user.portfolioIds = [...new Set(ids)]; save();
  audit(req.user, "CONFIG_CHANGED", "User", user.id, { portfoliosBefore: before, portfoliosAfter: user.portfolioIds });
  res.json({ id: user.id, portfolioIds: user.portfolioIds });
});

// ADM grants access to optional modules (only those activated for the tenant).
router.put("/:id/modules", allow("ADM"), (req, res) => {
  const user = mine(db.users, req).find(x => x.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  const t = (db.tenants || []).find(x => x.id === (req.user.tenantId || "t1"));
  const activated = (t && t.modules) || [];
  const grantable = ["payroll", "accounting", "invoicing", "stock"]; // non-core, licence-gated
  const ids = (req.body && req.body.modules || []).filter(k => grantable.includes(k) && activated.includes(k));
  const before = user.modules || [];
  user.modules = [...new Set(ids)]; save();
  audit(req.user, "CONFIG_CHANGED", "User", user.id, { modulesBefore: before, modulesAfter: user.modules });
  res.json({ id: user.id, modules: user.modules });
});

module.exports = router;
