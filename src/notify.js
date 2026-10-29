/**
 * Notifications (§5.3): in-app always; email when configured.
 * - toUser/toRole: generic in-app + optional email copy
 * - event(): renders a bilingual template for a known workflow event and sends
 *   to the role's users + any admin-configured extra recipients
 */
const { db, save, id } = require("./store");
const mailer = require("./mailer");

// Email is on when the tenant's own server or the platform's is enabled; the
// notification toggles are the tenant's own choice.
function emailCfg(tenantId) {
  const own = require("./routes/settings").settings(tenantId).email || {};
  return { enabled: !!mailer.cfg(tenantId).enabled, notifyOnWorkflow: own.notifyOnWorkflow !== false, notifyOnSla: own.notifyOnSla !== false };
}

function toUser(userId, subject, body, ref = null) {
  db.notifications.push({ id: id("ntf"), userId, subject, body, ref,
    at: new Date().toISOString(), readAt: null });
  save();
  const u = db.users.find(x => x.id === userId);
  const tid = (u && u.tenantId) || "t1";
  const e = emailCfg(tid);
  if (e.enabled && e.notifyOnWorkflow && u && u.email)
    mailer.trySend(u.email, `SGRHP - ${subject}`, `${body}\n\n-\nSGRHP`, tid);
}
/** Notifies the active users holding `role` in one tenant only. */
function toRole(role, subject, body, ref = null, tenantId = "t1") {
  db.users.filter(u => u.role === role && u.active && (u.tenantId || "t1") === tenantId).forEach(u => toUser(u.id, subject, body, ref));
}

/**
 * Tenant-scoped in-app notification to every active user holding any of `roles`
 * within a single organisation. Used for requests coming from the mobile app
 * (AVI, acompte, ayants droit, …) so the right web back-office users are alerted
 * without leaking across tenants.
 */
function toRolesTenant(roles, tenantId, subject, body, ref = null) {
  const set = Array.isArray(roles) ? roles : [roles];
  const tid = tenantId || "t1";
  db.users
    .filter(u => u.active && set.includes(u.role) && (u.tenantId || "t1") === tid)
    .forEach(u => toUser(u.id, subject, body, ref));
}

/**
 * event(eventKey, {role, userId}, vars, {sla}) - records the in-app message (from
 * the template, default language French) and emails role users + extra recipients
 * using the bilingual template.
 */
function event(eventKey, target, vars = {}, opts = {}) {
  const isSla = eventKey === "slaWarning" || eventKey === "slaBreach";
  // Role recipients, templates and email settings all belong to one tenant: the one given,
  // else the targeted user's.
  const targetUser = target.userId ? db.users.find(u => u.id === target.userId) : null;
  const tid = target.tenantId || (targetUser && targetUser.tenantId) || "t1";
  const e = emailCfg(tid);
  const rendered = mailer.render(eventKey, "fr", vars, tid) || { subject: eventKey, body: "" };

  // in-app to the intended recipients
  const recips = [];
  if (targetUser) recips.push(targetUser);
  if (target.role) recips.push(...db.users.filter(u => u.role === target.role && u.active && (u.tenantId || "t1") === tid));
  recips.filter(Boolean).forEach(u => {
    db.notifications.push({ id: id("ntf"), userId: u.id, subject: rendered.subject, body: rendered.body,
      ref: vars.ref || null, at: new Date().toISOString(), readAt: null });
  });
  save();

  // email, if enabled and the relevant toggle is on
  if (e.enabled && ((isSla && e.notifyOnSla) || (!isSla && e.notifyOnWorkflow))) {
    const base = recips.filter(Boolean).map(u => u.email).filter(Boolean);
    const to = mailer.recipientsFor(eventKey, base, tid);
    if (to.length) {
      const en = mailer.render(eventKey, "en", vars, tid);
      // send French with English appended (bilingual org); templates already localised
      const subject = rendered.subject;
      const body = rendered.body + (en ? `\n\n----------\n${en.body}` : "");
      mailer.trySend(to, subject, body, tid);
    }
  }
}

module.exports = { toUser, toRole, toRolesTenant, event };
