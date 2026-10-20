/**
 * Digest e-mail des demandes « en attente » destinées au GPF.
 *
 * Les employés envoient depuis l'app mobile des demandes (AVI, acompte,
 * permission/absence, ajout d'ayant droit) qui attendent la validation ou la
 * confirmation du GPF sur l'app web. Ce module liste, par GPF (selon ses
 * portefeuilles), tout ce qui est en attente et lui envoie un récapitulatif
 * par e-mail. Déclenché quotidiennement et à la demande (bouton Administration).
 */
const { db } = require("./store");
const mailer = require("./mailer");

function empName(e) { return `${(e && e.firstName) || ""} ${(e && e.lastName) || ""}`.trim() || "(employé)"; }

/** Demandes en attente pour un tenant, indexées par employeeId. */
function pendingItems(tenantId) {
  const t = tenantId || "t1";
  const emps = (db.employees || []).filter(e => (e.tenantId || "t1") === t);
  const empById = {}; emps.forEach(e => { empById[e.id] = e; });
  const req = (db.empRequests || []).filter(r => (r.tenantId || "t1") === t && r.status === "PENDING");
  const deps = (db.dependents || []).filter(d => (d.tenantId || "t1") === t && d.status === "PENDING");
  const perms = (db.documents || []).filter(d => (d.tenantId || "t1") === t && d.type === "LEAVE" && d.source === "MOBILE"
    && (d.status === "SUBMITTED" || d.status === "DRAFT"));
  return { empById, req, deps, perms };
}

/** Portefeuilles gérés par un utilisateur (GPF). ADM voit tout le tenant. */
function scopeEmployee(user, emp, empById) {
  if (!emp) return false;
  if (user.role === "ADM") return true;
  const pids = user.portfolioIds || [];
  return pids.includes(emp.portfolioId);
}

/** Construit le digest d'un utilisateur donné (ses demandes en attente). */
function digestForUser(user) {
  const { empById, req, deps, perms } = pendingItems(user.tenantId);
  const inScope = (eid) => scopeEmployee(user, empById[eid], empById);
  const avis = req.filter(r => r.type === "AVI" && inScope(r.employeeId));
  const acomptes = req.filter(r => r.type === "ACOMPTE" && inScope(r.employeeId));
  const dependents = deps.filter(d => inScope(d.employeeId));
  const permissions = perms.filter(d => inScope(d.refId));
  const total = avis.length + acomptes.length + dependents.length + permissions.length;
  return { avis, acomptes, dependents, permissions, total, empById };
}

function textBody(user, d) {
  const L = [];
  L.push(`Bonjour ${user.fullName || ""},`.trim());
  L.push("");
  L.push(`Vous avez ${d.total} demande(s) en attente de validation ou de confirmation :`);
  L.push("");
  const section = (title, items, fmt) => {
    if (!items.length) return;
    L.push(`• ${title} (${items.length}) :`);
    items.slice(0, 50).forEach(x => L.push("   - " + fmt(x)));
    L.push("");
  };
  section("Attestations de virement irrévocable (AVI)", d.avis, r => `${empName(d.empById[r.employeeId])}${r.bankName ? " — " + r.bankName : ""}`);
  section("Acomptes sur salaire", d.acomptes, r => `${empName(d.empById[r.employeeId])} — ${Number(r.amount || 0).toLocaleString("fr-FR")} FCFA`);
  section("Permissions / absences", d.permissions, p => `${p.title || empName(d.empById[p.refId])}`);
  section("Ajouts d'ayant droit", d.dependents, x => `${empName(d.empById[x.employeeId])} — ${x.firstName || ""} ${x.lastName || ""} (${x.relation || ""})`);
  L.push("Connectez-vous à l'application pour les traiter.");
  return L.join("\n");
}

/** Envoie le digest à tous les GPF (et ADM) actifs ayant des demandes en attente.
 * Retourne un récapitulatif { sent, skipped, recipients }. */
async function sendDigests(opts = {}) {
  if (!mailer.cfg().enabled && !opts.force) return { sent: 0, skipped: 0, disabled: true };
  const users = (db.users || []).filter(u => u.active !== false && (u.role === "GPF" || u.role === "ADM") && u.email);
  let sent = 0, skipped = 0; const recipients = [];
  for (const u of users) {
    const d = digestForUser(u);
    if (d.total === 0) { skipped++; continue; }
    const subject = `Demandes en attente (${d.total}) — à traiter`;
    try { await mailer.send(u.email, subject, textBody(u, d)); sent++; recipients.push({ email: u.email, total: d.total }); }
    catch (e) { skipped++; }
  }
  return { sent, skipped, recipients };
}

module.exports = { sendDigests, digestForUser, pendingItems };
