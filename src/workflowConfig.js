/**
 * Circuits de validation — logique pure, sans dépendance (mail, store, etc.).
 *
 * Le circuit d'un document n'est JAMAIS codé en dur : il est résolu depuis
 * la configuration du tenant (Administration › Circuits de validation). Chaque
 * type de document est rattaché à une clé de circuit, et le paramétrage décide
 * des niveaux (steps) et de l'activation (enabled). Un circuit désactivé ou sans
 * niveau = génération immédiate.
 *
 * Isolé dans ce module pour être testable sans charger toute la chaîne workflow.
 */
const WF_KEY = (type) => ({
  EMPLOYEE_FILE: "employee_file",
  TEMPLATE_DOC: "template_doc",
  AMENDMENT: "amendment",
  AVI: "avi",
  CONTRACT_END: "contract_end",
  LEAVE: "leave",
  DECISION: "decision",
}[type] || "template_doc");

const WF_DEFAULT = {
  employee_file: ["CD", "RJ"],
  template_doc: ["CD", "RJ"],
  amendment: ["CD", "RJ"],
  avi: ["CD", "RJ"],
  contract_end: ["RJ"],
  leave: ["CD"],
  decision: ["CD", "RJ"],
};

/**
 * Résout les rôles (niveaux) du circuit d'un type de document.
 * @param {string} type  type de document (LEAVE, AVI, …)
 * @param {Object} [workflowsCfg]  config tenant settings().workflows (optionnel)
 * @returns {string[]}  liste ordonnée des rôles valideurs ([] = aucun niveau)
 */
function resolveRoles(type, workflowsCfg) {
  const key = WF_KEY(type);
  const w = workflowsCfg && workflowsCfg[key];
  if (w) {
    if (w.enabled === false) return [];
    if (Array.isArray(w.steps)) return w.steps.filter(Boolean);
  }
  return WF_DEFAULT[key] || ["CD", "RJ"];
}

module.exports = { WF_KEY, WF_DEFAULT, resolveRoles };
