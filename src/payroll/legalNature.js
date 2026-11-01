/**
 * Nature légale des rubriques de paie (Cameroun) : traitement IRPP / CNPS que la loi impose.
 * L'analyse salariale raisonne sur la nature, pas sur le code (un même code n'a pas le même sens
 * d'une base Sage à l'autre). Voir docs/SALARY_OPTIMISATION_DESIGN.md §2.
 *
 * impo : "FULL" (100 % imposable) | "CAP" (imposable dans la limite capRate × salaire taxable, CGI art. 33)
 *        | "EXEMPT" (exonéré)
 * cnps : true / false, ou null = selon le profil de paie (pas de constat).
 * cnpsDefault : la valeur CNPS n'est qu'un défaut (bases Sage différentes) -> constat « à confirmer ».
 * justify : exonération soumise à justification (frais réellement engagés, emploi éligible).
 */
"use strict";

const REF = {
  base: "CGI art. 30 et 32",
  art33: "CGI art. 33 (1)(2) ; lettres MINFI 0474 et 4156 de 2003",
  frais: "CGI art. 31-1 ; arrêté 003/MTPS-94/MINFI du 01/03/1974 ; circulaire CNPS 021/1991",
  cnpsCirc: "Circulaire CNPS n° 021/91/DR/DG/CNPS du 17/05/1991",
  transport: "CGI art. 30 (aucune exonération expresse) ; pratique CNPS (hors assiette)",
  social: "CGI art. 31-2 et 31-11",
  licen: "CGI art. 31-12 ; circulaire CNPS 021/1991",
};

const NATURES = {
  SALAIRE_BASE: { label: "Salaire de base", impo: "FULL", cnps: true, ref: REF.base },
  SURSALAIRE: { label: "Sursalaire", impo: "FULL", cnps: true, ref: REF.base },
  ANCIENNETE: { label: "Prime d'ancienneté", impo: "FULL", cnps: true, ref: REF.base },
  HS: { label: "Heures supplémentaires", impo: "FULL", cnps: true, ref: REF.base },
  PRIME: { label: "Prime liée au travail", impo: "FULL", cnps: true, ref: REF.base },
  GRATIFICATION: { label: "Gratification (13e mois, bonus)", impo: "FULL", cnps: true, ref: REF.base },
  TRANSPORT: { label: "Prime de transport", impo: "FULL", cnps: false, ref: REF.transport },
  AN_LOGEMENT: { label: "Indemnité de logement", impo: "CAP", capRate: 0.15, cnps: null, ref: REF.art33 },
  AN_ELECTRICITE: { label: "Indemnité d'électricité", impo: "CAP", capRate: 0.04, cnps: false, cnpsDefault: true, ref: REF.art33 },
  AN_EAU: { label: "Indemnité d'eau", impo: "CAP", capRate: 0.02, cnps: false, cnpsDefault: true, ref: REF.art33 },
  AN_DOMESTIQUE: { label: "Indemnité de domestique", impo: "CAP", capRate: 0.05, cnps: false, cnpsDefault: true, ref: REF.art33 },
  AN_VEHICULE: { label: "Indemnité de véhicule", impo: "CAP", capRate: 0.10, cnps: false, cnpsDefault: true, ref: REF.art33 },
  AN_NOURRITURE: { label: "Indemnité de nourriture", impo: "CAP", capRate: 0.10, cnps: false, cnpsDefault: true, ref: REF.art33 },
  FRAIS_PANIER: { label: "Prime de panier", impo: "EXEMPT", cnps: false, justify: true, ref: REF.frais,
    pieces: "Planning de travail de nuit ou de chantier, feuilles de présence" },
  FRAIS_SALISSURE: { label: "Prime de salissure", impo: "EXEMPT", cnps: false, justify: true, ref: REF.frais,
    pieces: "Fiche de poste montrant un travail salissant (entretien, magasin, atelier, laboratoire)" },
  FRAIS_OUTILLAGE: { label: "Prime d'outillage", impo: "EXEMPT", cnps: false, justify: true, ref: REF.frais,
    pieces: "Inventaire des outils personnels utilisés pour le travail" },
  FRAIS_KILOMETRIQUE: { label: "Indemnité kilométrique", impo: "EXEMPT", cnps: false, justify: true, ref: REF.frais,
    pieces: "Carte grise du véhicule personnel, états de déplacements professionnels" },
  FRAIS_MISSION: { label: "Frais de mission / déplacement", impo: "EXEMPT", cnps: false, justify: true, ref: REF.frais,
    pieces: "Ordres de mission et justificatifs de dépenses" },
  FRAIS_REPRESENTATION: { label: "Indemnité de représentation", impo: "EXEMPT", cnps: false, justify: true, ref: REF.frais,
    pieces: "Notes de frais et justificatifs des dépenses de représentation" },
  RUPTURE_LICENCIEMENT: { label: "Indemnité de licenciement (part dommages-intérêts)", impo: "EXEMPT", cnps: false, ref: REF.licen },
  RUPTURE_FIN_CARRIERE: { label: "Indemnité de fin de carrière", impo: "FULL", cnps: false, ref: REF.cnpsCirc },
  BONNE_SEPARATION: { label: "Prime de bonne séparation", impo: "FULL", cnps: false, ref: REF.cnpsCirc },
  DEPART_RETRAITE: { label: "Prime de départ à la retraite", impo: "FULL", cnps: false, ref: REF.cnpsCirc },
  PREAVIS: { label: "Indemnité de préavis", impo: "FULL", cnps: true, ref: REF.cnpsCirc },
  CONGES: { label: "Allocation de congés", impo: "FULL", cnps: true, ref: REF.cnpsCirc },
  CHOMAGE_TECHNIQUE: { label: "Indemnité de chômage technique", impo: "FULL", cnps: true, ref: REF.cnpsCirc },
  SOCIAL_EXONERE: { label: "Avantage social exonéré (médaille, allocations familiales)", impo: "EXEMPT", cnps: false, ref: REF.social },
  HORS_ANALYSE: { label: "Hors analyse (retenue, cotisation, autre)", impo: null, cnps: null, ref: "" },
};

// Nature proposée d'après le libellé (puis le code, en dernier recours). Jamais enregistrée
// automatiquement : l'utilisateur la confirme dans la fiche rubrique.
const RULES = [
  [/salaire de base|salaire mensuel|^salaire$/i, "SALAIRE_BASE"],
  [/sursalaire|sur-salaire/i, "SURSALAIRE"],
  [/anciennet/i, "ANCIENNETE"],
  [/heures? supp|h\.? ?supp|majoration.*heure/i, "HS"],
  [/13e|13 ?[èe]me|treizi|gratification|bonus/i, "GRATIFICATION"],
  [/logement|loyer/i, "AN_LOGEMENT"],
  [/[ée]lectricit/i, "AN_ELECTRICITE"],
  [/\beau\b/i, "AN_EAU"],
  [/domestique|gardien|\bboy\b|m[ée]nag[èe]re|cuisinier|jardinier/i, "AN_DOMESTIQUE"],
  [/v[ée]hicule|voiture/i, "AN_VEHICULE"],
  [/nourriture|alimentation/i, "AN_NOURRITURE"],
  [/panier|repas/i, "FRAIS_PANIER"],
  [/saliss|salubrit/i, "FRAIS_SALISSURE"],
  [/outillage|outils/i, "FRAIS_OUTILLAGE"],
  [/kilom/i, "FRAIS_KILOMETRIQUE"],
  [/mission|d[ée]placement|grand d[ée]pl/i, "FRAIS_MISSION"],
  [/repr[ée]sentation/i, "FRAIS_REPRESENTATION"],
  [/transport/i, "TRANSPORT"],
  [/licenciement/i, "RUPTURE_LICENCIEMENT"],
  [/fin de carri/i, "RUPTURE_FIN_CARRIERE"],
  [/bonne s[ée]paration/i, "BONNE_SEPARATION"],
  [/retraite/i, "DEPART_RETRAITE"],
  [/pr[ée]avis/i, "PREAVIS"],
  [/cong[ée]/i, "CONGES"],
  [/ch[oô]mage/i, "CHOMAGE_TECHNIQUE"],
  [/m[ée]daille|allocations? famil/i, "SOCIAL_EXONERE"],
];
const KEY_NATURE = { "1000": "SALAIRE_BASE", "1040": "ANCIENNETE", "1055": "ANCIENNETE", "1083": "HS", "1088": "HS", "1092": "HS", "1096": "HS",
  "3513": "TRANSPORT", "3510": "AN_LOGEMENT", "2514": "GRATIFICATION", "3702": "CONGES" };

function suggestNature(rub) {
  if (!rub) return "PRIME";
  const fam = String(rub.family || "").toUpperCase(), sens = String(rub.sens || "GAIN").toUpperCase();
  if (sens !== "GAIN" || fam === "COTISATION") return "HORS_ANALYSE";
  const txt = String(rub.label || rub.name || "");
  for (const [re, n] of RULES) if (re.test(txt)) return n;
  const k = String(rub.baseCode || rub.code || "");
  return KEY_NATURE[k] || "PRIME";
}
// Nature retenue pour une rubrique : celle enregistrée, sinon la proposition.
function natureOf(rub, fallbackLabel) {
  if (rub && rub.legalNature && NATURES[rub.legalNature]) return { nature: rub.legalNature, suggested: false };
  return { nature: suggestNature(rub || { label: fallbackLabel }), suggested: true };
}

module.exports = { NATURES, suggestNature, natureOf };
