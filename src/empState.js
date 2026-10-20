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
function supervisedEmployees(db, tenantId, supervisorEmpId) {
  const t = tenantId || "t1";
  const emps = (db.employees || []).filter(e => (e.tenantId || "t1") === t
    && String(e.status || "").toUpperCase() !== "ARCHIVED" && !isDormant(e));
  const links = (db.supervisions || []).filter(s => (s.tenantId || "t1") === t && s.supervisorEmpId === supervisorEmpId);
  const pfs = new Set(links.filter(l => l.scope === "PORTFOLIO").map(l => l.targetId));
  const direct = new Set(links.filter(l => l.scope === "EMPLOYEE").map(l => l.targetId));
  const out = new Map();
  for (const e of emps) {
    if (e.id === supervisorEmpId) continue; // pas soi-même
    if (e.supervisorEmpId === supervisorEmpId || pfs.has(e.portfolioId) || direct.has(e.id)) out.set(e.id, e);
  }
  return [...out.values()];
}

/** Vrai si l'employé supervise au moins un collègue (ou est marqué superviseur terrain). */
function isFieldSupervisor(db, tenantId, empId) {
  const e = (db.employees || []).find(x => x.id === empId);
  if (e && e.fieldSupervisor === true) return true;
  return supervisedEmployees(db, tenantId, empId).length > 0;
}

module.exports = { isDormant, todayStr, supervisedEmployees, isFieldSupervisor };
