/** In-app notifications (§5.3). Email/SMS channels arrive in M7. */
const { db, save, id } = require("./store");
const mailer = require("./mailer");

function toUser(userId, subject, body, ref = null) {
  db.notifications.push({ id: id("ntf"), userId, subject, body, ref,
    at: new Date().toISOString(), readAt: null });
  save();
  // Email copy when the administrator has enabled SMTP (§7.1)
  const smtp = (db.settings && db.settings.smtp) || {};
  if (smtp.enabled && smtp.notifyOnWorkflow) {
    const u = db.users.find(x => x.id === userId);
    if (u && u.email) mailer.trySend(u.email, `SGRHP — ${subject}`, `${body}\n\n—\nSGRHP · Cible RH Emploi S.A.`);
  }
}
function toRole(role, subject, body, ref = null) {
  db.users.filter(u => u.role === role && u.active)
    .forEach(u => toUser(u.id, subject, body, ref));
}
module.exports = { toUser, toRole };
