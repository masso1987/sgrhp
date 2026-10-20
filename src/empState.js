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

module.exports = { isDormant, todayStr };
