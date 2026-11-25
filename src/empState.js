/**
 * État « sommeil » (dormant) d'un employé.
 *
 * Règle métier : quand le contrat d'un employé prend fin, il passe en SOMMEIL.
 * Ses données restent dans le système (jamais supprimées si une paie a été
 * traitée). En sommeil :
 *   - aucune modification de sa fiche n'est possible,
 *   - sa paie ne peut plus être traitée (il reste visible, verrouillé, dans le
 *     rôle de paie), mais on peut consulter ses éléments de salaire et rééditer
 *     ses duplicata (bulletins déjà générés),
 *   - il est retiré automatiquement de tous les sites de pointage.
 * La réactivation se fait par l'ouverture d'un nouveau contrat.
 */
function todayStr() { return new Date().toISOString().slice(0, 10); }

/** Un employé est en sommeil si on l'a explicitement marqué, ou si la date de
 * fin de son contrat courant est atteinte. */
function isDormant(emp) {
  if (!emp) return false;
  if (emp.dormant === true) return true;
  const c = emp.contract || {};
  if (c.ended === true) return true;
  if (c.endDate && String(c.endDate).slice(0, 10) <= todayStr()) return true;
  return false;
}

/**
 * Ensemble des employés supervisés par un superviseur (employé « superviseur
 * terrain »). Trois sources cumulées :
 *   - lien direct : employé dont supervisorEmpId == superviseur ;
 *   - lien portefeuille : tous les employés d'un portefeuille supervisé ;
 *   - lien employé : employés explicitement rattachés (collection supervisions).
 * Exclut les archivés et les employés en sommeil. L'employé peut toujours
 * pointer pour lui-même ; la supervision s'ajoute, elle ne remplace pas.
 */
/** Compte web GPF lié à cette fiche employé (le GPF est aussi salarié : il pointe son équipe sur mobile). */
function linkedGpf(db, tenantId, empId) {
  const t = tenantId || "t1";
  return (db.users || []).find(u => (u.tenantId || "t1") === t && u.employeeId === empId && u.role === "GPF" && u.active !== false) || null;
}
// Équipe = affectation directe + périmètres (portefeuilles, employés) + portefeuilles gérés par le compte GPF lié,
// moins les exclusions (périmètre « EXCLUDE »).
function supervisedEmployees(db, tenantId, supervisorEmpId) {
  const t = tenantId || "t1";
  const emps = (db.employees || []).filter(e => (e.tenantId || "t1") === t
    && String(e.status || "").toUpperCase() !== "ARCHIVED" && !isDormant(e));
  const links = (db.supervisions || []).filter(s => (s.tenantId || "t1") === t && s.supervisorEmpId === supervisorEmpId);
  const pfs = new Set(links.filter(l => l.scope === "PORTFOLIO").map(l => l.targetId));
  const direct = new Set(links.filter(l => l.scope === "EMPLOYEE").map(l => l.targetId));
  const excluded = new Set(links.filter(l => l.scope === "EXCLUDE").map(l => l.targetId));
  const gpf = linkedGpf(db, t, supervisorEmpId);
  const gpfPfs = new Set(gpf ? (gpf.portfolioIds || []) : []);
  const out = new Map();
  for (const e of emps) {
    if (e.id === supervisorEmpId || excluded.has(e.id)) continue; // pas soi-même, ni les exclus
    if (e.supervisorEmpId === supervisorEmpId || pfs.has(e.portfolioId) || gpfPfs.has(e.portfolioId) || direct.has(e.id)) out.set(e.id, e);
  }
  return [...out.values()];
}

/** Vrai si l'employé supervise au moins un collègue, est marqué chef d'équipe, ou est un GPF lié. */
function isFieldSupervisor(db, tenantId, empId) {
  const e = (db.employees || []).find(x => x.id === empId);
  if (e && e.fieldSupervisor === true) return true;
  if (linkedGpf(db, tenantId, empId)) return true;
  return supervisedEmployees(db, tenantId, empId).length > 0;
}

module.exports = { isDormant, todayStr, supervisedEmployees, isFieldSupervisor, linkedGpf };
