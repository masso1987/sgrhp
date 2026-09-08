/**
 * Suivi des échéances : documents (pièces avec date d'expiration), validité CNI, fin de
 * contrat (CDD). Rappels automatiques par email (GPF du portefeuille + salarié) + notification
 * in-app, à partir de 90 jours avant l'échéance puis environ chaque mois (jusqu'à 1 an après).
 */
const { db, save, id } = require("./store");
const mailer = require("./mailer");
const DAY = 86400000, WINDOW = 90, CADENCE = 28, STOP_AFTER = 365;

const daysLeft = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : Math.ceil((d.getTime() - Date.now()) / DAY); };
const empName = (e) => `${e.firstName || ""} ${e.lastName || ""}`.trim();
const docLabel = (code) => { const d = (db.docTypes || []).find(x => x.code === code); return d ? d.label : code; };

function items(tenantId) {
  const out = [];
  const emps = (db.employees || []).filter(e => !tenantId || (e.tenantId || "t1") === tenantId);
  const byId = {}; emps.forEach(e => byId[e.id] = e);
  for (const f of (db.files || [])) {
    if (!f.expiryDate) continue; const e = byId[f.employeeId]; if (!e) continue;
    out.push({ kind: "file", id: f.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, email: e.email, label: docLabel(f.docType), fileName: f.fileName, expiryDate: f.expiryDate, daysLeft: daysLeft(f.expiryDate) });
  }
  for (const e of emps) {
    if (e.cniExpiry) out.push({ kind: "cni", id: e.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, email: e.email, label: "Validité CNI", expiryDate: e.cniExpiry, daysLeft: daysLeft(e.cniExpiry) });
    const end = e.contract && e.contract.endDate;
    if (end) out.push({ kind: "contract", id: e.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, email: e.email, label: "Fin de contrat (CDD)", expiryDate: end, daysLeft: daysLeft(end) });
  }
  return out.filter(x => x.daysLeft !== null).sort((a, b) => a.daysLeft - b.daysLeft);
}

const noticeField = (kind) => kind === "file" ? "reminderAt" : (kind === "cni" ? "reminderCni" : "reminderContract");
function getLast(it) { if (it.kind === "file") { const f = db.files.find(x => x.id === it.id); return f && f.reminderAt; } const e = db.employees.find(x => x.id === it.employeeId); return e && e[noticeField(it.kind)]; }
function setLast(it, iso) { if (it.kind === "file") { const f = db.files.find(x => x.id === it.id); if (f) f.reminderAt = iso; } else { const e = db.employees.find(x => x.id === it.employeeId); if (e) e[noticeField(it.kind)] = iso; } }
function gpfsOf(e) { return (db.users || []).filter(u => u.role === "GPF" && u.active !== false && (u.tenantId || "t1") === (e.tenantId || "t1") && (u.portfolioIds || []).includes(e.portfolioId)); }

function scanAndRemind() {
  const now = Date.now(); let sent = 0;
  for (const it of items()) {
    if (it.daysLeft > WINDOW || it.daysLeft < -STOP_AFTER) continue;
    const last = getLast(it);
    if (last && (now - new Date(last).getTime()) < CADENCE * DAY) continue;
    const e = db.employees.find(x => x.id === it.employeeId); if (!e) continue;
    const when = new Date(it.expiryDate).toLocaleDateString("fr-FR");
    const state = it.daysLeft < 0 ? `a expiré depuis ${Math.abs(it.daysLeft)} jour(s)` : `expire dans ${it.daysLeft} jour(s) (le ${when})`;
    const subject = `Expiration : ${it.label} — ${it.employeeName}`;
    const body = `Le document « ${it.label} » de ${it.employeeName} ${state}.\nMerci de préparer le renouvellement.`;
    for (const g of gpfsOf(e)) {
      db.notifications.push({ id: id("ntf"), userId: g.id, subject, body, ref: it.employeeId, at: new Date().toISOString(), readAt: null });
      if (g.email) { try { mailer.trySend(g.email, `SGRHP — ${subject}`, body); } catch (x) {} }
    }
    if (it.email) { try { mailer.trySend(it.email, `Rappel : ${it.label}`, `Bonjour ${it.employeeName},\n\nVotre document « ${it.label} » ${state}. Merci de fournir le renouvellement à votre gestionnaire.\n\n—\nSGRHP`); } catch (x) {} }
    setLast(it, new Date().toISOString()); sent++;
  }
  if (sent) save();
  return sent;
}
module.exports = { items, scanAndRemind };
