/**
 * Circuits de validation des PROCESSUS (facture, annexe de facturation, clôture de paie,
 * écriture comptable) — appliqués dynamiquement depuis la configuration de la société
 * (Administration › Circuits de validation), jamais codés en dur.
 *
 *  - Circuit désactivé ou sans niveau : l'action se fait en une fois, par les rôles habituels.
 *  - Circuit actif : chaque niveau approuve DANS L'ORDRE configuré (ex. CD puis RJ) ; l'action
 *    n'est exécutée qu'après le dernier niveau. L'administrateur peut approuver à tout niveau.
 *    Les approbations sont conservées sur l'objet (obj.approvals) et tracées.
 */
const { db, save } = require("./store");

const ROLE_LABEL = { CD: "Chef de département", RJ: "Responsable juridique", RQ: "Responsable qualité",
  ADM: "Administrateur", GPF: "Gestionnaire", RP: "Gestion paie", RC: "Comptable", UI: "Utilisateur" };
const roleLabel = (r) => ROLE_LABEL[r] || r;

/** Rôles du circuit `key` pour la société de la requête ([] = pas de circuit). */
function circuitRoles(req, key) {
  let cfg = null;
  try { cfg = require("./routes/settings").settings(req).workflows; } catch (e) {}
  const w = cfg && cfg[key];
  if (!w || w.enabled === false) return [];
  return (Array.isArray(w.steps) ? w.steps : []).filter(Boolean);
}

/**
 * Enregistre l'approbation de l'utilisateur sur `obj` pour le circuit `key`.
 * Retourne { done:true } quand l'action peut être exécutée, { done:false, next } quand un
 * autre niveau doit encore approuver, ou { error, status } si ce n'est pas le tour de l'utilisateur.
 */
function approveStep(req, obj, key, label) {
  const roles = circuitRoles(req, key);
  if (!roles.length) return { done: true, roles };
  obj.approvals = Array.isArray(obj.approvals) ? obj.approvals : [];
  const expected = roles[obj.approvals.length];
  if (!expected) return { done: true, roles };
  const role = req.user.role;
  if (role !== expected && role !== "ADM")
    return { status: 403, error: `Étape en attente : ${roleLabel(expected)} (${expected}). Circuit : ${roles.join(" → ")}.` };
  obj.approvals.push({ role: expected, byRole: role, by: req.user.fullName || req.user.email || req.user.id, at: new Date().toISOString() });
  if (obj.approvals.length < roles.length) {
    const next = roles[obj.approvals.length];
    try {
      require("./notify").event("submitted", { role: next, tenantId: req.user.tenantId || "t1" },
        { title: label, initiator: req.user.fullName || req.user.email || "un utilisateur", stage: next, stageLabel: roleLabel(next), sla: 48, ref: obj.id });
    } catch (e) {}
    return { done: false, next, roles };
  }
  // Circuit complet : on archive les approbations et on repart de zéro pour un prochain cycle
  // (facture rouverte, paie réouverte puis reclôturée, écriture dévalidée…).
  obj.approvalHistory = (obj.approvalHistory || []).concat([{ completedAt: new Date().toISOString(), approvals: obj.approvals }]);
  obj.approvals = [];
  return { done: true, roles };
}
/** Remet le circuit à zéro (réouverture, rejet). */
function resetApprovals(obj) { obj.approvals = []; }

/** Résumé lisible pour l'interface. */
function approvalState(req, obj, key) {
  const roles = circuitRoles(req, key);
  const done = (obj.approvals || []).length;
  return { roles, approvals: obj.approvals || [], next: roles[done] || null, complete: !roles.length || done >= roles.length };
}

module.exports = { circuitRoles, approveStep, resetApprovals, approvalState, roleLabel, ROLE_LABEL };
