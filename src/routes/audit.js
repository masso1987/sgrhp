const router = require("express").Router();
const { db } = require("../store");
const { allow } = require("../rbac");

// Filterable audit log (§4.1): user, action, object, date range
router.get("/", allow("CD", "RJ", "ADM", "SADM"), (req, res) => {
  let logs = [...db.audit].reverse();
  // Tenant isolation: non-platform roles only ever see their own tenant's activity,
  // and never the super-administrator's actions.
  if (req.user.role !== "SADM") {
    const tid = req.user.tenantId || "t1";
    logs = logs.filter(l => (l.tenantId || "t1") === tid && l.role !== "SADM");
  }
  const { userId, action, objectType, from, to } = req.query;
  if (userId) logs = logs.filter(l => l.userId === userId);
  if (action) logs = logs.filter(l => l.action === action);
  if (objectType) logs = logs.filter(l => l.objectType === objectType);
  if (from) logs = logs.filter(l => l.at >= from);
  if (to) logs = logs.filter(l => l.at <= to);
  res.json(logs.slice(0, 200));
});
// Historique des connexions (ADM: son organisation - SADM: tout, avec IP/localisation)
router.get("/logins", allow("ADM", "SADM"), (req, res) => {
  const sadm = req.user.role === "SADM";
  let rows = [...(db.loginSessions || [])].reverse();
  if (!sadm) { const tid = req.user.tenantId || "t1"; rows = rows.filter(l => (l.tenantId || "t1") === tid && l.role !== "SADM"); }
  if (req.query.userId) rows = rows.filter(l => l.userId === req.query.userId);
  const now = Date.now();
  rows = rows.slice(0, 400).map(l => {
    const base = { id: l.id, at: l.at, userName: l.userName, role: l.role, device: l.device, os: l.os, browser: l.browser,
      logoutAt: l.logoutAt, durationMs: l.durationMs != null ? l.durationMs : (l.logoutAt ? null : (now - new Date(l.at).getTime())),
      active: !l.logoutAt, endReason: l.endReason };
    if (sadm) Object.assign(base, { ip: l.ip, city: l.city, region: l.region, country: l.country, email: l.email, tenantId: l.tenantId, userAgent: l.userAgent });
    return base;
  });
  // petites stats
  const stats = { total: rows.length, active: rows.filter(r => r.active).length,
    users: new Set(rows.map(r => r.userName)).size };
  res.json({ rows, stats, scope: sadm ? "platform" : "tenant" });
});

module.exports = router;
