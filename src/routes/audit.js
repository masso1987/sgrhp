const router = require("express").Router();
const { db } = require("../store");
const { allow } = require("../rbac");

// Filterable audit log (§4.1): user, action, object, date range
router.get("/", allow("CD", "RJ", "ADM"), (req, res) => {
  let logs = [...db.audit].reverse();
  const { userId, action, objectType, from, to } = req.query;
  if (userId) logs = logs.filter(l => l.userId === userId);
  if (action) logs = logs.filter(l => l.action === action);
  if (objectType) logs = logs.filter(l => l.objectType === objectType);
  if (from) logs = logs.filter(l => l.at >= from);
  if (to) logs = logs.filter(l => l.at <= to);
  res.json(logs.slice(0, 200));
});
module.exports = router;
