/**
 * SGRHP — Payroll calculation engine (Module Paie)
 * Cameroon statutory rules (CNPS, IRPP, CAC, CFC, FNE, RAV/CRTV, TDL).
 *
 * Pure & deterministic: no I/O, no DB. Takes an input + a config (rates/brackets,
 * all editable per tenant via the "caisses de cotisations" and "constantes" screens)
 * and returns a fully itemised payslip with the employee/employer split.
 *
 * Amounts are in XAF and rounded to whole francs (Cameroon has no centimes on payroll).
 */

"use strict";

/* -------------------------------------------------------------------------- */
/* Default Cameroon configuration (2025). Every value is overridable.          */
/* -------------------------------------------------------------------------- */
const DEFAULT_CONFIG = {
  currency: "XAF",
  standardMonthlyHours: 173.33,
  standardMonthlyDays: 30,

  // CNPS — monthly ceiling applies to PVID and PF (not RP).
  cnps: {
    ceiling: 750000,
    pvidEmployee: 0.042, // Pension Vieillesse Invalidité Décès — salarié
    pvidEmployer: 0.042, // employeur
    familyEmployer: 0.07, // Prestations familiales — employeur
    workAccidentEmployer: 0.0175, // Risques professionnels — employeur (classe A par défaut)
    workAccidentCeiling: 0, // 0 = no ceiling (RP is on full taxable salary)
  },

  // IRPP — computed annually on the net taxable, then divided by 12.
  // Base annuelle = (SBT − PVID salarié) × (1 − fraisProRate) × 12 − abattement.
  irpp: {
    fraisProRate: 0.30, // 30% abattement frais professionnels
    annualAbatement: 500000, // abattement forfaitaire annuel
    brackets: [
      { upTo: 2000000, rate: 0.10 },
      { upTo: 3000000, rate: 0.15 },
      { upTo: 5000000, rate: 0.25 },
      { upTo: Infinity, rate: 0.35 },
    ],
    cacRate: 0.10, // Centimes Additionnels Communaux = 10% de l'IRPP
  },

  // CFC — Crédit Foncier du Cameroun, on the taxable gross (SBT).
  cfc: { employee: 0.01, employer: 0.015 },

  // FNE — Fonds National de l'Emploi, employer only, on SBT.
  fne: { employer: 0.01 },

  // RAV — Redevance Audiovisuelle (CRTV), monthly flat amount by base-salary bracket.
  rav: [
    { upTo: 50000, amount: 0 },
    { upTo: 100000, amount: 750 },
    { upTo: 200000, amount: 1950 },
    { upTo: 300000, amount: 3250 },
    { upTo: 400000, amount: 4550 },
    { upTo: 500000, amount: 5850 },
    { upTo: 600000, amount: 7150 },
    { upTo: 700000, amount: 8450 },
    { upTo: 800000, amount: 9750 },
    { upTo: 900000, amount: 11050 },
    { upTo: 1000000, amount: 12350 },
    { upTo: Infinity, amount: 13000 },
  ],

  // TDL — Taxe de Développement Local, monthly flat amount by base-salary bracket.
  tdl: [
    { upTo: 62000, amount: 0 },
    { upTo: 75000, amount: 250 },
    { upTo: 100000, amount: 500 },
    { upTo: 125000, amount: 750 },
    { upTo: 150000, amount: 1000 },
    { upTo: 200000, amount: 1250 },
    { upTo: 250000, amount: 1500 },
    { upTo: 300000, amount: 2000 },
    { upTo: Infinity, amount: 3000 },
  ],

  // Overtime premiums (heures supplémentaires) — Cameroon labour code.
  overtime: {
    tier1Rate: 0.20, // 1st 8 hours: +20%
    tier2Rate: 0.30, // next 8 hours: +30%
    tier3Rate: 0.40, // beyond: +40%
    nightRate: 0.50, // night hours
    sundayHolidayRate: 0.40, // Sunday/holiday
  },

  // Seniority bonus (prime d'ancienneté) — % of base salary by years of service.
  // Cameroon convention: 2 years = 4%, then +1%/year (illustrative, editable).
  seniority: { startYears: 2, startRate: 0.04, perYearRate: 0.01, maxRate: 0.30 },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */
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
function bracketAmount(table, value) {
  for (const b of table) if (value <= b.upTo) return b.amount;
  return table.length ? table[table.length - 1].amount : 0;
}

/** Progressive tax on an annual taxable base (brackets are cumulative upper bounds). */
function progressive(base, brackets) {
  let tax = 0, low = 0;
  for (const b of brackets) {
    if (base <= low) break;
    const slice = Math.min(base, b.upTo) - low;
    if (slice > 0) tax += slice * b.rate;
    low = b.upTo;
  }
  return tax;
}

/** Seniority rate from hire date to the period. */
function seniorityRate(years, cfg) {
  const s = cfg.seniority;
  if (years < s.startYears) return 0;
  const rate = s.startRate + (years - s.startYears) * s.perYearRate;
  return Math.min(rate, s.maxRate);
}

/* -------------------------------------------------------------------------- */
/* Main: compute one payslip                                                   */
/* -------------------------------------------------------------------------- */
/**
 * @param {object} input
 *   baseSalary      monthly contractual base (XAF)
 *   workedDays      days actually worked in the period (default = standard)
 *   standardDays    reference days for proration (default cfg.standardMonthlyDays)
 *   seniorityYears  full years of service (for prime d'ancienneté)
 *   hourlyRate      optional; else derived from baseSalary / standardMonthlyHours
 *   overtime        { tier1, tier2, tier3, night, sundayHoliday } counts of hours
 *   gains           extra taxable gains: [{ code, label, amount, taxable=true }]
 *   nonTaxable      non-taxable allowances: [{ code, label, amount }]
 *   otherDeductions net deductions after tax: [{ code, label, amount }] (acomptes, prêts)
 * @param {object} configOverride  partial overrides merged onto DEFAULT_CONFIG
 * @returns {object} itemised payslip
 */
function computePayslip(input, configOverride) {
  const cfg = deepMerge(DEFAULT_CONFIG, configOverride);
  const {
    baseSalary = 0,
    workedDays = cfg.standardMonthlyDays,
    standardDays = cfg.standardMonthlyDays,
    seniorityYears = 0,
    overtime = {},
    gains = [],
    nonTaxable = [],
    otherDeductions = [],
  } = input || {};

  const hourlyRate = input.hourlyRate || (baseSalary / cfg.standardMonthlyHours);
  const lines = []; // { code, label, kind, base, rate, gain, retenue, employer }

  /* ---- 1. GAINS (brut) ------------------------------------------------- */
  const proratedBase = r0(baseSalary * (workedDays / standardDays));
  lines.push({ code: "1000", label: "Salaire de base", kind: "GAIN",
    base: baseSalary, rate: workedDays / standardDays, gain: proratedBase });

  // Seniority bonus
  const senRate = seniorityRate(seniorityYears, cfg);
  const seniority = r0(baseSalary * senRate);
  if (seniority > 0) lines.push({ code: "1040", label: "Prime d'ancienneté", kind: "GAIN",
    base: baseSalary, rate: senRate, gain: seniority });

  // Overtime
  const ot = overtime || {};
  const otLine = (hours, rate, code, label) => {
    if (!hours) return;
    const amt = r0(hours * hourlyRate * (1 + rate));
    lines.push({ code, label, kind: "GAIN", base: r0(hourlyRate), rate: 1 + rate, gain: amt, hours });
  };
  otLine(ot.tier1, cfg.overtime.tier1Rate, "1081", "Heures supp. (+20%)");
  otLine(ot.tier2, cfg.overtime.tier2Rate, "1082", "Heures supp. (+30%)");
  otLine(ot.tier3, cfg.overtime.tier3Rate, "1083", "Heures supp. (+40%)");
  otLine(ot.night, cfg.overtime.nightRate, "1084", "Heures de nuit (+50%)");
  otLine(ot.sundayHoliday, cfg.overtime.sundayHolidayRate, "1085", "Heures dim./férié (+40%)");

  // Extra taxable gains (primes)
  for (const g of gains) {
    if (!g || !g.amount) continue;
    lines.push({ code: g.code || "2000", label: g.label || "Prime", kind: "GAIN",
      base: g.amount, rate: 1, gain: r0(g.amount), taxable: g.taxable !== false });
  }
  // Non-taxable allowances (transport, panier…) — paid but not in taxable base
  for (const n of nonTaxable) {
    if (!n || !n.amount) continue;
    lines.push({ code: n.code || "3000", label: n.label || "Indemnité non imposable", kind: "GAIN_NT",
      base: n.amount, rate: 1, gain: r0(n.amount), taxable: false });
  }

  // Salaire Brut Taxable (SBT) = taxable gains only
  const SBT = lines.filter(l => l.kind === "GAIN" && l.taxable !== false)
    .reduce((s, l) => s + l.gain, 0);
  const grossTotal = lines.filter(l => l.kind === "GAIN" || l.kind === "GAIN_NT")
    .reduce((s, l) => s + l.gain, 0);

  /* ---- 2. COTISATIONS SOCIALES (CNPS) ---------------------------------- */
  const cnpsBase = Math.min(SBT, cfg.cnps.ceiling);
  const rpBase = cfg.cnps.workAccidentCeiling > 0 ? Math.min(SBT, cfg.cnps.workAccidentCeiling) : SBT;

  const pvidEmp = r0(cnpsBase * cfg.cnps.pvidEmployee);
  const pvidPat = r0(cnpsBase * cfg.cnps.pvidEmployer);
  const pfPat = r0(cnpsBase * cfg.cnps.familyEmployer);
  const rpPat = r0(rpBase * cfg.cnps.workAccidentEmployer);

  lines.push({ code: "5000", label: "CNPS Pension (PVID)", kind: "COTIS",
    base: cnpsBase, rate: cfg.cnps.pvidEmployee, retenue: pvidEmp,
    employerRate: cfg.cnps.pvidEmployer, employer: pvidPat });
  lines.push({ code: "5010", label: "CNPS Prestations familiales", kind: "COTIS",
    base: cnpsBase, rate: 0, retenue: 0, employerRate: cfg.cnps.familyEmployer, employer: pfPat });
  lines.push({ code: "5020", label: "CNPS Risques professionnels", kind: "COTIS",
    base: rpBase, rate: 0, retenue: 0, employerRate: cfg.cnps.workAccidentEmployer, employer: rpPat });

  /* ---- 3. IMPÔTS & RETENUES FISCALES ----------------------------------- */
  // IRPP annual base = (SBT − PVID salarié) × (1 − fraisPro) × 12 − abattement
  const monthlyNetForTax = Math.max(0, SBT - pvidEmp);
  const annualBase = Math.max(0, monthlyNetForTax * (1 - cfg.irpp.fraisProRate) * 12 - cfg.irpp.annualAbatement);
  const irppAnnual = progressive(annualBase, cfg.irpp.brackets);
  const irpp = r0(irppAnnual / 12);
  const cac = r0(irpp * cfg.irpp.cacRate);

  const cfcEmp = r0(SBT * cfg.cfc.employee);
  const cfcPat = r0(SBT * cfg.cfc.employer);
  const fnePat = r0(SBT * cfg.fne.employer);
  const rav = bracketAmount(cfg.rav, baseSalary);
  const tdl = bracketAmount(cfg.tdl, baseSalary);

  lines.push({ code: "6000", label: "IRPP", kind: "IMPOT", base: r0(annualBase / 12), rate: 0, retenue: irpp });
  lines.push({ code: "6010", label: "CAC (10% IRPP)", kind: "IMPOT", base: irpp, rate: cfg.irpp.cacRate, retenue: cac });
  lines.push({ code: "5050", label: "Crédit Foncier (CFC)", kind: "IMPOT",
    base: SBT, rate: cfg.cfc.employee, retenue: cfcEmp, employerRate: cfg.cfc.employer, employer: cfcPat });
  lines.push({ code: "5070", label: "FNE", kind: "IMPOT", base: SBT, rate: 0, retenue: 0, employerRate: cfg.fne.employer, employer: fnePat });
  lines.push({ code: "5080", label: "Redevance audiovisuelle (RAV)", kind: "IMPOT", base: baseSalary, rate: 0, retenue: rav });
  lines.push({ code: "5090", label: "Taxe communale (TDL)", kind: "IMPOT", base: baseSalary, rate: 0, retenue: tdl });

  /* ---- 4. AUTRES RETENUES (acomptes, prêts) ---------------------------- */
  for (const d of otherDeductions) {
    if (!d || !d.amount) continue;
    lines.push({ code: d.code || "7000", label: d.label || "Retenue", kind: "RETENUE", base: d.amount, rate: 1, retenue: r0(d.amount) });
  }

  /* ---- 5. TOTAUX ------------------------------------------------------- */
  const totalEmployeeContrib = pvidEmp; // social employee
  const totalTax = irpp + cac + cfcEmp + rav + tdl;
  const totalOtherDeductions = otherDeductions.reduce((s, d) => s + r0(d && d.amount), 0);
  const totalRetenues = totalEmployeeContrib + totalTax + totalOtherDeductions;

  const netAPayer = grossTotal - totalRetenues;

  const employerCharges = pvidPat + pfPat + rpPat + cfcPat + fnePat;
  const totalCost = grossTotal + employerCharges;

  return {
    currency: cfg.currency,
    lines,
    totals: {
      salaireBrutTaxable: SBT,
      brutTotal: grossTotal,
      cnpsSalarie: totalEmployeeContrib,
      irpp, cac, cfcSalarie: cfcEmp, rav, tdl,
      totalImpots: totalTax,
      autresRetenues: totalOtherDeductions,
      totalRetenues,
      netAPayer: netAPayer,
      // employer side
      cnpsPatronal: pvidPat + pfPat + rpPat,
      cfcPatronal: cfcPat,
      fnePatronal: fnePat,
      chargesPatronales: employerCharges,
      coutTotalEmployeur: totalCost,
    },
    meta: { seniorityRate: senRate, proratedBase, hourlyRate: r0(hourlyRate), cnpsBase, annualTaxBase: r0(annualBase) },
  };
}

module.exports = { computePayslip, DEFAULT_CONFIG, progressive, bracketAmount, seniorityRate };
