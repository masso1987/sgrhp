/** Append-only audit trail (§4.1): who, what, when, on which object. */
const { db, save, id } = require("./store");
function audit(user, action, objectType, objectId, detail = null) {
  db.audit.push({
    id: id("log"), at: new Date().toISOString(),
    userId: user.id, userName: user.fullName, role: user.role,
    tenantId: user.tenantId || "t1",
    action, objectType, objectId, detail,
  });
  save();
}
module.exports = { audit };
