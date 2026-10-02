/**
 * SGRHP - Payroll engine v2 (Module Paie) - Cameroon, calibrated from Sage Paie i7.
 *
 * Named-base model (reproduces the CIBLE ENERGIE bulletin):
 *   BRUT     = Σ all gains
 *   NETCOTI  = Σ gains flagged `cnps`  (base cotisable CNPS - PVID/PF/RP)
 *   NETIMPO  = Σ gains flagged `impo`  (base imposable - IRPP, RAV, TDL)  minus exemption caps
 *   BASECF   = round(NETIMPO, 1000)    (base Crédit Foncier)
 *
 * Every rate/bracket is editable per tenant (values below are the Sage-extracted defaults).
 * Validated line-by-line against the ZANG ROMEO payslip (sept-2025).
 */
"use strict";

const DEFAULT_CONFIG = {
  currency: "XAF",
  standardMonthlyHours: 173.33,
  standardMonthlyDays: 30,

  cnps: {
    ceiling: 750000,          // PLAFOND (CNPS monthly ceiling)
    pvidEmployee: 0.042,      // 5000 PENSION VIEILLESSE - salarié
    pvidEmployer: 0.042,      //                          - employeur
    familyEmployer: 0.07,     // 5010 ALLOCATIONS FAMILIALES - employeur
    workAccidentEmployer: 0.025, // 5020 ACCIDENT DE TRAVAIL - employeur (classe société)
    accidentCeiling: null,    // Plafond assiette ACCIDENT DE TRAVAIL : null/vide = SANS plafond
                              // (confirme par DIPE reel : AT sur salaire total, PVID/AF plafonnes a 750000)
  },

  cfc: { employee: 0.01, employer: 0.015 }, // 5050/5060 Crédit Foncier
  fne: { employer: 0.01 },                  // 5070 FNE (base BRUT)

  // IRPP - SNI = fraisProRate × NETIMPO − PVID − (annualAbatement/12) ; progressive ; CAC = cacRate × IRPP
  // (validated against ZANG payslip: NETIMPO 396 211 → IRPP 24 602)
  irpp: {
    fraisProRate: 0.70,       // abattement 30% frais professionnels
    annualAbatement: 500000,  // abattement forfaitaire annuel (÷12 par mois)
    deductPvid: true,         // SNI net of the employee CNPS (PVID)
    brackets: [               // monthly equivalents of the annual 2M/3M/5M bands
      { upTo: 166667, rate: 0.10 },
      { upTo: 250000, rate: 0.15 },
      { upTo: 416667, rate: 0.25 },
      { upTo: 1e12, rate: 0.35 },
    ],
    cacRate: 0.10,            // 5045 CAC = 10% de l'IRPP
  },

  // Transport allowance exemption cap (excess is added to NETIMPO). Editable.
  transportExemptionCap: 14500, // Exonération IRPP de la prime de transport (F/mois). La prime de transport est déjà hors assiette CNPS ; seule la fraction au-delà de ce plafond est imposable à l'IRPP.

  // Avantages en nature au forfait - Article 33 du CGI (Cameroun). Taux forfaitaires appliqués au
  // SALAIRE BRUT TAXABLE EN ESPÈCES. Un avantage fourni sans montant explicite mais avec un `type`
  // ci-dessous est évalué = taux × base taxable × quantité. Imposable à l'IRPP ; hors assiette CNPS
  // par défaut (les avantages en nature n'entrent pas dans l'assiette des cotisations). Éditable
  // dans Paramètres paie > Barèmes & taux.
  avantagesNature: {
    logement: 0.15,     // Logement
    electricite: 0.04,  // Électricité
    eau: 0.02,          // Eau
    vehicule: 0.10,     // Véhicule (par véhicule)
    nourriture: 0.10,   // Nourriture
    domestique: 0.05,   // Gardien / domestique (par personne)
    telephone: 0.05,    // Téléphone
  },

  // Plafonnement de la fraction IMPOSABLE de l'indemnité de logement (Art. 33 CGI) : la part
  // imposable à l'IRPP est limitée à taxableCapRate × salaire de base (proratisé) ; l'excédent
  // reste au BRUT/NET mais sort de la base IRPP. `code` = rubrique d'indemnité de logement. Éditable.
  housing: { code: "3510", taxableCapRate: 0.15 },

  // RAV - Redevance audiovisuelle (^^CRTV), monthly amount by bracket on SALBASE
  rav: [
    { upTo: 50000, amount: 0 }, { upTo: 100000, amount: 750 }, { upTo: 200000, amount: 1950 },
    { upTo: 300000, amount: 3250 }, { upTo: 400000, amount: 4550 }, { upTo: 500000, amount: 5850 },
    { upTo: 600000, amount: 7150 }, { upTo: 700000, amount: 8450 }, { upTo: 800000, amount: 9750 },
    { upTo: 900000, amount: 11050 }, { upTo: 1000000, amount: 12350 }, { upTo: 1e12, amount: 13000 },
  ],
  // TDL - Taxe communale (^^TAXCOM), by bracket on SALBASE
  tdl: [
    { upTo: 62000, amount: 0 }, { upTo: 75000, amount: 250 }, { upTo: 100000, amount: 500 },
    { upTo: 125000, amount: 750 }, { upTo: 150000, amount: 1000 }, { upTo: 200000, amount: 1250 },
    { upTo: 250000, amount: 1500 }, { upTo: 300000, amount: 2000 }, { upTo: 1e12, amount: 2250 },
  ],

  overtime: { tier1Rate: 0.20, tier2Rate: 0.30, tier3Rate: 0.40, nightRate: 0.50, hundredRate: 1.00 },
  // Seniority (^^ANCTAUX): 4% at 2 years, +2%/year, capped.
  seniority: { startYears: 2, startRate: 0.04, perYearRate: 0.02, maxRate: 1.0 }, // Code du travail : 4% à 2 ans, +2%/an, sans plafond conventionnel
  leave: {
    daysPerMonth: 2.5, // CONGE1 - provision comptable (jours calendaires) / mois
    ouvrablePerMonth: 2, baseAnnual: 24, // Art. 63.1 : 2 jours ouvrables / mois = 24 / an
    // Allocation de congé = rémunération de la période de référence / allocationDivisor.
    // 16 pour 18 j/an (1,5/mois) ; 12 pour 24 j/an (2/mois) ; ~9,6 (48/5) pour 30 j/an. Selon convention.
    allocationDivisor: 12,
    provisionDivisor: 30, // base congé quotidienne (provision) = SBM / provisionDivisor
    // Art. 63.5 : majoration d'ancienneté (jours ouvrables ajoutés au congé annuel)
    seniorityMajoration: [
      { upToYears: 5, days: 0 }, { upToYears: 10, days: 3 }, { upToYears: 15, days: 6 },
      { upToYears: 19, days: 9 }, { upToYears: 23, days: 12 }, { upToYears: 27, days: 15 },
      { upToYears: 31, days: 18 }, { upToYears: 35, days: 21 }, { upToYears: 39, days: 24 },
      { upToYears: 43, days: 27 }, { upToYears: 1e9, days: 30 },
    ],
    // Art. 64 : permissions exceptionnelles d'absence payées (jours de travail effectif)
    permissions: [
      { key: "mariage_travailleur", label: "Mariage du travailleur", days: 4 },
      { key: "accouchement_epouse", label: "Accouchement de l'épouse", days: 3 },
      { key: "bapteme_enfant", label: "Baptême d'un enfant", days: 1 },
      { key: "mariage_enfant", label: "Mariage d'un enfant", days: 2 },
      { key: "deces_conjoint", label: "Décès du conjoint", days: 5 },
      { key: "deces_enfant", label: "Décès d'un enfant", days: 3 },
      { key: "deces_pere_mere", label: "Décès du père ou de la mère", days: 5 },
      { key: "deces_pere_mere_conjoint", label: "Décès du père ou de la mère du conjoint légitime", days: 3 },
      { key: "deces_frere_soeur", label: "Décès du frère ou de la sœur", days: 3 },
    ],
    permissionsCapDays: 12, // Art. 64.2 : plafond 12 j ouvrables / année calendaire
  },
  legal: { transportPerDay: 1300, caissePrincipal: 33000, caisseSecondaire: 26000, logementPct: 0.40 }, // CCN Commerce (Art. 74, 78, 81)
  // Barème de rupture / solde de tout compte (CCN Commerce Art. 42/45/46/47/48).
  rupture: {
    licenciement: [ { upToYears: 5, rate: 0.30 }, { upToYears: 10, rate: 0.35 }, { upToYears: 15, rate: 0.45 }, { upToYears: 20, rate: 0.50 }, { upToYears: 1e9, rate: 0.55 } ],
    finCarriere: [ { upToYears: 5, rate: 0.45 }, { upToYears: 10, rate: 0.50 }, { upToYears: 15, rate: 0.65 }, { upToYears: 20, rate: 0.70 }, { upToYears: 1e9, rate: 0.80 } ],
    bonneSeparation: [ { upToYears: 3, months: 4 }, { upToYears: 7, months: 7 }, { upToYears: 10, months: 10 }, { upToYears: 1e9, months: 12 } ],
    preavisMonths: { ouvrier: 1, maitrise: 2, cadre: 3 },
    minSeniorityIndemnite: 1, inaptitudeMinYears: 2, inaptitudeMonths: 3, penaliteRetraitePct: 0.10,
  },
};

const r0 = (n) => Math.round(n || 0);
function deepMerge(base, over) {
  if (!over) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    if (Array.isArray(over[k])) out[k] = over[k];
    else if (over[k] && typeof over[k] === "object") out[k] = deepMerge(base[k] || {}, over[k]);
    else out[k] = over[k];
  }
  return out;
}
function bracketAmount(table, v) { for (const b of table) if (v <= b.upTo) return b.amount; return table.length ? table[table.length - 1].amount : 0; }
function progressive(base, brackets) {
  let tax = 0, low = 0;
  for (const b of brackets) { if (base <= low) break; tax += (Math.min(base, b.upTo) - low) * b.rate; low = b.upTo; }
  return tax;
}
function seniorityRate(years, cfg) {
  const s = cfg.seniority; if (years < s.startYears) return 0;
  return Math.min(s.startRate + (years - s.startYears) * s.perYearRate, s.maxRate);
}

/**
 * @param input
 *   baseSalary, workedDays, standardDays, seniorityYears, hourlyRate, overtime{tier1..}
 *   gains: [{ code,label,amount, cnps=true, impo=true }]   taxable/cotisable gains
 *   nonTaxable: [{ code,label,amount }]                    paid, excluded from NETCOTI & NETIMPO
 *   transport: { code,label,amount }                       transport allowance (exemption cap applies)
 *   otherDeductions: [{ code,label,amount }]               acomptes/prêts (after net)
 *   ravBase / tdlBase: optional override of the bracket key (defaults to baseSalary)
 */
function computePayslip(input, configOverride) {
  const cfg = deepMerge(DEFAULT_CONFIG, configOverride);
  const {
    baseSalary = 0, workedDays = cfg.standardMonthlyDays, standardDays = cfg.standardMonthlyDays,
    seniorityYears = 0, overtime = {}, gains = [], nonTaxable = [], transport = null, otherDeductions = [],
  } = input || {};
  const hourlyRate = input.hourlyRate || (baseSalary / cfg.standardMonthlyHours);
  const lines = [];
  const add = (o) => { lines.push(o); return o; };

  /* 1) GAINS */
  const proratedBase = r0(baseSalary * (workedDays / standardDays));
  const dailyRate = standardDays ? baseSalary / standardDays : baseSalary;
  const PRORATA = (standardDays && workedDays < standardDays) ? workedDays / standardDays : 1;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  add({ code: "1000", label: "Salaire de base", kind: "GAIN", nombre: workedDays, base: Math.round(dailyRate * 100) / 100, rate: 1, gain: proratedBase, cnps: true, impo: true });
  const senR = seniorityRate(seniorityYears, cfg);
  // Prime d'ancienneté = taux × salaire minimum de la catégorie (1er échelon / échelon A), et non le salaire de l'échelon courant (Arrêté n°019 MTPS 1993).
  const _anBase = (input.ancienneteBase != null && Number(input.ancienneteBase) > 0) ? Number(input.ancienneteBase) : baseSalary;
  if (senR > 0) add({ code: "1040", label: "Prime d'ancienneté", kind: "GAIN", base: _anBase, rate: senR, gain: r0(_anBase * senR), cnps: true, impo: true });
  const ot = overtime || {};
  // Codes Sage (vérifiés sur bulletins réels) : +20%=1083, +30%=1088, +40%=1092, +50%=1096, +100%=2000.
  // Le libellé et le taux affiché suivent le taux réel configuré (ex. SIC CACAO : +25% -> "125%").
  const otL = (h, rate, code) => { if (h) { const mult = 1 + rate; add({ code, label: "Heures supp. " + Math.round(mult * 100) + "%", kind: "GAIN", nombre: h, base: Math.round(hourlyRate * 100) / 100, rate: mult, taux: Math.round(mult * 100), gain: r0(h * hourlyRate * mult), hours: h, cnps: true, impo: true }); } };
  const _otc = cfg.overtime || {};
  otL(ot.tier1, _otc.tier1Rate != null ? _otc.tier1Rate : 0.20, "1083");
  otL(ot.tier2, _otc.tier2Rate != null ? _otc.tier2Rate : 0.30, "1088");
  otL(ot.tier3, _otc.tier3Rate != null ? _otc.tier3Rate : 0.40, "1092");
  otL(ot.night, _otc.nightRate != null ? _otc.nightRate : 0.50, "1096");
  otL(ot.hundred, _otc.hundredRate != null ? _otc.hundredRate : 1.00, "2000");
  // Affichage des lignes proratisées : Nombre = ratio de présence (ex. 26/30 = 0,867) et Base = montant
  // mensuel plein — comme avant. Le montant (gain) reste inchangé = Base × ratio.
  for (const g of gains) if (g && g.amount) {
    const doPr = !!(g.prorate && PRORATA < 1); const pr = doPr ? PRORATA : 1;
    add({ code: g.code || "2000", label: g.label || "Prime", kind: "GAIN",
      nombre: doPr ? r3(pr) : 1, base: g.amount, rate: 1,
      gain: r0(g.amount * pr), cnps: g.cnps !== false, impo: g.impo !== false });
  }
  for (const n of nonTaxable) if (n && n.amount) {
    const doPr = !!(n.prorate && PRORATA < 1); const pr = doPr ? PRORATA : 1;
    add({ code: n.code || "3000", label: n.label || "Indemnité", kind: "GAIN",
      nombre: doPr ? r3(pr) : 1, base: n.amount, rate: 1,
      gain: r0(n.amount * pr), cnps: false, impo: false });
  }

  // Transport allowance with exemption cap: excess over cap is imposable (never cotisable)
  let transportTaxable = 0;
  if (transport && transport.amount) {
    const fullAmt = r0(transport.amount);
    const pr = (transport.prorate && PRORATA < 1) ? PRORATA : 1;
    const amt = r0(fullAmt * pr);
    transportTaxable = Math.max(0, amt - (cfg.transportExemptionCap || 0));
    const _tpr = (transport.prorate && PRORATA < 1); add({ code: transport.code || "3513", label: transport.label || "Indemnité de transport", kind: "GAIN", nombre: _tpr ? r3(pr) : 1, base: fullAmt, rate: 1, gain: amt, cnps: false, impo: false, _transportTaxable: transportTaxable });
  }

  // ===== Fractions imposable / cotisable PAR RUBRIQUE (avantages) =====
  // Une rubrique "liée" (configurée dans avantagesNatureList avec un rubriqueCode) n'entre dans
  // l'assiette IRPP qu'à hauteur de impoRate × son montant, et dans l'assiette CNPS qu'à hauteur
  // de cnpsRate × son montant. Ces taux GOUVERNENT (ils remplacent les cases Soumis IRPP/CNPS).
  // Les rubriques NON liées gardent le tout-ou-rien selon leurs drapeaux. RIEN n'est ajouté au
  // BRUT ni au NET, et AUCUNE ligne "avantage" n'est créée : seules les assiettes changent.
  // La fraction s'applique au montant APRÈS proratisation (= le gain de la ligne).
  // ===== Avantages en nature : évaluation forfaitaire (Art. 33 CGI / modèle DIPE) =====
  // Une rubrique "avantage" (liée, avec un taux) est imposable à hauteur de
  //   MIN( taux × BASE100 , montant de la rubrique )
  // où BASE100 = somme des gains PLEINEMENT imposables (100 %), hors avantages et hors
  // éléments non imposables. Le montant total reste payé (brut/net inchangés) ; aucune ligne
  // n'est ajoutée. La CNPS reste sur les MONTANTS COMPLETS (drapeau cnps de la rubrique).
  const avMap = {}; // rubriqueCode -> taux forfaitaire
  for (const a of (cfg.avantagesNatureList || [])) {
    if (a.active === false || !a.rubriqueCode) continue;
    avMap[String(a.rubriqueCode)] = Number(a.rate != null ? a.rate : (a.impoRate != null ? a.impoRate : 0));
  }
  const avTotal = 0; // compat : plus d'avantages en ligne sur le bulletin

  /* 2) NAMED BASES */
  const BRUT = lines.filter(l => l.kind === "GAIN").reduce((s, l) => s + l.gain, 0);
  // CNPS : montants complets selon le drapeau cnps de chaque rubrique (les avantages y entrent en entier s'ils sont cnps).
  const NETCOTI = lines.filter(l => l.kind === "GAIN" && l.cnps).reduce((s, l) => s + l.gain, 0);
  // BASE100 = assiette 100 % imposable (gains imposables NON-avantages) + fraction imposable du transport.
  const BASE100 = lines.filter(l => l.kind === "GAIN" && l.impo && avMap[String(l.code)] == null).reduce((s, l) => s + l.gain, 0) + transportTaxable;
  const NETIMPO = lines.filter(l => l.kind === "GAIN").reduce((s, l) => {
    const rate = avMap[String(l.code)];
    if (rate != null) { const taxable = Math.min(r0(rate * BASE100), l.gain); l._impoPart = taxable; l._impoExcluded = r0(l.gain - taxable); return s + taxable; }
    return s + (l.impo ? l.gain : 0);
  }, 0) + transportTaxable;
  // Surcharges manuelles par bulletin (cas d'une config Sage non standard) : si fournies, elles
  // remplacent l'assiette calculee. Laisser vide pour le comportement legal par defaut.
  const NETCOTI_EFF = (input.cnpsBaseOverride != null && input.cnpsBaseOverride !== "") ? Number(input.cnpsBaseOverride) : NETCOTI;
  const NETIMPO_EFF = (input.taxableBaseOverride != null && input.taxableBaseOverride !== "") ? Number(input.taxableBaseOverride) : NETIMPO;
  const BASECF = Math.round(NETIMPO_EFF / 1000) * 1000;
  const cnpsBase = Math.min(NETCOTI_EFF, cfg.cnps.ceiling); // PVID & prestations familiales : plafonnees
  // Accident de travail (risques pro) : assiette SANS plafond par defaut (confirme par DIPE reel).
  // Un plafond AT distinct est configurable (cfg.cnps.accidentCeiling) ; vide/null = non plafonne.
  const _atCeiling = (cfg.cnps.accidentCeiling != null && cfg.cnps.accidentCeiling !== "" && Number(cfg.cnps.accidentCeiling) > 0) ? Number(cfg.cnps.accidentCeiling) : Infinity;
  const atBase = (input.atBaseOverride != null && input.atBaseOverride !== "") ? Number(input.atBaseOverride) : Math.min(NETCOTI_EFF, _atCeiling);

  /* 3) COTISATIONS CNPS */
  const pvidE = r0(cnpsBase * cfg.cnps.pvidEmployee), pvidP = r0(cnpsBase * cfg.cnps.pvidEmployer);
  const pfP = r0(cnpsBase * cfg.cnps.familyEmployer), rpP = r0(atBase * cfg.cnps.workAccidentEmployer);
  add({ code: "5000", label: "CNPS Pension (PVID)", kind: "COTIS", base: cnpsBase, rate: cfg.cnps.pvidEmployee, retenue: pvidE, employerRate: cfg.cnps.pvidEmployer, employer: pvidP });
  add({ code: "5010", label: "CNPS Prestations familiales", kind: "COTIS", base: cnpsBase, rate: 0, retenue: 0, employerRate: cfg.cnps.familyEmployer, employer: pfP });
  add({ code: "5020", label: "CNPS Accident de travail", kind: "COTIS", base: atBase, rate: 0, retenue: 0, employerRate: cfg.cnps.workAccidentEmployer, employer: rpP });

  /* 4) IMPÔTS */
  const sni = Math.max(0, NETIMPO_EFF * cfg.irpp.fraisProRate
    - (cfg.irpp.deductPvid ? pvidE : 0)
    - (cfg.irpp.annualAbatement || 0) / 12);
  const irpp = r0(progressive(sni, cfg.irpp.brackets));
  const cac = r0(irpp * cfg.irpp.cacRate);
  const cfcE = r0(BASECF * cfg.cfc.employee), cfcP = r0(BRUT * cfg.cfc.employer), fneP = r0(BRUT * cfg.fne.employer);
  const ravBase = input.ravBase != null ? input.ravBase : BRUT;      // ^^CRTV keyed on BRUT
  const tdlBase = input.tdlBase != null ? input.tdlBase : baseSalary; // ^^TAXCOM keyed on SALBASE
  const rav = bracketAmount(cfg.rav, ravBase), tdl = bracketAmount(cfg.tdl, tdlBase);
  add({ code: "5025", label: "IRPP", kind: "IMPOT", base: null, rate: 0, retenue: irpp }); // IRPP = bareme par tranche : base et taux non affiches (comme Sage)
  add({ code: "5045", label: "CAC (10% IRPP)", kind: "IMPOT", base: irpp, rate: cfg.irpp.cacRate, retenue: cac });
  add({ code: "5050", label: "Crédit Foncier (CFC)", kind: "IMPOT", base: BASECF, rate: cfg.cfc.employee, retenue: cfcE, employerRate: cfg.cfc.employer, employer: cfcP });
  add({ code: "5070", label: "FNE", kind: "IMPOT", base: BRUT, rate: 0, retenue: 0, employerRate: cfg.fne.employer, employer: fneP });
  add({ code: "5080", label: "Redevance audiovisuelle (RAV)", kind: "IMPOT", base: ravBase, rate: 0, retenue: rav });
  add({ code: "5090", label: "Taxe communale (TDL)", kind: "IMPOT", base: tdlBase, rate: 0, retenue: tdl });

  for (const d of otherDeductions) if (d && d.amount) add({ code: d.code || "7000", label: d.label || "Retenue", kind: "RETENUE", base: d.amount, rate: 1, retenue: r0(d.amount) });

  /* 5) TOTAUX */
  const totalImpots = irpp + cac + cfcE + rav + tdl;
  const autres = otherDeductions.reduce((s, d) => s + r0(d && d.amount), 0);
  const totalRetenues = pvidE + totalImpots + autres;
  const chargesPat = pvidP + pfP + rpP + cfcP + fneP;

  return {
    currency: cfg.currency, lines,
    totals: {
      brutTotal: BRUT, netCotisable: NETCOTI_EFF, netImposable: NETIMPO_EFF, baseCF: BASECF,
      cnpsSalarie: pvidE, irpp, cac, cfcSalarie: cfcE, rav, tdl,
      totalImpots, autresRetenues: autres, totalRetenues, netAPayer: BRUT - totalRetenues, avantagesNature: avTotal,
      cnpsPatronal: pvidP + pfP + rpP, cfcPatronal: cfcP, fnePatronal: fneP,
      chargesPatronales: chargesPat, coutTotalEmployeur: BRUT + chargesPat,
    },
    meta: { seniorityRate: senR, proratedBase, baseSalary, tdlBase, hourlyRate: r0(hourlyRate), cnpsBase, sni: r0(sni), workedDays, standardDays,
      leaveAccrued: cfg.leave.daysPerMonth,
      leaveDailyRate: r0(baseSalary / (cfg.standardMonthlyDays || 30)),
      leaveProvisionMonthly: r0((baseSalary / (cfg.standardMonthlyDays || 30)) * cfg.leave.daysPerMonth) },
  };
}

function leaveMajoration(years, cfg) {
  const tbl = ((cfg && cfg.leave && cfg.leave.seniorityMajoration) || DEFAULT_CONFIG.leave.seniorityMajoration);
  for (const b of tbl) if (years < b.upToYears) return b.days;
  return tbl.length ? tbl[tbl.length - 1].days : 0;
}
module.exports = { computePayslip, DEFAULT_CONFIG, progressive, bracketAmount, seniorityRate, leaveMajoration };
