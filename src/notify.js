/** In-app notifications (§5.3). Email/SMS channels arrive in M7. */
const { db, save, id } = require("./store");

function toUser(userId, subject, body, ref = null) {
  db.notifications.push({ id: id("ntf"), userId, subject, body, ref,
    at: new Date().toISOString(), readAt: null });
  save();
}
function toRole(role, subject, body, ref = null) {
  db.users.filter(u => u.role === role && u.active)
    .forEach(u => toUser(u.id, subject, body, ref));
}
module.exports = { toUser, toRole };
