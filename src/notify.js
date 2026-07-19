/**
 * Notifications (§5.3): in-app always; email when configured.
 * - toUser/toRole: generic in-app + optional email copy
 * - event(): renders a bilingual template for a known workflow event and sends
 *   to the role's users + any admin-configured extra recipients
 */
const { db, save, id } = require("./store");
const mailer = require("./mailer");

function emailCfg() { return (db.settings && db.settings.email) || {}; }

function toUser(userId, subject, body, ref = null) {
  db.notifications.push({ id: id("ntf"), userId, subject, body, ref,
    at: new Date().toISOString(), readAt: null });
  save();
  const e = emailCfg();
  if (e.enabled && e.notifyOnWorkflow) {
    const u = db.users.find(x => x.id === userId);
    if (u && u.email) mailer.trySend(u.email, `SGRHP — ${subject}`, `${body}\n\n—\nSGRHP`);
  }
}
function toRole(role, subject, body, ref = null) {
  db.users.filter(u => u.role === role && u.active).forEach(u => toUser(u.id, subject, body, ref));
}

/**
 * event(eventKey, {role, userId}, vars, {sla}) — records the in-app message (from
 * the template, default language French) and emails role users + extra recipients
 * using the bilingual template.
 */
function event(eventKey, target, vars = {}, opts = {}) {
  const isSla = eventKey === "slaWarning" || eventKey === "slaBreach";
  const e = emailCfg();
  const rendered = mailer.render(eventKey, "fr", vars) || { subject: eventKey, body: "" };

  // in-app to the intended recipients
  const recips = [];
  if (target.userId) recips.push(db.users.find(u => u.id === target.userId));
  if (target.role) recips.push(...db.users.filter(u => u.role === target.role && u.active));
  recips.filter(Boolean).forEach(u => {
    db.notifications.push({ id: id("ntf"), userId: u.id, subject: rendered.subject, body: rendered.body,
      ref: vars.ref || null, at: new Date().toISOString(), readAt: null });
  });
  save();

  // email, if enabled and the relevant toggle is on
  if (e.enabled && ((isSla && e.notifyOnSla) || (!isSla && e.notifyOnWorkflow))) {
    const base = recips.filter(Boolean).map(u => u.email).filter(Boolean);
    const to = mailer.recipientsFor(eventKey, base);
    if (to.length) {
      const en = mailer.render(eventKey, "en", vars);
      // send French with English appended (bilingual org); templates already localised
      const subject = rendered.subject;
      const body = rendered.body + (en ? `\n\n----------\n${en.body}` : "");
      mailer.trySend(to, subject, body);
    }
  }
}

module.exports = { toUser, toRole, event };
