const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine, stamp } = require("../store");
const { audit } = require("../audit");
const { hash, passwordPolicy } = require("../auth");

// A tenant admin never sees the platform super-administrator.
router.get("/", allow("ADM"), (req, res) =>
  res.json(mine(db.users, req).filter(u => u.role !== "SADM").map(({ password, ...u }) => u)));

// Resolve a manageable target: SADM manages any tenant account; ADM only its own
// tenant. A super-administrator account is never manageable through this API.
function targetUser(req, id) {
  const u = db.users.find(x => x.id === id);
  if (!u || u.role === "SADM") return null;
  if (req.user.role === "SADM") return u;
  if ((u.tenantId || "t1") === (req.user.tenantId || "t1")) return u;
  return null;
}
const _tenantUsers = (u) => db.users.filter(x => (x.tenantId || "t1") === (u.tenantId || "t1"));
const _tenantModules = (u) => { const t = (db.tenants || []).find(x => x.id === (u.tenantId || "t1")); return (t && t.modules) || []; };

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
router.put("/:id/portfolios", allow("ADM", "SADM"), (req, res) => {
  const user = targetUser(req, req.params.id);
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
router.put("/:id/modules", allow("ADM", "SADM"), (req, res) => {
  const user = targetUser(req, req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
  const activated = _tenantModules(user);
  const grantable = ["payroll", "accounting", "invoicing", "stock"]; // non-core, licence-gated
  const ids = (req.body && req.body.modules || []).filter(k => grantable.includes(k) && activated.includes(k));
  const before = user.modules || [];
  user.modules = [...new Set(ids)]; save();
  audit(req.user, "CONFIG_CHANGED", "User", user.id, { modulesBefore: before, modulesAfter: user.modules });
  res.json({ id: user.id, modules: user.modules });
});

// ADM enables / disables a user account (blocks login when disabled).
router.put("/:id/active", allow("ADM", "SADM"), (req, res) => {
  const u = targetUser(req, req.params.id);
  if (!u) return res.status(404).json({ error: "Utilisateur introuvable" });
  if (u.id === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas désactiver votre propre compte" });
  const active = !!(req.body && req.body.active);
  if (!active && u.role === "ADM" &&
      !_tenantUsers(u).some(x => x.role === "ADM" && x.active && x.id !== u.id))
    return res.status(400).json({ error: "Impossible : c'est le dernier administrateur actif du tenant" });
  u.active = active; save();
  audit(req.user, active ? "ENABLED" : "DISABLED", "User", u.id, { email: u.email });
  res.json({ id: u.id, active: u.active });
});

// ADM changes a user's role.
router.put("/:id/role", allow("ADM", "SADM"), (req, res) => {
  const u = targetUser(req, req.params.id);
  if (!u) return res.status(404).json({ error: "Utilisateur introuvable" });
  const role = req.body && req.body.role;
  if (!["GPF", "CD", "RJ", "UI", "ADM"].includes(role)) return res.status(400).json({ error: "Rôle invalide" });
  if (u.role === "ADM" && role !== "ADM" &&
      !_tenantUsers(u).some(x => x.role === "ADM" && x.active && x.id !== u.id))
    return res.status(400).json({ error: "Impossible : c'est le dernier administrateur du tenant" });
  const before = u.role; u.role = role;
  if (role !== "GPF") u.portfolioIds = [];
  save();
  audit(req.user, "ROLE_CHANGED", "User", u.id, { email: u.email, before, after: role });
  res.json({ id: u.id, role: u.role });
});

// ADM grants employee edit/delete capabilities to a user.
const EMP_CAPS = ["employee.edit", "employee.delete", "payroll.edit", "payroll.run", "payroll.livre", "payroll.cotisations"];
router.put("/:id/permissions", allow("ADM", "SADM"), (req, res) => {
  const u = targetUser(req, req.params.id);
  if (!u) return res.status(404).json({ error: "Utilisateur introuvable" });
  u.permissions = [...new Set((req.body.permissions || []).filter(p => EMP_CAPS.includes(p)))];
  save();
  audit(req.user, "CONFIG_CHANGED", "User", u.id, { permissions: u.permissions });
  res.json({ id: u.id, permissions: u.permissions });
});

module.exports = router;
