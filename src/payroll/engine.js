/**
 * SGRHP — Payroll engine v2 (Module Paie) — Cameroon, calibrated from Sage Paie i7.
 *
 * Named-base model (reproduces the CIBLE ENERGIE bulletin):
 *   BRUT     = Σ all gains
 *   NETCOTI  = Σ gains flagged `cnps`  (base cotisable CNPS — PVID/PF/RP)
 *   NETIMPO  = Σ gains flagged `impo`  (base imposable — IRPP, RAV, TDL)  minus exemption caps
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
    pvidEmployee: 0.042,      // 5000 PENSION VIEILLESSE — salarié
    pvidEmployer: 0.042,      //                          — employeur
    familyEmployer: 0.07,     // 5010 ALLOCATIONS FAMILIALES — employeur
    workAccidentEmployer: 0.025, // 5020 ACCIDENT DE TRAVAIL — employeur (classe société)
  },

  cfc: { employee: 0.01, employer: 0.015 }, // 5050/5060 Crédit Foncier
  fne: { employer: 0.01 },                  // 5070 FNE (base BRUT)

  // IRPP — SNI = fraisProRate × NETIMPO − PVID − (annualAbatement/12) ; progressive ; CAC = cacRate × IRPP
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
  transportExemptionCap: 0,

  // RAV — Redevance audiovisuelle (^^CRTV), monthly amount by bracket on SALBASE
  rav: [
    { upTo: 50000, amount: 0 }, { upTo: 100000, amount: 750 }, { upTo: 200000, amount: 1950 },
    { upTo: 300000, amount: 3250 }, { upTo: 400000, amount: 4550 }, { upTo: 500000, amount: 5850 },
    { upTo: 600000, amount: 7150 }, { upTo: 700000, amount: 8450 }, { upTo: 800000, amount: 9750 },
    { upTo: 900000, amount: 11050 }, { upTo: 1000000, amount: 12350 }, { upTo: 1e12, amount: 13000 },
  ],
  // TDL — Taxe communale (^^TAXCOM), by bracket on SALBASE
  tdl: [
    { upTo: 62000, amount: 0 }, { upTo: 75000, amount: 250 }, { upTo: 100000, amount: 500 },
    { upTo: 125000, amount: 750 }, { upTo: 150000, amount: 1000 }, { upTo: 200000, amount: 1250 },
    { upTo: 250000, amount: 1500 }, { upTo: 300000, amount: 2000 }, { upTo: 1e12, amount: 2250 },
  ],

  overtime: { tier1Rate: 0.20, tier2Rate: 0.30, tier3Rate: 0.40, nightRate: 0.50 },
  // Seniority (^^ANCTAUX): 4% at 2 years, +2%/year, capped.
  seniority: { startYears: 2, startRate: 0.04, perYearRate: 0.02, maxRate: 0.30 },
  leave: { daysPerMonth: 2.5 }, // CONGE1 — congés acquis / mois
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
  add({ code: "1000", label: "Salaire de base", kind: "GAIN", base: baseSalary, rate: workedDays / standardDays, gain: proratedBase, cnps: true, impo: true });
  const senR = seniorityRate(seniorityYears, cfg);
  if (senR > 0) add({ code: "1040", label: "Prime d'ancienneté", kind: "GAIN", base: baseSalary, rate: senR, gain: r0(baseSalary * senR), cnps: true, impo: true });
  const ot = overtime || {};
  const otL = (h, rate, code, label) => { if (h) add({ code, label, kind: "GAIN", base: r0(hourlyRate), rate: 1 + rate, gain: r0(h * hourlyRate * (1 + rate)), hours: h, cnps: true, impo: true }); };
  otL(ot.tier1, cfg.overtime.tier1Rate, "1081", "Heures supp. (+20%)");
  otL(ot.tier2, cfg.overtime.tier2Rate, "1082", "Heures supp. (+30%)");
  otL(ot.tier3, cfg.overtime.tier3Rate, "1083", "Heures supp. (+40%)");
  otL(ot.night, cfg.overtime.nightRate, "1084", "Heures de nuit (+50%)");
  for (const g of gains) if (g && g.amount) add({ code: g.code || "2000", label: g.label || "Prime", kind: "GAIN", base: g.amount, rate: 1, gain: r0(g.amount), cnps: g.cnps !== false, impo: g.impo !== false });
  for (const n of nonTaxable) if (n && n.amount) add({ code: n.code || "3000", label: n.label || "Indemnité", kind: "GAIN", base: n.amount, rate: 1, gain: r0(n.amount), cnps: false, impo: false });

  // Transport allowance with exemption cap: excess over cap is imposable (never cotisable)
  let transportTaxable = 0;
  if (transport && transport.amount) {
    const amt = r0(transport.amount);
    transportTaxable = Math.max(0, amt - (cfg.transportExemptionCap || 0));
    add({ code: transport.code || "3513", label: transport.label || "Indemnité de transport", kind: "GAIN", base: amt, rate: 1, gain: amt, cnps: false, impo: false, _transportTaxable: transportTaxable });
  }

  // Avantages en nature: valued benefit — taxable (and optionally cotisable) but NOT
  // paid in cash. Increases NETIMPO/NETCOTI (so IRPP/CNPS rise) without touching brut/net.
  const avantages = input.avantages || input.nonCashBenefits || [];
  let avTotal = 0, avImpo = 0, avCnps = 0;
  for (const a of avantages) {
    if (!a || !a.amount) continue;
    const amt = r0(a.amount);
    add({ code: a.code || "4000", label: a.label || "Avantage en nature", kind: "AVANTAGE",
      base: amt, rate: 1, gain: amt, avantage: true, cnps: !!a.cnps, impo: a.impo !== false });
    avTotal += amt; if (a.impo !== false) avImpo += amt; if (a.cnps) avCnps += amt;
  }

  /* 2) NAMED BASES */
  const BRUT = lines.filter(l => l.kind === "GAIN").reduce((s, l) => s + l.gain, 0);
  const NETCOTI = lines.filter(l => l.kind === "GAIN" && l.cnps).reduce((s, l) => s + l.gain, 0) + avCnps;
  const NETIMPO = lines.filter(l => l.kind === "GAIN" && l.impo).reduce((s, l) => s + l.gain, 0) + transportTaxable + avImpo;
  const BASECF = Math.round(NETIMPO / 1000) * 1000;
  const cnpsBase = Math.min(NETCOTI, cfg.cnps.ceiling);

  /* 3) COTISATIONS CNPS */
  const pvidE = r0(cnpsBase * cfg.cnps.pvidEmployee), pvidP = r0(cnpsBase * cfg.cnps.pvidEmployer);
  const pfP = r0(cnpsBase * cfg.cnps.familyEmployer), rpP = r0(cnpsBase * cfg.cnps.workAccidentEmployer);
  add({ code: "5000", label: "CNPS Pension (PVID)", kind: "COTIS", base: cnpsBase, rate: cfg.cnps.pvidEmployee, retenue: pvidE, employerRate: cfg.cnps.pvidEmployer, employer: pvidP });
  add({ code: "5010", label: "CNPS Prestations familiales", kind: "COTIS", base: cnpsBase, rate: 0, retenue: 0, employerRate: cfg.cnps.familyEmployer, employer: pfP });
  add({ code: "5020", label: "CNPS Accident de travail", kind: "COTIS", base: cnpsBase, rate: 0, retenue: 0, employerRate: cfg.cnps.workAccidentEmployer, employer: rpP });

  /* 4) IMPÔTS */
  const sni = Math.max(0, NETIMPO * cfg.irpp.fraisProRate
    - (cfg.irpp.deductPvid ? pvidE : 0)
    - (cfg.irpp.annualAbatement || 0) / 12);
  const irpp = r0(progressive(sni, cfg.irpp.brackets));
  const cac = r0(irpp * cfg.irpp.cacRate);
  const cfcE = r0(BASECF * cfg.cfc.employee), cfcP = r0(BRUT * cfg.cfc.employer), fneP = r0(BRUT * cfg.fne.employer);
  const ravBase = input.ravBase != null ? input.ravBase : BRUT;      // ^^CRTV keyed on BRUT
  const tdlBase = input.tdlBase != null ? input.tdlBase : baseSalary; // ^^TAXCOM keyed on SALBASE
  const rav = bracketAmount(cfg.rav, ravBase), tdl = bracketAmount(cfg.tdl, tdlBase);
  add({ code: "5025", label: "IRPP", kind: "IMPOT", base: r0(sni), rate: 0, retenue: irpp });
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
      brutTotal: BRUT, netCotisable: NETCOTI, netImposable: NETIMPO, baseCF: BASECF,
      cnpsSalarie: pvidE, irpp, cac, cfcSalarie: cfcE, rav, tdl,
      totalImpots, autresRetenues: autres, totalRetenues, netAPayer: BRUT - totalRetenues, avantagesNature: avTotal,
      cnpsPatronal: pvidP + pfP + rpP, cfcPatronal: cfcP, fnePatronal: fneP,
      chargesPatronales: chargesPat, coutTotalEmployeur: BRUT + chargesPat,
    },
    meta: { seniorityRate: senR, proratedBase, hourlyRate: r0(hourlyRate), cnpsBase, sni: r0(sni),
      leaveAccrued: cfg.leave.daysPerMonth,
      leaveDailyRate: r0(baseSalary / (cfg.standardMonthlyDays || 30)),
      leaveProvisionMonthly: r0((baseSalary / (cfg.standardMonthlyDays || 30)) * cfg.leave.daysPerMonth) },
  };
}

module.exports = { computePayslip, DEFAULT_CONFIG, progressive, bracketAmount, seniorityRate };
