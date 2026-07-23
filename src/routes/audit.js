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
module.exports = router;
