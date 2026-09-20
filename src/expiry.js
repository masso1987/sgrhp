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
const docLabel = (code) => { const d = (db.docTypes || []).find(x => x.code === code); return d ? (d.labelFr || d.label) : code; };
const pfName = (pid) => { const p = (db.portfolios || []).find(x => x.id === pid); return p ? p.name : ""; };

function items(tenantId) {
  const out = [];
  const emps = (db.employees || []).filter(e => !tenantId || (e.tenantId || "t1") === tenantId);
  const byId = {}; emps.forEach(e => byId[e.id] = e);
  for (const f of (db.files || [])) {
    if (!f.expiryDate) continue; const e = byId[f.employeeId]; if (!e) continue;
    out.push({ kind: "file", id: f.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, portfolioName: pfName(e.portfolioId), email: e.email, label: docLabel(f.docType), typeLabel: docLabel(f.docType), fileName: f.fileName, expiryDate: f.expiryDate, daysLeft: daysLeft(f.expiryDate) });
  }
  for (const e of emps) {
    if (e.cniExpiry) out.push({ kind: "cni", id: e.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, portfolioName: pfName(e.portfolioId), email: e.email, label: "Validité CNI", typeLabel: "Validité CNI", expiryDate: e.cniExpiry, daysLeft: daysLeft(e.cniExpiry) });
    const end = e.contract && e.contract.endDate;
    if (end) out.push({ kind: "contract", id: e.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, portfolioName: pfName(e.portfolioId), email: e.email, label: "Fin de contrat (CDD)", typeLabel: "Fin de contrat (CDD)", expiryDate: end, daysLeft: daysLeft(end) });
  }
  for (const h of (db.smqHabilitations || [])) {
    if (!h.expiryDate) continue; const e = byId[h.employeeId]; if (!e) continue;
    out.push({ kind: "habilitation", id: h.id, employeeId: e.id, employeeName: empName(e), portfolioId: e.portfolioId, portfolioName: pfName(e.portfolioId), email: e.email, label: "Habilitation : " + (h.intitule || h.reference || h.type || ""), typeLabel: "Habilitations & formations", expiryDate: h.expiryDate, daysLeft: daysLeft(h.expiryDate) });
  }
  return out.filter(x => x.daysLeft !== null).sort((a, b) => a.daysLeft - b.daysLeft);
}

const noticeField = (kind) => kind === "file" ? "reminderAt" : (kind === "cni" ? "reminderCni" : "reminderContract");
function getLast(it) { if (it.kind === "file") { const f = db.files.find(x => x.id === it.id); return f && f.reminderAt; } if (it.kind === "habilitation") { const h = (db.smqHabilitations||[]).find(x => x.id === it.id); return h && h.reminderAt; } const e = db.employees.find(x => x.id === it.employeeId); return e && e[noticeField(it.kind)]; }
function setLast(it, iso) { if (it.kind === "file") { const f = db.files.find(x => x.id === it.id); if (f) f.reminderAt = iso; } else if (it.kind === "habilitation") { const h = (db.smqHabilitations||[]).find(x => x.id === it.id); if (h) h.reminderAt = iso; } else { const e = db.employees.find(x => x.id === it.employeeId); if (e) e[noticeField(it.kind)] = iso; } }
function gpfsOf(e) { return (db.users || []).filter(u => u.role === "GPF" && u.active !== false && (u.tenantId || "t1") === (e.tenantId || "t1") && (u.portfolioIds || []).includes(e.portfolioId)); }

function scanAndRemind() {
  const now = Date.now(); let sent = 0;
  for (const it of items()) {
    if (it.daysLeft > WINDOW || it.daysLeft < -STOP_AFTER) continue;
    const last = getLast(it);
    if (last && (now - new Date(last).getTime()) < CADENCE * DAY) continue;
    const e = db.employees.find(x => x.id === it.employeeId); if (!e) continue;
    const when = new Date(it.expiryDate).toLocaleDateString("fr-FR");
    const state = it.daysLeft < 0 ? `a expiré depuis ${Math.abs(it.daysLeft)} jour(s)` : `expire dans ${it.daysLeft} jour(s)`;
    // Message personnalisable (Administration › Modèles de notifications › Alerte d'expiration).
    let tpl = null; try { tpl = require("./routes/settings").settings().emailTemplates.expiry; } catch (x) {}
    const fill = (str) => String(str || "").replace(/{{\s*(\w+)\s*}}/g, (m, k) => ({ employee: it.employeeName, document: it.label, date: when, daysLeft: String(it.daysLeft), state, portfolio: it.portfolioName || "" }[k] ?? ""));
    const subject = tpl && tpl.subjectFr ? fill(tpl.subjectFr) : `Expiration : ${it.label} - ${it.employeeName}`;
    const body = tpl && tpl.bodyFr ? fill(tpl.bodyFr) : `Le document « ${it.label} » de ${it.employeeName} ${state}.\nMerci de préparer le renouvellement.`;
    for (const g of gpfsOf(e)) {
      db.notifications.push({ id: id("ntf"), userId: g.id, subject, body, ref: it.employeeId, at: new Date().toISOString(), readAt: null });
      if (g.email) { try { mailer.trySend(g.email, `SGRHP - ${subject}`, body); } catch (x) {} }
    }
    if (it.email) { try { mailer.trySend(it.email, subject, body); } catch (x) {} }
    setLast(it, new Date().toISOString()); sent++;
  }
  if (sent) save();
  return sent;
}
/* Avancement automatique d'échelon (Art. 72 CCN) : après 3 ans dans le même échelon,
 * passage à l'échelon supérieur (A→F) - sans validation. La base est recalculée via la grille. */
const { audit } = require("./audit");
function advanceEchelons() {
  // Désactivé par défaut : l'échelon reste celui saisi par les RH (comme dans Sage).
  // Réactivable via settings.autoEchelon = true (avancement conventionnel tous les 3 ans, Art. 72).
  let _auto = false; try { _auto = require("./routes/settings").settings().autoEchelon === true; } catch (e) {}
  if (!_auto) return 0;
  const YEARS3 = 3 * 365.25 * 86400000; const now = Date.now(); let changed = 0;
  for (const e of (db.employees || [])) {
    const c = e.contract || {}; const m = /^(\d{1,2})([A-F])$/.exec(String(c.category || ""));
    if (!m) continue;
    const cat = m[1], ech = m[2];
    if (ech === "F") continue;                         // déjà au dernier échelon
    if (!c.echelonSince) { c.echelonSince = c.startDate || e.hireDate || new Date(now).toISOString().slice(0, 10); }
    const since = new Date(c.echelonSince).getTime();
    if (isNaN(since) || (now - since) < YEARS3) continue;
    const nextEch = String.fromCharCode(ech.charCodeAt(0) + 1);
    const nextCat = cat + nextEch;
    // N'avancer que si l'échelon supérieur existe dans la grille de la convention rattachée.
    const conv = (db.conventions || []).find(x => x.id === c.conventionId) ||
      (db.conventions || []).find(x => (x.grid || []).some(g => g.category === c.category));
    const hasNext = conv && (conv.grid || []).some(g => g.category === nextCat);
    if (!hasNext) continue;
    c.category = nextCat; c.echelonSince = new Date(now).toISOString().slice(0, 10);
    try { audit({ id: "system", fullName: "Système", role: "ADM", tenantId: e.tenantId || "t1" }, "ECHELON_ADVANCE", "Employee", e.id, { from: cat + ech, to: nextCat }); } catch (x) {}
    changed++;
  }
  if (changed) save();
  return changed;
}
module.exports = { items, scanAndRemind, advanceEchelons };
