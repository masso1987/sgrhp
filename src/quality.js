/**
 * SGRHP — couche « signaux qualité » (SMQ Phase 2bis).
 * Point d'entrée unique que les modules opérationnels appellent quand une donnée
 * VALIDÉE/VERROUILLÉE est modifiée. Journalise l'événement (traçabilité) et, si le
 * module « quality » est actif et l'auto-ouverture activée, ouvre une fiche d'amélioration.
 * Découplé : ne jette jamais dans l'appelant.
 */
const { db, save, id, stamp } = require("./store");

function tenantHasQuality(tid) {
  const t = (db.tenants || []).find(x => x.id === (tid || "t1"));
  return !!(t && (t.modules || []).includes("quality"));
}
function autoRaiseEnabled(tid) {
  if (!db.smqConfig) db.smqConfig = [];
  const c = db.smqConfig.find(x => (x.tenantId || "t1") === (tid || "t1"));
  return c ? c.autoRaiseOnChange !== false : true;   // activé par défaut
}
function money(n) { return Math.round(Number(n) || 0); }

/**
 * @param req  requête Express (pour user + tenant)
 * @param p    { objectType, objectId, ref, action, motif, before, after, changed, gravite }
 * @returns    l'événement créé (ou null)
 */
function qualityEvent(req, p = {}) {
  try {
    if (!db.smqEvents) db.smqEvents = [];
    const u = (req && req.user) || {};
    const tid = u.tenantId || "t1";
    const changed = p.changed !== undefined ? p.changed
      : (p.before && p.after ? JSON.stringify(p.before) !== JSON.stringify(p.after) : false);
    const ev = stamp({
      id: id("qev"), at: new Date().toISOString(),
      userId: u.id, userName: u.fullName, role: u.role,
      objectType: p.objectType || "", objectId: p.objectId || "", ref: p.ref || "",
      action: p.action || "modif_apres_validation", motif: p.motif || "",
      before: p.before || null, after: p.after || null, changed,
      improvementId: null, reviewed: false,
    }, req);
    db.smqEvents.push(ev);

    // Auto-ouverture d'une fiche d'amélioration si un vrai changement est détecté.
    if (changed && tenantHasQuality(tid) && autoRaiseEnabled(tid)) {
      const y = new Date().getFullYear();
      const same = (db.smqImprovements || []).filter(x => (x.tenantId || "t1") === tid && String(x.ref || "").endsWith("/" + y));
      let max = 0; for (const x of same) { const n = parseInt(String(x.ref), 10); if (n > max) max = n; }
      const ref = String(max + 1).padStart(2, "0") + "/QHSE/" + y;
      const diff = summarizeDiff(p.before, p.after);
      const fiche = stamp({
        id: id("smq"), ref, entite: "QHSE", date: new Date().toISOString().slice(0, 10),
        origine: "Non-conformité", type: "interne", gravite: p.gravite || "mineure", statut: "ouverte",
        description: `Modification après validation — ${p.objectType || "objet"} ${p.ref || p.objectId || ""}.`
          + (p.motif ? ` Motif : ${p.motif}.` : "") + (diff ? ` Changements : ${diff}.` : ""),
        analyseCauses: "", actions: [], emetteurName: "Système (traçabilité SMQ)",
        sourceEventId: ev.id, createdAt: new Date().toISOString(),
      }, req);
      if (!db.smqImprovements) db.smqImprovements = [];
      db.smqImprovements.push(fiche);
      ev.improvementId = fiche.id;
    }
    save();
    return ev;
  } catch (e) { console.error("[quality] event failed:", e.message); return null; }
}

function summarizeDiff(a, b) {
  if (!a || !b) return "";
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${k}: ${a[k]} → ${b[k]}`);
  return out.join(" ; ");
}

module.exports = { qualityEvent, money };
