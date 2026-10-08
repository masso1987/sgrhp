/* Circuits de validation — configurables par tenant, JAMAIS codés en dur.
 * Couvre le correctif congé : LEAVE suit le circuit "leave" paramétrable
 * (et non plus le repli template_doc CD→RJ). */
const { WF_KEY, WF_DEFAULT, resolveRoles } = require("./workflowConfig");
let pass = 0, fail = 0;
const eq = (n, g, e) => { const ok = JSON.stringify(g) === JSON.stringify(e); console.log(`${ok ? "✓" : "✗"} ${n}: ${JSON.stringify(g)} (exp ${JSON.stringify(e)})`); ok ? pass++ : fail++; };

// --- Mapping type de document -> clé de circuit ---
eq("WF_KEY LEAVE", WF_KEY("LEAVE"), "leave");
eq("WF_KEY DECISION", WF_KEY("DECISION"), "decision");
eq("WF_KEY AVI", WF_KEY("AVI"), "avi");
eq("WF_KEY inconnu -> template_doc", WF_KEY("CHOSE_BIZARRE"), "template_doc");

// --- Défauts (aucune config tenant) ---
eq("défaut congé = [CD]", resolveRoles("LEAVE", null), ["CD"]);
eq("défaut décision = [CD,RJ]", resolveRoles("DECISION", undefined), ["CD", "RJ"]);
eq("défaut dossier employé = [CD,RJ]", resolveRoles("EMPLOYEE_FILE"), ["CD", "RJ"]);

// --- Configuration tenant : le circuit est bien pris en compte (pas codé en dur) ---
const cfg1 = {
  leave: { enabled: true, steps: ["CD", "RJ"] },     // l'admin ajoute un 2e niveau au congé
  decision: { enabled: false, steps: ["CD", "RJ"] }, // décisions désactivées -> aucun niveau
};
eq("congé reconfiguré = [CD,RJ]", resolveRoles("LEAVE", cfg1), ["CD", "RJ"]);
eq("décision désactivée = []", resolveRoles("DECISION", cfg1), []);

// --- enabled:false -> génération immédiate (0 niveau) ---
eq("congé désactivé = []", resolveRoles("LEAVE", { leave: { enabled: false, steps: ["CD"] } }), []);

// --- steps vides filtrés ---
eq("steps nettoyés", resolveRoles("LEAVE", { leave: { enabled: true, steps: ["CD", null, "", "RJ"] } }), ["CD", "RJ"]);

// Chaque clé par défaut a bien un circuit défini.
eq("WF_DEFAULT a 'leave'", Array.isArray(WF_DEFAULT.leave), true);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
