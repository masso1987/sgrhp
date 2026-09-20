/**
 * Solde de tout compte / droits de rupture - CCN Commerce 2024.
 * Articles : 42 (préavis), 45 (indemnité de licenciement), 46 (indemnité de fin
 * de carrière), 47 (décès = indemnité de fin de carrière), 48 (prime de bonne
 * séparation), 42 al.2b (inaptitude : 3 mois si ≥ 2 ans).
 *
 * Barèmes « à corriger » : les durées de préavis (Art.42) renvoient à « la
 * réglementation en vigueur » (Code du travail) - valeurs par collège éditables.
 */

const DEFAULT_RUPTURE = {
  // Indemnité de licenciement (Art. 45) - % du salaire moyen des 12 derniers
  // mois, par année de présence, cumulé par tranche d'ancienneté.
  licenciement: [
    { upToYears: 5, rate: 0.30 },
    { upToYears: 10, rate: 0.35 },
    { upToYears: 15, rate: 0.45 },
    { upToYears: 20, rate: 0.50 },
    { upToYears: Infinity, rate: 0.55 },
  ],
  // Indemnité de fin de carrière (Art. 46) / décès (Art. 47).
  finCarriere: [
    { upToYears: 5, rate: 0.45 },
    { upToYears: 10, rate: 0.50 },
    { upToYears: 15, rate: 0.65 },
    { upToYears: 20, rate: 0.70 },
    { upToYears: Infinity, rate: 0.80 },
  ],
  // Prime de bonne séparation (Art. 48) - nb de mois (plancher) par palier,
  // base = salaire catégoriel échelonné + prime d'ancienneté + sursalaire.
  bonneSeparation: [
    { upToYears: 3, months: 4 },
    { upToYears: 7, months: 7 },
    { upToYears: 10, months: 10 },
    { upToYears: Infinity, months: 12 },
  ],
  // Préavis (Art. 42) - durée en mois par collège (n° de catégorie).
  // 1-6 : ouvriers/employés ; 7-9 : agents de maîtrise ; 10-12 : cadres.
  preavisMonths: { ouvrier: 1, maitrise: 2, cadre: 3 },
  minSeniorityIndemnite: 1, // ancienneté minimale (années) pour licenciement / fin de carrière / décès
  inaptitudeMinYears: 2,    // Art. 42 al.2b
  inaptitudeMonths: 3,
  penaliteRetraitePct: 0.10, // Art. 46 §5 : majoration de 10 % si préavis d'un an non respecté
};

const r0 = (n) => Math.round(n || 0);

/** Cumul par tranche d'ancienneté : Σ (années dans la tranche × taux × réf). Fractions comptées. */
function yearsBracket(years, brackets, monthlyRef) {
  let total = 0, low = 0;
  for (const b of brackets) {
    if (years <= low) break;
    const span = Math.min(years, b.upToYears) - low;
    total += span * b.rate * monthlyRef;
    low = b.upToYears;
  }
  return total;
}
function monthsForYears(years, paliers) {
  for (const p of paliers) if (years <= p.upToYears) return p.months;
  return paliers.length ? paliers[paliers.length - 1].months : 0;
}
function collegeOf(category) {
  const n = parseInt(String(category || "").match(/\d+/)?.[0] || "0", 10);
  if (n >= 10) return "cadre";
  if (n >= 7) return "maitrise";
  return "ouvrier";
}

// Normalise l'étiquette de motif de rupture en clé interne.
function normalizeMotif(m) {
  const s = String(m || "").toLowerCase().trim();
  const keys = ["licenciement", "retraite", "deces", "separation_amiable", "demission", "inaptitude", "faute_lourde"];
  if (keys.includes(s)) return s; // clé transmise directement par l'interface
  if (/faute\s*[_ ]?\s*lourde/.test(s)) return "faute_lourde";
  if (/retrait|fin de carri/.test(s)) return "retraite";
  if (/d[ée]c[èe]s/.test(s)) return "deces";
  if (/inaptitud/.test(s)) return "inaptitude";
  if (/amiabl|s[ée]paration|n[ée]goci/.test(s)) return "separation_amiable";
  if (/d[ée]mission/.test(s)) return "demission";
  if (/licenci/.test(s)) return "licenciement";
  return "licenciement";
}
const MOTIFS = [
  { key: "licenciement", label: "Licenciement (hors faute lourde)" },
  { key: "retraite", label: "Départ à la retraite (fin de carrière)" },
  { key: "deces", label: "Décès du travailleur" },
  { key: "separation_amiable", label: "Séparation amiable négociée" },
  { key: "demission", label: "Démission" },
  { key: "inaptitude", label: "Inaptitude médicale" },
  { key: "faute_lourde", label: "Faute lourde" },
];

/**
 * @param input  { motif, category, seniorityYears, salaireCategoriel, primeAnciennete,
 *                 sursalaire, monthlyRef, leaveDays, dailyRate, preavisRespecte }
 * @param cfg    configuration de paie (lit cfg.rupture, sinon barème par défaut)
 */
function computeSolde(input, cfg) {
  const R = (cfg && cfg.rupture) ? Object.assign({}, DEFAULT_RUPTURE, cfg.rupture) : DEFAULT_RUPTURE;
  const {
    motif = "licenciement", category = "", seniorityYears = 0,
    salaireCategoriel = 0, primeAnciennete = 0, sursalaire = 0,
    leaveDays = 0, dailyRate = 0, preavisRespecte = true,
  } = input || {};
  const senMonthly = salaireCategoriel + primeAnciennete + (sursalaire || 0); // salaire catégoriel échelonné majoré
  const monthlyRef = Number(input.monthlyRef) > 0 ? Number(input.monthlyRef) : (salaireCategoriel + primeAnciennete);
  const m = normalizeMotif(motif);
  const lines = [];
  const push = (label, amount, note, article) => { const a = r0(amount); if (a) lines.push({ label, amount: a, note: note || "", article: article || "" }); };

  // 1) Indemnité compensatrice de congés payés - due dans tous les cas.
  if (leaveDays > 0 && dailyRate > 0)
    push("Indemnité compensatrice de congés payés", leaveDays * dailyRate,
      `${Math.round(leaveDays * 10) / 10} j × ${r0(dailyRate)} FCFA`, "Art. 63");

  const eligIndemnite = seniorityYears >= R.minSeniorityIndemnite;

  if (m === "licenciement") {
    const college = collegeOf(category);
    const pm = R.preavisMonths[college] || 1;
    push("Indemnité compensatrice de préavis", pm * senMonthly,
      `${pm} mois × ${r0(senMonthly)} (collège ${college}) - à corriger selon réglementation`, "Art. 42");
    if (eligIndemnite)
      push("Indemnité de licenciement", yearsBracket(seniorityYears, R.licenciement, monthlyRef),
        `${Math.round(seniorityYears * 10) / 10} ans sur salaire moyen ${r0(monthlyRef)}`, "Art. 45");
  } else if (m === "retraite") {
    let fc = yearsBracket(seniorityYears, R.finCarriere, monthlyRef);
    let note = `${Math.round(seniorityYears * 10) / 10} ans sur salaire moyen ${r0(monthlyRef)}`;
    if (!preavisRespecte) { fc *= (1 + R.penaliteRetraitePct); note += ` + pénalité ${Math.round(R.penaliteRetraitePct * 100)}% (préavis 1 an non respecté)`; }
    if (eligIndemnite) push("Indemnité de fin de carrière", fc, note, "Art. 46");
  } else if (m === "deces") {
    if (eligIndemnite)
      push("Indemnité de décès (= fin de carrière)", yearsBracket(seniorityYears, R.finCarriere, monthlyRef),
        `${Math.round(seniorityYears * 10) / 10} ans sur salaire moyen ${r0(monthlyRef)} - versée aux ayants droit`, "Art. 47");
  } else if (m === "separation_amiable") {
    if (eligIndemnite) {
      const mo = monthsForYears(seniorityYears, R.bonneSeparation);
      push("Prime de bonne séparation", mo * senMonthly,
        `${mo} mois (plancher) × ${r0(senMonthly)}`, "Art. 48");
    }
  } else if (m === "inaptitude") {
    if (seniorityYears >= R.inaptitudeMinYears)
      push("Indemnité d'inaptitude", R.inaptitudeMonths * senMonthly,
        `${R.inaptitudeMonths} mois de salaire catégoriel échelonné majoré`, "Art. 42 al.2b");
  }
  // démission / faute_lourde : aucune indemnité de rupture due par l'employeur (Art. 42 §2b).

  const total = lines.reduce((s, l) => s + l.amount, 0);
  return {
    motif: m,
    motifLabel: (MOTIFS.find(x => x.key === m) || {}).label || motif,
    college: collegeOf(category),
    seniorityYears: Math.round(seniorityYears * 100) / 100,
    monthlyRef: r0(monthlyRef),
    senMonthly: r0(senMonthly),
    lines,
    total: r0(total),
  };
}

module.exports = { computeSolde, DEFAULT_RUPTURE, MOTIFS, normalizeMotif, collegeOf };
