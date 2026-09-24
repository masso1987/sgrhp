/**
 * SGRHP - Payroll module routes (Module Paie)
 * Config (rubriques, caisses/config, bulletins modèles) + monthly runs, variable
 * elements, batch calculation, payslips (view + PDF), livre de paie, états des
 * cotisations, and period close with cumuls.  Cameroon rules via ../payroll/engine.
 */
const router = require("express").Router();
const PDFDocument = require("pdfkit");
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const _phone = require("../phone");
const { computePayslip, seniorityRate } = require("../payroll/engine");
const crypto = require("crypto");
let _multer; try { _multer = require("multer"); } catch (e) { _multer = null; }
const tsUpload = _multer ? _multer({ storage: _multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }) : { single: () => (rq, rs, nx) => nx() };
function verifySecret() {
  const st = db.settings = db.settings || {};
  if (!st.verifySecret) { st.verifySecret = crypto.randomBytes(24).toString("hex"); try { save(); } catch (e) {} }
  return st.verifySecret;
}

/* ------------------------------------------------------------------ *
 * Ouverture des paies mois par mois (séquentiel).
 * Règle métier : on ne peut ouvrir un nouveau mois que si le mois
 * précédent est CLÔTURÉ. La 1re paie est libre (amorçage) ; ensuite
 * la période à ouvrir est toujours le mois suivant la dernière paie.
 * ------------------------------------------------------------------ */
function periodAdd(period, n) {
  const [y, m] = String(period).split("-").map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + n, 1));
  return d.toISOString().slice(0, 7);
}
/** Renvoie l'état d'ouverture pour un tenant : dernière paie, mois à ouvrir, blocage éventuel. */
function payOpenState(req) {
  const runs = mine(db.payRuns, req).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
  if (!runs.length) return { hasRuns: false, latest: null, nextPeriod: null, canOpen: true, blockedBy: null };
  const latest = runs[runs.length - 1];
  const closed = latest.status === "CLOSED";
  return {
    hasRuns: true,
    latest: { id: latest.id, period: latest.period, status: latest.status },
    nextPeriod: periodAdd(latest.period, 1),
    canOpen: closed,
    blockedBy: closed ? null : { id: latest.id, period: latest.period, status: latest.status }
  };
}
function payslipSig(s) {
  const tt = (s.result && s.result.totals) || {};
  const data = [s.id, s.employeeName, s.period, Math.round(tt.netAPayer || 0)].join("|");
  return crypto.createHmac("sha256", verifySecret()).update(data).digest("hex").slice(0, 16);
}

/* Ensure collections exist (defensive for older stores). */
for (const k of ["payrollConfig", "payRubriques", "bulletinModels", "payRuns", "payslips", "payElements", "payCumuls", "payLoans", "payElementSheets", "payAcomptes", "bordereauFields"])
  if (!db[k]) db[k] = [];

const money = (n) => (Math.round(n || 0)).toLocaleString("fr-FR");
function toCSV(rows) {
  const esc = (c) => { const v = c == null ? "" : String(c); return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return "\uFEFF" + rows.map(r => r.map(esc).join(";")).join("\r\n");
}
function sendCSV(res, name, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(toCSV(rows));
}
function canRunPayroll(req) { return hasPayPerm(req, "payroll.run"); }
function hasPayPerm(req, perm) {
  if (req.user.role === "ADM" || req.user.role === "RP") return true;
  const u = db.users.find(x => x.id === req.user.id);
  return (((u && u.permissions) || []).includes(perm));
}

// Recompute all payslip totals from its lines (used after manual edits).
function recomputePayslip(s) {
  const L = s.result.lines, t = s.result.totals;
  const G = L.filter(l => l.kind === "GAIN");
  const ret = c => (L.find(l => l.code === c) || {}).retenue || 0;
  const emp = c => (L.find(l => l.code === c) || {}).employer || 0;
  t.brutTotal = G.reduce((a, l) => a + (l.gain || 0), 0);
  t.netCotisable = G.filter(l => l.cnps).reduce((a, l) => a + (l.gain || 0), 0);
  t.netImposable = G.filter(l => l.impo).reduce((a, l) => a + (l.gain || 0), 0);
  t.cnpsSalarie = ret("5000"); t.irpp = ret("5025"); t.cac = ret("5045");
  t.cfcSalarie = ret("5050"); t.rav = ret("5080"); t.tdl = ret("5090");
  t.totalImpots = t.irpp + t.cac + t.cfcSalarie + t.rav + t.tdl;
  t.autresRetenues = L.filter(l => l.kind === "RETENUE").reduce((a, l) => a + (l.retenue || 0), 0);
  t.totalRetenues = L.reduce((a, l) => a + (l.retenue || 0), 0);
  t.chargesPatronales = L.reduce((a, l) => a + (l.employer || 0), 0);
  t.cnpsPatronal = emp("5000") + emp("5010") + emp("5020");
  t.cfcPatronal = emp("5060") || emp("5050"); t.fnePatronal = emp("5070");
  t.netAPayer = t.brutTotal - t.totalRetenues;   // deducts cotisations, impôts AND acomptes/prêts
  t.coutTotalEmployeur = t.brutTotal + t.chargesPatronales;
}
const fmtPeriod = (p) => p; // "YYYY-MM"
// N° CNPS + clé (dernier chiffre) - ex. « 3511115179 2 » (comme Sage).
function cnpsFull(emp) {
  const n = emp && emp.cnpsNumber != null ? String(emp.cnpsNumber).trim() : "";
  if (!n) return "";
  const k = emp && emp.cnpsKey != null && String(emp.cnpsKey).trim() !== "" ? String(emp.cnpsKey).trim() : "";
  return k ? `${n} ${k}` : n;
}

function periodDiff(from, to) { // whole months between "YYYY-MM" strings
  if (!from || !to) return -1;
  const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}
function configOf(req) {
  let c = mine(db.payrollConfig, req)[0];
  if (!c) { c = stamp({ id: id("pcfg"), ...require("../payroll/engine").DEFAULT_CONFIG }, req); db.payrollConfig.push(c); save(); }
  // Migration unique : applique l'exonération IRPP transport par défaut aux configs anciennes (cap 0/undefined), sans écraser une valeur choisie ensuite.
  if (!c._transportExoMigrated && (c.transportExemptionCap === 0 || c.transportExemptionCap === undefined || c.transportExemptionCap === null)) {
    c.transportExemptionCap = require("../payroll/engine").DEFAULT_CONFIG.transportExemptionCap;
    c._transportExoMigrated = true; save();
  }
  // Migration : rétablit les valeurs LÉGALES de la prime d'ancienneté (4% à 2 ans, +2%/an, sans plafond).
  // Corrige les configs anciennes dont le taux/an était erroné (ex. 1%) ou plafonnées à 30%.
  if (!c._seniorityLegalMigrated) {
    const dflt = require("../payroll/engine").DEFAULT_CONFIG.seniority;
    if (!c.seniority) c.seniority = {};
    if (Number(c.seniority.perYearRate) !== 0.02) c.seniority.perYearRate = dflt.perYearRate; // 0.02
    if (Number(c.seniority.startRate) !== 0.04) c.seniority.startRate = dflt.startRate;        // 0.04
    if (Number(c.seniority.startYears) !== 2) c.seniority.startYears = dflt.startYears;        // 2
    if (Number(c.seniority.maxRate) <= 0.30) c.seniority.maxRate = dflt.maxRate;               // déplafonné
    c._seniorityLegalMigrated = true; save();
  }
  // Migration : réaligne les paramètres FISCAUX/SOCIAUX légaux (IRPP, CFC, FNE, RAV, TDL, taux CNPS)
  // sur les valeurs en vigueur, en conservant la classe accident du travail (spécifique au tenant).
  if (!c._statutoryV1Migrated) {
    const D = require("../payroll/engine").DEFAULT_CONFIG;
    const keepAccident = (c.cnps && c.cnps.workAccidentEmployer != null) ? c.cnps.workAccidentEmployer : D.cnps.workAccidentEmployer;
    c.irpp = JSON.parse(JSON.stringify(D.irpp));
    c.cfc = JSON.parse(JSON.stringify(D.cfc));
    c.fne = JSON.parse(JSON.stringify(D.fne));
    c.rav = JSON.parse(JSON.stringify(D.rav));
    c.tdl = JSON.parse(JSON.stringify(D.tdl));
    c.cnps = Object.assign({}, JSON.parse(JSON.stringify(D.cnps)), { workAccidentEmployer: keepAccident });
    c._statutoryV1Migrated = true; save();
  }
  // Migration : la prime de salissure/salubrité est un remboursement de frais professionnel
  // -> hors assiette CNPS (comme Sage), mais reste imposable à l'IRPP. Corrige le catalogue stocké.
  if (!c._salissureCnpsMigrated) {
    let changed = 0;
    for (const r of mine(db.payRubriques, req)) {
      const isSal = r.code === "2129" || r.code === "3010" || /saliss|salubrit/i.test(r.label || "");
      if (isSal && r.cnps !== false) { r.cnps = false; if (r.impo == null) r.impo = true; changed++; }
    }
    c._salissureCnpsMigrated = true; if (changed) save(); else save();
  }
  return c;
}
function baseSalaryOf(emp, req) {
  if (emp.salary && Number(emp.salary.base) > 0) return Number(emp.salary.base);
  const c = emp.contract || {}; const cat = c.category;
  // 1) Convention collective grid (nouvelle source de vérité) - par conventionId, sinon toute convention ayant la catégorie.
  if (cat) {
    const convs = mine(db.conventions, req);
    const byId = c.conventionId ? convs.find(x => x.id === c.conventionId) : null;
    const rowIn = (cnv) => (cnv && Array.isArray(cnv.grid) ? cnv.grid : []).find(g => g.category === cat && Number(g.baseSalary) > 0);
    let row = rowIn(byId);
    if (!row) for (const cnv of convs) { row = rowIn(cnv); if (row) break; }
    if (row) return Number(row.baseSalary);
  }
  // 2) Grille salariale héritée (catégories du référentiel).
  const g = mine(db.salaryGrid, req).find(x => x.category === cat);
  if (g && Number(g.baseSalary) > 0) return Number(g.baseSalary);
  // 3) Un élément de salaire dont le nom évoque le salaire de base.
  if (emp.salary) for (const [k, v] of Object.entries(emp.salary)) {
    if (/base/i.test(k) && Number(v) > 0) return Number(v);
  }
  return 0;
}
// Salaire MINIMUM de la catégorie (1er échelon / échelon A) - base légale de la prime d'ancienneté.
function categorielBaseA(emp, req) {
  const c = emp.contract || {}; const cat = String(c.category || "");
  const m = cat.match(/^(\d{1,2})([A-F])$/);
  if (!m) return 0; // catégorie non conventionnelle : l'appelant retombera sur le salaire de base
  const codeA = m[1] + "A";
  const convs = mine(db.conventions, req);
  const byId = c.conventionId ? convs.find(x => x.id === c.conventionId) : null;
  const rowIn = (cnv) => (cnv && Array.isArray(cnv.grid) ? cnv.grid : []).find(g => g.category === codeA && Number(g.baseSalary) > 0);
  let row = rowIn(byId);
  if (!row) for (const cnv of convs) { row = rowIn(cnv); if (row) break; }
  return row ? Number(row.baseSalary) : 0;
}
// Ancienneté en mois au titre d'une période de paie : le mois payé compte (comme Sage). Ex. embauche 09/2006, paie 07/2026 -> 239 mois = 19 ans 11 mois.
function seniorityMonths(emp, period) {
  const hire = emp.hireDate || (emp.contract && emp.contract.startDate);
  if (!hire) return 0;
  const h = new Date(hire);
  const [y, mo] = String(period || new Date().toISOString().slice(0, 7)).split("-").map(Number);
  const m = (y - h.getFullYear()) * 12 + ((mo - 1) - h.getMonth()) + 1;
  return Math.max(0, m);
}
function seniorityLabel(emp, period) { const m = seniorityMonths(emp, period); return `${Math.floor(m / 12)} an(s) ${m % 12} mois`; }
function seniorityYears(emp, period) {
  return Math.floor(seniorityMonths(emp, period) / 12);
}
// Ancienneté en années décimales (pour le solde de tout compte : les fractions comptent).
function seniorityYearsFrac(emp, endDate) {
  const hire = emp.hireDate || (emp.contract && emp.contract.startDate);
  if (!hire) return 0;
  const end = endDate ? new Date(endDate) : new Date();
  const y = (end - new Date(hire)) / (365.25 * 24 * 3600 * 1000);
  return Math.max(0, Math.round(y * 100) / 100);
}

/** Turn variable elements for one employee/period into engine input. */
// Build the recurring salary structure from the employee's filled-in RH salary
// elements, mapped to Paie rubriques (element.rubriqueCode). This is the RH -> Paie
// bridge: amounts entered in the HR dossier drive payroll automatically each month.
function structureToInput(emp, req) {
  const elements = mine(db.salaryElements, req);
  const rubOf = (code) => mine(db.payRubriques, req).find(r => r.code === code);
  // Default tag -> rubrique mapping (used when an element has no explicit rubriqueCode)
  const TAG_RUB = { salary_base: "1000", allowance_transport: "3513", allowance_housing: "3510",
    allowance_dirt: "2129", bonus_performance: "2127" };
  const salary = emp.salary || {};
  const gains = []; let baseSalary = 0, transport = null;
  for (const el of elements) {
    const amount = Number(salary[el.name]);
    if (!amount) continue;
    const code = el.rubriqueCode || TAG_RUB[el.tag] || null; const rub = code ? rubOf(code) : null;
    if (code === "1000" || el.tag === "salary_base" || /salaire de base/i.test(el.name || "")) { baseSalary = amount; continue; }
    // La prime d'ancienneté est calculée automatiquement par le moteur (Arrêté n°019 MTPS : % du salaire minimum de la catégorie). On ignore donc toute valeur saisie manuellement (codes 1040/1055 ou libellé « ancienneté »).
    if (code === "1040" || code === "1055" || /anciennet/i.test(el.name || "")) continue;
    if (el.tag === "allowance_transport") { transport = { code: code || "3513", label: (rub && rub.label) || el.name, amount, prorate: true }; continue; }
    gains.push({ code: code || "2000", label: (rub && rub.label) || el.name, amount, prorate: true,
      cnps: rub ? !!rub.cnps : true, impo: rub ? !!rub.impo : true });
  }
  if (!baseSalary) baseSalary = baseSalaryOf(emp, req); // fallback to the salary grid
  return { baseSalary, gains, transport };
}

function elementsToInput(emp, period, req, opts) {
  opts = opts || {};
  // 1) recurring structure from the HR dossier
  const struct = structureToInput(emp, req);
  const gains = [...struct.gains], nonTaxable = [], otherDeductions = [], avantages = [];
  const overtime = { tier1: 0, tier2: 0, tier3: 0, night: 0, sundayHoliday: 0 };
  let absenceDays = 0;
  // 2) variable elements entered for this period (on top of the structure)
  const els = mine(db.payElements, req).filter(e => e.employeeId === emp.id && e.period === period);
  const _rubOf = (code) => mine(db.payRubriques, req).find(r => String(r.code) === String(code));
  // Drapeaux fiscaux d'un élément variable : explicite sur l'élément > rubrique du référentiel > défaut.
  const _flags = (e, defImpo, defCnps) => {
    const rub = _rubOf(e.code);
    const impo = e.impo !== undefined ? (e.impo !== false) : (rub ? !!rub.impo : defImpo);
    const cnps = e.cnps !== undefined ? (e.cnps !== false) : (rub ? !!rub.cnps : defCnps);
    return { impo, cnps };
  };
  for (const e of els) {
    switch (e.type) {
      case "PRIME": { const f = _flags(e, true, true); gains.push({ code: e.code, label: e.label, amount: Number(e.amount), cnps: f.cnps, impo: f.impo }); break; }
      case "INDEMNITE": { const f = _flags(e, false, false); if (!f.impo && !f.cnps) nonTaxable.push({ code: e.code, label: e.label, amount: Number(e.amount) }); else gains.push({ code: e.code, label: e.label, amount: Number(e.amount), cnps: f.cnps, impo: f.impo }); break; }
      case "ACOMPTE": otherDeductions.push({ code: e.code && String(e.code) !== "ACOMPTE" ? String(e.code) : "7000", label: e.label || "Acompte sur salaire", amount: Number(e.amount) }); break;
      case "PRET": otherDeductions.push({ code: e.code && String(e.code) !== "PRET" ? String(e.code) : "7010", label: e.label || "Remboursement de prêt", amount: Number(e.amount) }); break;
      case "RETENUE": otherDeductions.push({ code: e.code && String(e.code) !== "RETENUE" ? String(e.code) : "7030", label: e.label || "Retenue diverse", amount: Number(e.amount) }); break;
      case "HS20": overtime.tier1 += Number(e.hours || 0); break;
      case "HS30": overtime.tier2 += Number(e.hours || 0); break;
      case "HS40": overtime.tier3 += Number(e.hours || 0); break;
      case "NUIT": overtime.night += Number(e.hours || 0); break;
      case "ABSENCE": absenceDays += Number(e.days || 0); break;
      case "AVANTAGE": { const f = _flags(e, true, false); avantages.push({ code: e.code || "4000", label: e.label || "Avantage en nature", amount: Number(e.amount), cnps: f.cnps, impo: f.impo }); break; }
      case "TREIZE": { const _senM = seniorityRate(seniorityYears(emp, period), configOf(req)); gains.push({ code: "2514", label: e.label || "13e mois", amount: Number(e.amount) || Math.round(struct.baseSalary * (1 + _senM)) }); break; }
      case "RAPPEL": gains.push({ code: "2035", label: e.label || "Rappel de salaire", amount: Number(e.amount) }); break;
      default: break;
    }
  }
  // Prêts avec échéancier: auto-deduct the monthly installment while within the schedule.
  for (const ln of mine(db.payLoans, req).filter(l => l.employeeId === emp.id && l.active !== false)) {
    const diff = periodDiff(ln.startPeriod, period);
    if (diff >= 0 && diff < ln.installments)
      otherDeductions.push({ code: "7010", label: `${ln.label || "Prêt"} (${diff + 1}/${ln.installments})`, amount: Number(ln.monthlyAmount) });
  }
  // Acomptes sur salaire (registre dédié) : retenus à 100% sur le mois concerné.
  for (const ac of mine(db.payAcomptes, req).filter(a => a.employeeId === emp.id && a.period === period && a.status === "VALIDE")) {
    if (Number(ac.amount) > 0) otherDeductions.push({ code: "7000", label: "Acompte sur salaire", amount: Number(ac.amount) });
  }
  const cfg = configOf(req);
  const joursEl = els.find(e => e.type === "JOURS");
  const stdDays = cfg.standardMonthlyDays || 30;
  const workedDays = joursEl != null ? Math.max(0, Number(joursEl.days))
    : Math.max(0, stdDays - absenceDays);
  // Injection ponctuelle (calcul à l'envers) : une rubrique d'ajustement en gain imposable/cotisable.
  if (opts.extraGain && Number(opts.extraGain.amount)) {
    const g = opts.extraGain;
    gains.push({ code: g.code || "2000", label: g.label || "Ajustement", amount: Number(g.amount), cnps: g.cnps !== false, impo: g.impo !== false });
  }
  const _anBase = categorielBaseA(emp, req);
  return {
    baseSalary: struct.baseSalary,
    ancienneteBase: _anBase > 0 ? _anBase : struct.baseSalary, // prime d'ancienneté sur le salaire minimum de la catégorie (échelon A)
    workedDays, standardDays: cfg.standardMonthlyDays || 30,
    seniorityYears: seniorityYears(emp, period),
    overtime, gains, nonTaxable, avantages, transport: struct.transport, otherDeductions,
    tdlBase: struct.baseSalary,
  };
}
function computeFor(emp, period, req, opts) {
  const cfg = configOf(req);
  const input = elementsToInput(emp, period, req, opts);
  const result = computePayslip(input, cfg);
  return { input, result };
}
// Calcul à l'envers : trouve le montant de la rubrique d'ajustement donnant le net cible.
function reverseSolve(emp, period, req, targetNet, code, label, cnps, impo) {
  if (cnps === undefined) cnps = true; if (impo === undefined) impo = true;
  const iterations = [];
  const netFor = (amount) => {
    const { result } = computeFor(emp, period, req, { extraGain: { code, label, amount, cnps, impo } });
    return result.totals.netAPayer;
  };
  const net0 = netFor(0);
  targetNet = Number(targetNet) || 0;
  // Si le net de base dépasse déjà la cible, rien à ajouter.
  if (net0 >= targetNet) { iterations.push({ n: 1, montant: 0, net: Math.round(net0) }); return { amount: 0, net: Math.round(net0), iterations, alreadyReached: true }; }
  // Borne haute : on augmente jusqu'à dépasser la cible.
  let hi = Math.max(targetNet - net0, 1000);
  let guard = 0;
  while (netFor(hi) < targetNet && guard < 40) { hi *= 2; guard++; }
  let lo = 0, amount = hi, net = 0;
  for (let i = 0; i < 60; i++) {
    amount = (lo + hi) / 2;
    net = netFor(amount);
    iterations.push({ n: i + 1, montant: Math.round(amount), net: Math.round(net) });
    if (Math.abs(net - targetNet) < 0.5) break;
    if (net < targetNet) lo = amount; else hi = amount;
    if (hi - lo < 0.01) break;
  }
  amount = Math.round(amount);
  net = Math.round(netFor(amount));
  return { amount, net, iterations: iterations.slice(-12) };
}

// Regroupement/ordre des rubriques : par section puis par numéro de code.
function rubSection(r) {
  const n = parseInt(String(r.code), 10) || 0;
  if (r.sens === "PATRONAL") return { key: "patronal", order: 4, label: "Charges patronales" };
  if (r.family === "BRUT" || r.sens === "GAIN") return { key: "gains", order: 1, label: "Gains" };
  if (r.family === "COTISATION") return (n >= 5025)
    ? { key: "impots", order: 3, label: "Impôts & taxes" }
    : { key: "cotisations", order: 2, label: "Cotisations sociales" };
  return { key: "retenues", order: 5, label: "Retenues & éléments non soumis" };
}
function rubSortKey(r) { const s = rubSection(r); return s.order * 1e7 + (parseInt(String(r.code), 10) || 0); }
function sortRubriques(list) {
  return list.map(r => { const s = rubSection(r); return { ...r, section: s.key, sectionLabel: s.label, sectionOrder: s.order }; })
    .sort((a, b) => rubSortKey(a) - rubSortKey(b));
}
// Rubriques attribuées à un salarié : rubriques allouées à son portefeuille + structure + base.
function employeeRubriques(emp, req) {
  const rubs = mine(db.payRubriques, req);
  const byCode = (c) => rubs.find(r => String(r.code) === String(c));
  const els = mine(db.salaryElements, req);
  const pf = mine(db.portfolios, req).find(p => p.id === emp.portfolioId);
  const allowedNames = (pf && Array.isArray(pf.salaryElements) && pf.salaryElements.length) ? new Set(pf.salaryElements) : null;
  const TAG_RUB = { salary_base: "1000", allowance_transport: "3513", allowance_housing: "3510", allowance_dirt: "2129", bonus_performance: "2127" };
  const codes = new Set(["1000"]); // salaire de base toujours présent
  for (const el of els) {
    if (allowedNames && !allowedNames.has(el.name)) continue;
    const c = el.rubriqueCode || TAG_RUB[el.tag]; if (c) codes.add(String(c));
  }
  // + rubriques déjà valorisées dans la structure du salarié
  const sal = emp.salary || {};
  for (const el of els) { if (Number(sal[el.name])) { const c = el.rubriqueCode || TAG_RUB[el.tag]; if (c) codes.add(String(c)); } }
  const out = [...codes].map(byCode).filter(Boolean);
  return sortRubriques(out);
}

/* ============================ CONFIG ============================ */
router.get("/config", allow("RP", "ADM", "CD", "RJ"), (req, res) => res.json(configOf(req)));

router.put("/config", allow("RP", "ADM"), (req, res) => {
  const c = configOf(req);
  const before = JSON.parse(JSON.stringify(c));
  Object.assign(c, req.body || {}, { id: c.id, tenantId: c.tenantId });
  save();
  audit(req.user, "CONFIG_CHANGED", "PayrollConfig", c.id, { before, after: c });
  res.json(c);
});

// A rubrique is "in use" once its code appears in any computed/closed payslip.
// Such rubriques are locked: modifying them would alter already-produced payroll,
// so it requires an explicit confirmation (force) and is audited.
function rubriqueInUse(rub, req) {
  const tid = req.user.tenantId || "t1";
  return db.payslips.some(s => (s.tenantId || "t1") === tid &&
    (s.status === "CALCULATED" || s.status === "CLOSED") &&
    Array.isArray(s.result && s.result.lines) && s.result.lines.some(l => l.code === rub.code));
}
const RUB_FIELDS = ["label", "family", "formula", "base", "nombre", "taux", "tauxPat", "cnps", "impo", "sens", "active"];

router.get("/rubriques", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) =>
  res.json(sortRubriques(mine(db.payRubriques, req).map(r => ({ ...r, inUse: rubriqueInUse(r, req) })))));
// Rubriques attribuées à un salarié (pour le calcul à l'envers et les éléments variables), triées.
router.get("/employees/:eid/rubriques", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });
  // Renvoie TOUTES les rubriques du référentiel (groupées par sens/famille), en marquant
  // d'un drapeau `mine` celles habituellement attribuées au salarié pour les afficher en premier.
  const mineCodes = new Set(employeeRubriques(emp, req).map(r => String(r.code)));
  const all = sortRubriques(mine(db.payRubriques, req));
  res.json(all.map(r => ({ code: r.code, label: r.label, family: r.family, sens: r.sens, cnps: !!r.cnps, impo: !!r.impo, section: r.section, sectionLabel: r.sectionLabel, mine: mineCodes.has(String(r.code)) })));
});

router.post("/rubriques", allow("RP", "ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.label) return res.status(400).json({ error: "Code et libellé obligatoires" });
  if (mine(db.payRubriques, req).some(r => r.code === b.code))
    return res.status(409).json({ error: `Le code ${b.code} existe déjà` });
  const r = stamp({ id: id("rub"), code: String(b.code), label: b.label, family: b.family || "BRUT",
    formula: b.formula || "Montant pris tel quel", base: b.base || null, nombre: b.nombre || null,
    taux: b.taux != null && b.taux !== "" ? Number(b.taux) : null,
    tauxPat: b.tauxPat != null && b.tauxPat !== "" ? Number(b.tauxPat) : null,
    cnps: !!b.cnps, impo: !!b.impo, sens: b.sens || "GAIN",
    active: true, system: false, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.payRubriques.push(r); save();
  audit(req.user, "CREATED", "PayRubrique", r.id, { code: r.code, label: r.label });
  res.status(201).json(r);
});

router.post("/rubriques/import-catalogue", allow("RP", "ADM"), (req, res) => {
  const { CATALOGUE } = require("../payroll/seed");
  const have = new Set(mine(db.payRubriques, req).map(r => r.code));
  let added = 0;
  for (const r of CATALOGUE) {
    if (have.has(r.code)) continue;
    db.payRubriques.push(stamp({
      id: id("rub"), code: r.code, label: r.label, family: r.family,
      formula: r.formula, base: r.base || null, nombre: r.nombre || null,
      taux: r.taux != null ? r.taux : null, tauxPat: r.tauxPat != null ? r.tauxPat : null,
      cnps: !!r.cnps, impo: !!r.impo, sens: r.sens || "GAIN",
      active: true, system: true, createdAt: new Date().toISOString(),
    }, req));
    added++;
  }
  if (added) save();
  audit(req.user, "IMPORTED", "PayRubrique", "catalogue", { added });
  res.json({ ok: true, added, total: mine(db.payRubriques, req).length });
});

router.put("/rubriques/:id", allow("RP", "ADM"), (req, res) => {
  const r = mine(db.payRubriques, req).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Rubrique introuvable" });
  const b = req.body || {};
  const inUse = rubriqueInUse(r, req);
  if (inUse && !b.force)
    return res.status(409).json({ error: "Rubrique déjà utilisée dans des bulletins calculés",
      requiresConfirmation: true,
      warning: `La rubrique « ${r.code} ${r.label} » est déjà utilisée dans des bulletins de paie calculés/clôturés. ` +
        `La modifier affectera l'ensemble de la paie et nécessitera un recalcul. Confirmez pour appliquer.` });
  const before = { ...r };
  for (const f of RUB_FIELDS) if (b[f] !== undefined) {
    r[f] = (f === "taux" || f === "tauxPat") ? (b[f] === "" || b[f] == null ? null : Number(b[f]))
      : (f === "cnps" || f === "impo" || f === "active") ? !!b[f] : b[f];
  }
  save();
  audit(req.user, inUse ? "FORCED_CHANGE" : "UPDATED", "PayRubrique", r.id,
    { code: r.code, inUse, before: { label: before.label, taux: before.taux, cnps: before.cnps, impo: before.impo } });
  res.json({ ...r, inUse });
});

router.delete("/rubriques/:id", allow("RP", "ADM"), (req, res) => {
  const r = mine(db.payRubriques, req).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Introuvable" });
  if (rubriqueInUse(r, req) && !(req.query.force === "1"))
    return res.status(409).json({ error: "Rubrique utilisée dans des bulletins calculés - suppression bloquée",
      requiresConfirmation: true,
      warning: `« ${r.code} ${r.label} » est utilisée dans la paie. La supprimer peut casser des recalculs. Confirmez pour supprimer.` });
  db.payRubriques.splice(db.payRubriques.indexOf(r), 1); save();
  audit(req.user, "DELETED", "PayRubrique", r.id, { code: r.code });
  res.json({ ok: true });
});

/* Bulletins modèles */
router.get("/models", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => res.json(mine(db.bulletinModels, req)));
router.post("/models", allow("RP", "ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.label) return res.status(400).json({ error: "code et libellé obligatoires" });
  const m = stamp({ id: id("bmod"), code: b.code, label: b.label, type: b.type || "Mensuel",
    monthlyHours: Number(b.monthlyHours) || 173.33, lines: b.lines || [] }, req);
  db.bulletinModels.push(m); save();
  res.status(201).json(m);
});
router.put("/models/:id", allow("RP", "ADM"), (req, res) => {
  const m = mine(db.bulletinModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Introuvable" });
  Object.assign(m, req.body || {}, { id: m.id, tenantId: m.tenantId }); save();
  res.json(m);
});

/* ======================= VARIABLE ELEMENTS ===================== */
router.get("/elements", allow("RP", "ADM", "GPF", "CD", "RJ"), (req, res) => {
  const { period, employeeId } = req.query;
  let list = mine(db.payElements, req);
  if (period) list = list.filter(e => e.period === period);
  if (employeeId) list = list.filter(e => e.employeeId === employeeId);
  res.json(list);
});
router.post("/elements", allow("RP", "ADM", "GPF"), (req, res) => {
  const b = req.body || {};
  if (!b.employeeId || !b.period || !b.type) return res.status(400).json({ error: "employeeId, period, type obligatoires" });
  if (runLocked(b.period, req)) return res.status(409).json({ error: "Période clôturée - saisie impossible" });
  // Hérite les drapeaux fiscaux (imposable/CNPS) de la rubrique choisie si non fournis explicitement.
  const _rub = b.code ? mine(db.payRubriques, req).find(r => String(r.code) === String(b.code)) : null;
  const _impo = b.impo !== undefined ? (b.impo !== false && b.impo !== "false") : (_rub ? !!_rub.impo : undefined);
  const _cnps = b.cnps !== undefined ? (b.cnps !== false && b.cnps !== "false") : (_rub ? !!_rub.cnps : undefined);
  const e = stamp({ id: id("pel"), employeeId: b.employeeId, period: b.period, type: b.type,
    code: b.code || b.type, label: b.label || b.type, amount: b.amount ? Number(b.amount) : undefined,
    hours: b.hours ? Number(b.hours) : undefined, days: b.days ? Number(b.days) : undefined,
    impo: _impo, cnps: _cnps,
    createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.payElements.push(e); save();
  audit(req.user, "CREATED", "PayElement", e.id, { period: e.period, type: e.type, employeeId: e.employeeId });
  res.status(201).json(e);
});
router.delete("/elements/:id", allow("RP", "ADM", "GPF"), (req, res) => {
  const el = mine(db.payElements, req).find(x => x.id === req.params.id);
  if (!el) return res.status(404).json({ error: "Introuvable" });
  if (runLocked(el.period, req)) return res.status(409).json({ error: "Période clôturée" });
  db.payElements.splice(db.payElements.indexOf(el), 1); save();
  res.json({ ok: true });
});

function runLocked(period, req) {
  return mine(db.payRuns, req).some(r => r.period === period && r.status === "CLOSED");
}
/* La paie du mois a-t-elle été calculée (ou clôturée) ? Une fois calculée, le bordereau et les
   acomptes sont figés : plus de réouverture ni de modification (corrections = régularisation mois suivant). */
function runComputed(period, req) {
  return mine(db.payRuns, req).some(r => r.period === period && (r.status === "CALCULATED" || r.status === "CLOSED"));
}

/* =================================================================== *
 *  BORDEREAU D'ÉLÉMENTS DE PAIE  (contrôle GPF <-> Paie)              *
 *  - Un bordereau par client (portefeuille) et par période.          *
 *  - Le GPF saisit dans l'app (aucun import Excel) : jours de         *
 *    présence, heures supp., primes variables, acomptes.             *
 *  - À la soumission : snapshot figé + signature électronique (GPF)   *
 *    + injection des éléments variables de la période.                *
 *  - Journal d'audit strict, en annexe (append-only).                 *
 * =================================================================== */
const _cryptoB = require("crypto");
function _sheetIp(req){ try { return require("../auth").clientIp(req); } catch(e){ return ""; } }
function _sheetUA(req){ try { return require("../auth").parseUA(req.headers["user-agent"]||""); } catch(e){ return {browser:"",os:"",device:""}; } }
function _sha(obj){ return _cryptoB.createHash("sha256").update(typeof obj==="string"?obj:JSON.stringify(obj)).digest("hex"); }
/** Journalise un évènement dans le flux d'audit du bordereau (append-only) + audit global. */
function bEvent(sheet, req, action, detail){
  const ua=_sheetUA(req);
  const ev={ id:id("bev"), at:new Date().toISOString(), userId:req.user.id, userName:req.user.fullName||"", role:req.user.role,
    action, detail:detail||null, ip:_sheetIp(req), browser:ua.browser, os:ua.os, device:ua.device };
  sheet.events = sheet.events || []; sheet.events.push(ev);
  try { audit(req.user, action, "PayElementSheet", sheet.id, Object.assign({ period:sheet.period, portfolioId:sheet.portfolioId }, detail||{})); } catch(e){}
  return ev;
}
/** Signature électronique (légère mais vérifiable) : nom, rôle, horodatage, empreinte SHA-256. */
function esign(sheet, req, kind, payloadHash){
  const seq=(sheet.signatures||[]).length+1;
  const sig={ kind, seq, userId:req.user.id, name:req.user.fullName||"", role:req.user.role,
    at:new Date().toISOString(), sha256:payloadHash, ip:_sheetIp(req) };
  sheet.signatures=sheet.signatures||[]; sheet.signatures.push(sig); return sig;
}
const B_STD_DAYS = (req)=> (configOf(req).standardMonthlyDays || 30);
function empName(e){ return `${e.firstName||""} ${e.lastName||""}`.trim(); }
/** Ligne vierge pour un employé. */
/* Congé : à partir de la date d'embauche + convention/ancienneté, déterminer si le congé
   de l'employé est DÛ ce mois (anniversaire d'embauche, ≥ 12 mois d'ancienneté) et son droit. */
function empHireDate(e){ return e.hireDate || (e.contract && e.contract.startDate) || ""; }
/* Salaire brut moyen (SBM) : moyenne des bruts des 12 derniers bulletins (période de référence),
   repli sur le brut contractuel courant si l'historique manque. */
function sbmOf(emp, period, req){
  const slips=mine(db.payslips, req).filter(s=>s.employeeId===emp.id && s.period && (!period || s.period < period))
    .sort((a,b)=>(b.period||"").localeCompare(a.period||"")).slice(0,12);
  if(slips.length){ const tot=slips.reduce((a,s)=>a+((s.result&&s.result.totals&&s.result.totals.brutTotal)||0),0); return Math.round(tot/slips.length); }
  try{ if(baseSalaryOf(emp, req)){ const { result }=computeFor(emp, period||new Date().toISOString().slice(0,7), req); return Math.round((result&&result.totals&&result.totals.brutTotal)||0); } }catch(e){}
  return 0;
}
/* Paramètres de congé applicables à l'employé : convention (si définie) sinon config paie. */
function congeParams(emp, req){
  const cfg=(configOf(req).leave)||{};
  let baseAnnual=cfg.baseAnnual||24, allocationDivisor=cfg.allocationDivisor||12, provisionDivisor=cfg.provisionDivisor||30;
  const cid=emp && emp.contract && emp.contract.conventionId;
  const conv=cid ? mine(db.conventions, req).find(c=>c.id===cid) : null;
  if(conv && conv.conge){ const g=conv.conge;
    if(g.baseAnnualDays>0) baseAnnual=g.baseAnnualDays;
    if(g.allocationDivisor>0) allocationDivisor=g.allocationDivisor;
    if(g.provisionDivisor>0) provisionDivisor=g.provisionDivisor;
  } else if(conv && /commerce/i.test(conv.name||"")){ baseAnnual=24; allocationDivisor=12; } // CCN Commerce : 2 j/mois, allocation 1/12
  return { baseAnnual, allocationDivisor, provisionDivisor };
}
/* Calcul complet du congé : allocation annuelle (réf/diviseur) + provision mensuelle (SBM/30 x jours). */
function congeCompute(emp, period, req){
  const p=congeParams(emp, req); const sbm=sbmOf(emp, period, req);
  const refRemun=sbm*12;
  const annualAllocation=Math.round(refRemun / (p.allocationDivisor||12));
  const dailyBase=Math.round(sbm / (p.provisionDivisor||30));          // BASEC
  const joursMensuel=Math.round((p.baseAnnual/12)*100)/100;            // 1,5 ou 2
  const monthlyProvision=Math.round(dailyBase*joursMensuel);
  return { sbm, refRemun, allocationDivisor:p.allocationDivisor, provisionDivisor:p.provisionDivisor,
    baseAnnual:p.baseAnnual, joursMensuel, dailyBase, annualAllocation, monthlyProvision };
}

function congeInfo(emp, period, req){
  const hire = empHireDate(emp);
  if(!hire || !/^\d{4}-\d{2}$/.test(period||"")) return { due:false, hireDate:hire||"", entitlementDays:null, accruedDays:null, seniorityYears:0 };
  const hMonth = new Date(hire).getMonth()+1;
  const [y,mo] = period.split("-").map(Number);
  const months = seniorityMonths(emp, period);
  const due = months>=12 && mo===hMonth;
  let bal={}; try{ bal=require("./hr").leaveBalance(emp); }catch(e){ bal={}; }
  const calc = congeCompute(emp, period, req);
  return { due, hireDate:hire, anniversaryMonth:hMonth, seniorityYears:Math.floor(months/12), seniorityLabel:seniorityLabel(emp, period),
    entitlementDays: bal.annualEntitlement!=null?bal.annualEntitlement:null, accruedDays: bal.accrued!=null?bal.accrued:null,
    remainingDays: bal.remaining!=null?bal.remaining:null, majoration: bal.majoration||0,
    sbm:calc.sbm, allocationDivisor:calc.allocationDivisor, annualAllocation:calc.annualAllocation, monthlyProvision:calc.monthlyProvision, dailyBase:calc.dailyBase, suggestedAllocation:calc.annualAllocation };
}

function blankLine(e, req){
  return { employeeId:e.id, matricule:e.matricule||e.id.slice(-6), name:empName(e),
    category:(e.contract&&e.contract.category)||"", contrat:(e.contract&&e.contract.type)||"", hireDate:empHireDate(e),
    joursPresence:B_STD_DAYS(req), absence:0, hs120:0, hs130:0, hs140:0, hsNuit:0, congeAmount:0,
    custom:{} /* {fieldKey: value} colonnes personnalisées */, primes:[] /* {code,label,amount,cnps,impo} */ };
}
/** Échéance de prêt du mois pour un employé (lecture seule, depuis payLoans). */
function loanEcheance(empId, period, req){
  let tot=0; const detail=[];
  for (const ln of mine(db.payLoans, req).filter(l => l.employeeId===empId && l.active!==false)){
    const diff=periodDiff(ln.startPeriod, period);
    if (diff>=0 && diff<ln.installments){ tot+=Number(ln.monthlyAmount)||0; detail.push({label:ln.label||"Prêt", n:diff+1, of:ln.installments, amount:Number(ln.monthlyAmount)||0}); }
  }
  return { total:tot, detail };
}
function sheetOut(sheet, req){
  const out=Object.assign({}, sheet);
  const _empById={}; mine(db.employees, req).forEach(e=>{ _empById[e.id]=e; });
  const _dispNom=(e)=>(((e&&e.firstName)||"")+" "+((e&&e.lastName)||"")).trim().toLowerCase();
  out.lines=(sheet.lines||[]).slice().sort((a,b)=>_dispNom(_empById[a.employeeId]).localeCompare(_dispNom(_empById[b.employeeId]), "fr", {sensitivity:"base"})).map(l => { const emp=_empById[l.employeeId]||{}; const ci=congeInfo(emp, sheet.period, req);
    return Object.assign({}, l, { loan:loanEcheance(l.employeeId, sheet.period, req), acompte:acompteTotalAll(l.employeeId, sheet.period, req), acompteValide:acompteTotal(l.employeeId, sheet.period, req),
      hireDate:l.hireDate||empHireDate(emp), anciennete:seniorityLabel(emp, sheet.period), conge:ci }); });
  const pf=mine(db.portfolios, req).find(p=>p.id===sheet.portfolioId);
  out.portfolioName=pf?pf.name:"(tous)";
  out.fields=fieldsForSheet(req, sheet.portfolioId).map(f=>({key:f.key,label:f.label,kind:f.kind,rubriqueCode:f.rubriqueCode,overtimeType:f.overtimeType}));
  return out;
}
function findSheet(req, sid){ return mine(db.payElementSheets, req).find(s=>s.id===sid); }
function canSignBAP(req){ return ["CD","ADM","RJ"].includes(req.user.role); } // Bon à payer : CD, ADM (audit) ou RJ


/* =================================================================== *
 *  CHAMPS PERSONNALISÉS DU BORDEREAU (colonnes supplémentaires)       *
 *  L'admin définit des colonnes en plus (par client ou pour tous),    *
 *  chacune MAPPÉE à une rubrique de paie -> injectée en paie et        *
 *  contrôlée. kind AMOUNT -> prime (rubriqueCode) ; HOURS -> HS/nuit.   *
 * =================================================================== */
function fieldsForSheet(req, portfolioId){
  return mine(db.bordereauFields, req).filter(f => f.active!==false && (!f.portfolioId || f.portfolioId===portfolioId))
    .sort((a,b)=>(a.order||0)-(b.order||0));
}
router.get("/bordereau-fields", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const { portfolioId } = req.query;
  let list=mine(db.bordereauFields, req);
  if(portfolioId!=null) list=list.filter(f=>!f.portfolioId || f.portfolioId===portfolioId);
  const rubs=mine(db.payRubriques, req);
  res.json(list.sort((a,b)=>(a.order||0)-(b.order||0)).map(f=>Object.assign({}, f,
    { rubriqueLabel:(rubs.find(r=>String(r.code)===String(f.rubriqueCode))||{}).label||"" })));
});
router.post("/bordereau-fields", allow("ADM"), (req,res)=>{
  const b=req.body||{};
  if(!b.label) return res.status(400).json({error:"Libellé requis"});
  const kind = b.kind==="HOURS" ? "HOURS" : "AMOUNT";
  if(kind==="AMOUNT" && !b.rubriqueCode) return res.status(400).json({error:"Rubrique requise pour un montant"});
  if(kind==="HOURS" && !["HS20","HS30","HS40","NUIT"].includes(b.overtimeType)) return res.status(400).json({error:"Type d'heures requis (HS20/HS30/HS40/NUIT)"});
  const key = "c_"+id("f").slice(-6);
  const f=stamp({ id:id("bfld"), key, label:String(b.label).slice(0,40), kind,
    rubriqueCode: kind==="AMOUNT"?String(b.rubriqueCode):"", overtimeType: kind==="HOURS"?b.overtimeType:"",
    portfolioId: b.portfolioId||"", order: Number(b.order)||0, active:true, createdAt:new Date().toISOString() }, req);
  db.bordereauFields.push(f); save(); audit(req.user,"CREATED","BordereauField",f.id,{label:f.label});
  res.status(201).json(f);
});
router.put("/bordereau-fields/:id", allow("ADM"), (req,res)=>{
  const f=mine(db.bordereauFields, req).find(x=>x.id===req.params.id); if(!f) return res.status(404).json({error:"Introuvable"});
  const b=req.body||{};
  if(b.label!=null) f.label=String(b.label).slice(0,40);
  if(b.rubriqueCode!=null) f.rubriqueCode=String(b.rubriqueCode);
  if(b.overtimeType!=null) f.overtimeType=b.overtimeType;
  if(b.portfolioId!=null) f.portfolioId=b.portfolioId;
  if(b.order!=null) f.order=Number(b.order)||0;
  if(b.active!=null) f.active=!!b.active;
  save(); res.json(f);
});
router.delete("/bordereau-fields/:id", allow("ADM"), (req,res)=>{
  const f=mine(db.bordereauFields, req).find(x=>x.id===req.params.id); if(!f) return res.status(404).json({error:"Introuvable"});
  db.bordereauFields.splice(db.bordereauFields.indexOf(f),1); save(); res.json({ok:true});
});

/* --- Liste --- */
router.get("/bordereaux", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const { period, portfolioId } = req.query;
  let list=mine(db.payElementSheets, req);
  if(period) list=list.filter(s=>s.period===period);
  if(portfolioId) list=list.filter(s=>s.portfolioId===portfolioId);
  const pfs=mine(db.portfolios, req);
  const _pfn=(pid)=>((pfs.find(p=>p.id===pid)||{}).name||"").toLowerCase();
  res.json(list.slice().sort((a,b)=>(b.period||"").localeCompare(a.period||"") || _pfn(a.portfolioId).localeCompare(_pfn(b.portfolioId),"fr",{sensitivity:"base"}) || (a.seq||1)-(b.seq||1)).map(s=>({
    id:s.id, period:s.period, portfolioId:s.portfolioId, portfolioName:(pfs.find(p=>p.id===s.portfolioId)||{}).name||"(tous)",
    kind:s.kind||"PRINCIPAL", seq:s.seq||1,
    status:s.status, lineCount:(s.lines||[]).length, submittedBy:s.submittedByName||null, submittedAt:s.submittedAt||null,
    bapBy:s.bapByName||null, bapAt:s.bapAt||null, controlStatus:(s.control&&s.control.status)||null })));
});

/* --- Alerte congés dus (par période) : pour GPF & Paie --- */
router.get("/conge-alerts", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const period = (req.query.period||"").trim() || new Date().toISOString().slice(0,7);
  if(!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({error:"Période AAAA-MM"});
  const pfById={}; mine(db.portfolios, req).forEach(p=>{ pfById[p.id]=p.name; });
  const sheets = mine(db.payElementSheets, req).filter(s=>s.period===period);
  const handled = {}; // employeeId -> true if a bordereau line has congeAmount>0
  for(const sh of sheets) for(const l of (sh.lines||[])) if(Number(l.congeAmount)>0) handled[l.employeeId]=true;
  const rows=[];
  for(const e of mine(db.employees, req)){
    if((e.status||"").toUpperCase()==="ARCHIVED") continue;
    const ci=congeInfo(e, period, req);
    if(!ci.due) continue;
    rows.push({ employeeId:e.id, name:`${e.firstName||""} ${e.lastName||""}`.trim(), matricule:e.matricule||"",
      portfolio: pfById[e.portfolioId]||"", hireDate:ci.hireDate, seniority:ci.seniorityLabel,
      entitlementDays:ci.entitlementDays, accruedDays:ci.accruedDays, handled: !!handled[e.id] });
  }
  rows.sort((a,b)=>String(a.portfolio).localeCompare(String(b.portfolio))||String(a.name).localeCompare(String(b.name)));
  res.json({ period, count:rows.length, pending:rows.filter(r=>!r.handled).length, rows });
});

/* --- Calcul du congé d'un employé (détail) : SBM, diviseur, allocation annuelle, provision --- */
router.get("/conge-calc", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const { employeeId, period } = req.query;
  const e=mine(db.employees, req).find(x=>x.id===employeeId); if(!e) return res.status(404).json({error:"Employé introuvable"});
  const per=(period||"").trim()||new Date().toISOString().slice(0,7);
  const calc=congeCompute(e, per, req); const info=congeInfo(e, per, req);
  const conv=(e.contract&&e.contract.conventionId)?mine(db.conventions, req).find(c=>c.id===e.contract.conventionId):null;
  res.json(Object.assign({ employeeId:e.id, name:`${e.firstName||""} ${e.lastName||""}`.trim(), period:per,
    convention: conv?conv.name:"(config paie)", due:info.due, hireDate:info.hireDate, seniority:info.seniorityLabel,
    entitlementDays:info.entitlementDays, accruedDays:info.accruedDays }, calc));
});

/* --- Détail --- */
router.get("/bordereaux/:id", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  res.json(sheetOut(s, req));
});

/* --- Création (un par client/période) : amorce les lignes depuis le roster du portefeuille --- */
router.post("/bordereaux", allow("RP","ADM","GPF"), (req,res)=>{
  const b=req.body||{}; const period=(b.period||"").trim(); const portfolioId=(b.portfolioId||"").trim();
  if(!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({error:"Période attendue au format AAAA-MM"});
  if(!portfolioId) return res.status(400).json({error:"Client (portefeuille) obligatoire"});
  if(runLocked(period, req)) return res.status(409).json({error:"Période clôturée - création impossible"});
  const existing=mine(db.payElementSheets, req).filter(s=>s.period===period && s.portfolioId===portfolioId);
  const wantComplementaire=!!(b.complementaire===true || b.complementaire==="true");
  if(existing.length && !wantComplementaire)
    return res.status(409).json({error:"Un bordereau existe déjà pour ce client et cette période. Utilisez « Bordereau complémentaire » pour ajouter ou corriger des éléments après coup."});
  if(!existing.length && wantComplementaire)
    return res.status(409).json({error:"Aucun bordereau principal pour ce client/période - créez d'abord le bordereau initial."});
  let lines, kind, seq;
  if(wantComplementaire){
    // Complémentaire (régularisation) : reprend les lignes du dernier bordereau de la période
    // (valeurs pré-remplies), modifiables. À la soumission, il remplace les éléments injectés et recalcule.
    const last=existing.slice().sort((a,b)=>(a.seq||1)-(b.seq||1)).pop();
    lines=JSON.parse(JSON.stringify(last.lines||[]));
    kind="COMPLEMENTAIRE"; seq=(existing.reduce((m,x)=>Math.max(m,x.seq||1),1))+1;
  } else {
    const emps=mine(db.employees, req).filter(e=>(e.status||"").toUpperCase()!=="ARCHIVED" && e.portfolioId===portfolioId).sort((a,b)=>_empNomKey(a).localeCompare(_empNomKey(b), "fr", {sensitivity:"base"}));
    lines=emps.map(e=>blankLine(e, req)); kind="PRINCIPAL"; seq=1;
  }
  const s=stamp({ id:id("bord"), period, portfolioId, status:"BROUILLON", kind, seq,
    lines, signatures:[], events:[], control:null,
    createdBy:req.user.id, createdByName:req.user.fullName||"", createdAt:new Date().toISOString() }, req);
  db.payElementSheets.push(s);
  bEvent(s, req, wantComplementaire?"BORDEREAU_COMPLEMENTAIRE_CREE":"BORDEREAU_CREE", { employes:lines.length, seq });
  save(); res.status(201).json(sheetOut(s, req));
});

/* --- Enregistrer les lignes (brouillon) --- */
router.put("/bordereaux/:id/lines", allow("RP","ADM","GPF"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  if(s.status!=="BROUILLON") return res.status(409).json({error:"Bordereau déjà soumis - modification impossible. Il faut le rouvrir."});
  if(runLocked(s.period, req)) return res.status(409).json({error:"Période clôturée"});
  const incoming=Array.isArray(req.body&&req.body.lines)?req.body.lines:[];
  const byId={}; incoming.forEach(l=>{ if(l&&l.employeeId) byId[l.employeeId]=l; });
  const D=B_STD_DAYS(req); const clean=(n,min,max)=>{ n=Number(n)||0; if(n<min)n=min; if(max!=null&&n>max)n=max; return n; };
  let changes=0;
  for(const line of s.lines){
    const nu=byId[line.employeeId]; if(!nu) continue;
    const before=JSON.stringify(line);
    line.joursPresence=clean(nu.joursPresence, 0, 31);
    line.absence=clean(nu.absence, 0, 31);
    line.hs120=clean(nu.hs120,0,null); line.hs130=clean(nu.hs130,0,null); line.hs140=clean(nu.hs140,0,null); line.hsNuit=clean(nu.hsNuit,0,null);
    line.congeAmount=clean(nu.congeAmount,0,null);
    line.primes=Array.isArray(nu.primes)?nu.primes.filter(p=>p&&p.label&&Number(p.amount)>0).map(p=>({code:String(p.code||"2000").slice(0,10), label:String(p.label).slice(0,40), amount:Math.round(Number(p.amount)), cnps:p.cnps!==false, impo:p.impo!==false})):[];
    if(nu.custom && typeof nu.custom==="object"){ line.custom=line.custom||{}; const defs=fieldsForSheet(req, s.portfolioId); for(const d of defs){ const v=Number(nu.custom[d.key]); line.custom[d.key]=Number.isFinite(v)&&v>0?v:0; } }
    if(JSON.stringify(line)!==before) changes++;
  }
  bEvent(s, req, "BORDEREAU_LIGNES_MAJ", { lignesModifiees:changes });
  save(); res.json(sheetOut(s, req));
});

/* --- Rouvrir un brouillon soumis (avant contrôle) — GPF/ADM --- */
router.post("/bordereaux/:id/reopen", allow("GPF","ADM","CD"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  if(s.status==="BON_A_PAYER") return res.status(409).json({error:"Bordereau validé « Bon à payer » - réouverture interdite."});
  if(s.status==="BROUILLON") return res.json(sheetOut(s, req));
  const _computed=runComputed(s.period, req);
  if(_computed){
    // Après calcul de la paie, la réouverture n'est ouverte qu'à l'ADM / CD (dérogation tracée).
    // Le GPF passe par un bordereau complémentaire (régularisation).
    if(!["ADM","CD"].includes(req.user.role))
      return res.status(409).json({error:"La paie de cette période a déjà été calculée. Créez un « bordereau complémentaire » pour ajouter ou corriger des éléments (il recalculera les bulletins concernés)."});
  }
  s.status="BROUILLON"; s.control=null;
  bEvent(s, req, "BORDEREAU_ROUVERT", { motif:(req.body&&req.body.reason)||"", apresCalcul:_computed });
  save(); res.json(sheetOut(s, req));
});

/* --- Supprimer un bordereau (GPF/ADM) — impossible si « Bon à payer » --- */
router.delete("/bordereaux/:id", allow("GPF","ADM","CD"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  if(s.status==="BON_A_PAYER") return res.status(409).json({error:"Bordereau validé « Bon à payer » - suppression interdite."});
  if(runLocked(s.period, req)) return res.status(409).json({error:"Période clôturée"});
  // retirer les éléments variables injectés par ce bordereau
  const empIds=new Set((s.lines||[]).map(l=>l.employeeId));
  db.payElements=db.payElements.filter(e=>!(empIds.has(e.employeeId) && e.period===s.period && (e.tenantId||"t1")===(s.tenantId||"t1") && e.bordereauId===s.id));
  audit(req.user, "DELETED", "PayElementSheet", s.id, { period:s.period, portfolioId:s.portfolioId });
  db.payElementSheets.splice(db.payElementSheets.indexOf(s),1); save();
  res.json({ ok:true });
});

/** Injecte les éléments variables de la période pour les employés du bordereau (remplace les précédents issus du bordereau). */
function pushElementsFromSheet(s, req){
  const empIds=new Set(s.lines.map(l=>l.employeeId));
  db.payElements=db.payElements.filter(e=>!(empIds.has(e.employeeId) && e.period===s.period && (e.tenantId||"t1")===(s.tenantId||"t1") && e.fromBordereau));
  const add=(rec)=>{ db.payElements.push(stamp(Object.assign({id:id("pe"), period:s.period, fromBordereau:true, bordereauId:s.id, createdBy:req.user.id, createdAt:new Date().toISOString()}, rec), req)); };
  for(const l of s.lines){
    add({ employeeId:l.employeeId, type:"JOURS", days:Number(l.joursPresence)||0, label:"Jours de présence" });
    if(Number(l.absence)>0) add({ employeeId:l.employeeId, type:"ABSENCE", days:Number(l.absence), label:"Absence" });
    if(Number(l.hs120)>0) add({ employeeId:l.employeeId, type:"HS20", hours:Number(l.hs120), label:"HS 120%" });
    if(Number(l.hs130)>0) add({ employeeId:l.employeeId, type:"HS30", hours:Number(l.hs130), label:"HS 130%" });
    if(Number(l.hs140)>0) add({ employeeId:l.employeeId, type:"HS40", hours:Number(l.hs140), label:"HS 140%" });
    if(Number(l.hsNuit)>0) add({ employeeId:l.employeeId, type:"NUIT", hours:Number(l.hsNuit), label:"Heures de nuit" });
    for(const p of (l.primes||[])){
      add({ employeeId:l.employeeId, type:"PRIME", code:String(p.code||"2000"), amount:Math.round(Number(p.amount)), label:p.label, cnps:p.cnps!==false, impo:p.impo!==false });
    }
    if(Number(l.congeAmount)>0){ add({ employeeId:l.employeeId, type:"PRIME", code:"3702", amount:Math.round(Number(l.congeAmount)), label:"Congés annuels (allocation)", cnps:true, impo:true, conge:true }); }
    // colonnes personnalisées -> éléments mappés (rubrique/heures)
    const _defs=fieldsForSheet(req, s.portfolioId); const _rubs=mine(db.payRubriques, req);
    for(const d of _defs){ const v=Number((l.custom||{})[d.key]); if(!(v>0)) continue;
      if(d.kind==="HOURS"){ add({ employeeId:l.employeeId, type:d.overtimeType, hours:v, label:d.label, fieldKey:d.key }); }
      else { const rub=_rubs.find(r=>String(r.code)===String(d.rubriqueCode))||{}; add({ employeeId:l.employeeId, type:"PRIME", code:String(d.rubriqueCode||"2000"), amount:Math.round(v), label:d.label, cnps:!!rub.cnps, impo:!!rub.impo, fieldKey:d.key }); }
    }
  }
}

/* --- Soumettre & signer (GPF) : fige le snapshot + signe + injecte les éléments --- */
router.post("/bordereaux/:id/submit", allow("RP","ADM","GPF"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  if(s.status!=="BROUILLON") return res.status(409).json({error:"Bordereau déjà soumis."});
  if(runLocked(s.period, req)) return res.status(409).json({error:"Période clôturée"});
  if(!(s.lines||[]).length) return res.status(400).json({error:"Bordereau vide - aucun employé."});
  // snapshot figé (référence du contrôle)
  s.snapshot=JSON.parse(JSON.stringify(s.lines));
  s.snapshotHash=_sha(s.snapshot);
  s.status="SOUMIS";
  s.submittedBy=req.user.id; s.submittedByName=req.user.fullName||""; s.submittedAt=new Date().toISOString();
  const sig=esign(s, req, "SOUMISSION", s.snapshotHash);
  pushElementsFromSheet(s, req);
  // Si la paie de la période est déjà calculée (run ouvert), recalculer les bulletins concernés
  // afin qu'un bordereau complémentaire / corrigé se répercute immédiatement sur les paies.
  let _recalc=0;
  if(runComputed(s.period, req) && !runLocked(s.period, req)){
    for(const l of s.lines){ if(recomputeEmployeeOpenRun(req, s.period, l.employeeId)) _recalc++; }
  }
  bEvent(s, req, "BORDEREAU_SOUMIS_SIGNE", { empreinte:s.snapshotHash.slice(0,16), signature:sig.seq, employes:s.lines.length, bulletinsRecalcules:_recalc });
  save(); res.json(sheetOut(s, req));
});

/* --- Journal d'audit (timeline) --- */
router.get("/bordereaux/:id/audit", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  res.json({ events:(s.events||[]).slice().reverse(), signatures:s.signatures||[], snapshotHash:s.snapshotHash||null });
});
/* --- PDF du bordereau : éléments de salaire (comme l'Excel) + éléments variables + traçabilité --- */
router.get("/bordereaux/:id/pdf", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  const tenant=(db.tenants||[]).find(t=>(t.id)===(s.tenantId||"t1"))||{name:"Entreprise"};
  const pf=mine(db.portfolios, req).find(p=>p.id===s.portfolioId);
  const F=(n)=>{ n=Math.round(Number(n)||0); return n?String(n).replace(/\B(?=(\d{3})+(?!\d))/g," "):""; };
  const empById={}; mine(db.employees, req).forEach(e=>{ empById[e.id]=e; });
  // Construire la structure salariale par employé + l'union ordonnée des libellés de primes structurelles
  const struct={}; const gainLabels=[];
  for(const l of s.lines){ const e=empById[l.employeeId]; if(!e){ struct[l.employeeId]={base:0,gains:[],transport:0}; continue; }
    const st=structureToInput(e, req);
    const gains=(st.gains||[]).map(g=>({label:g.label||g.code||"Prime", amount:Number(g.amount)||0}));
    for(const g of gains) if(!gainLabels.includes(g.label)) gainLabels.push(g.label);
    struct[l.employeeId]={ base:Number(st.baseSalary)||0, gains, transport:(st.transport&&Number(st.transport.amount))||0 };
  }
  const gCols=gainLabels.slice(0,10); // borne raisonnable
  // Colonnes : fixes + salaire + variables
  const cols=[{h:"N°",w:18,a:"l"},{h:"Nom",w:110,a:"l"},{h:"Contrat",w:34,a:"l"},{h:"Cat",w:24,a:"l"},{h:"Embauche",w:50,a:"l",kind:"hire"},{h:"Anc.",w:60,a:"l",kind:"anc"},{h:"Sal. base",w:48,a:"r"}];
  gCols.forEach(g=>cols.push({h:g.length>12?g.slice(0,12):g,w:46,a:"r",gain:g}));
  cols.push({h:"Transport",w:46,a:"r",kind:"transport"});
  cols.push({h:"Brut contr.",w:52,a:"r",kind:"brut"});
  cols.push({h:"Prés.",w:28,a:"r",kind:"pres"});
  cols.push({h:"HS120",w:32,a:"r",kind:"hs120"},{h:"HS130",w:32,a:"r",kind:"hs130"},{h:"HS140",w:32,a:"r",kind:"hs140"},{h:"Nuit",w:26,a:"r",kind:"nuit"});
  cols.push({h:"Primes var.",w:52,a:"r",kind:"primesv"});
  cols.push({h:"Acompte",w:50,a:"r",kind:"acompte"});
  cols.push({h:"Éch. prêt",w:50,a:"r",kind:"pret"});
  cols.push({h:"Congé",w:48,a:"r",kind:"conge"});
  const doc=new PDFDocument({ size:"A4", layout:"landscape", margin:18 });
  const chunks=[]; doc.on("data",d=>chunks.push(d));
  doc.on("end",()=>{ const buf=Buffer.concat(chunks);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`inline; filename="Bordereau_${(pf?pf.name:"client").replace(/[^\w]/g,"_")}_${s.period}.pdf"`);
    res.end(buf);
  });
  const green="#0b7a4b", ink="#111827", grey="#6b7280", line="#d1d5db";
  const W=doc.page.width, M=18;
  // auto-fit : réduire proportionnellement si trop large
  let totW=cols.reduce((a,c)=>a+c.w,0); const avail=W-2*M;
  if(totW>avail){ const k=avail/totW; cols.forEach(c=>c.w=Math.max(16,Math.floor(c.w*k))); }
  let y=24;
  doc.fillColor(green).font("Helvetica-Bold").fontSize(13).text("Bordereau d'éléments de paie", M, y);
  doc.fillColor(ink).font("Helvetica").fontSize(9).text(tenant.name||"", M, y+1, {align:"right", width:W-2*M});
  y+=18;
  doc.fontSize(9).fillColor(ink).text(`Client : ${pf?pf.name:"(tous)"}     Période : ${s.period}     Statut : ${s.status}     Effectif : ${(s.lines||[]).length}`, M, y);
  y+=14;
  const rowH=15;
  const drawRow=(cells,opts)=>{ opts=opts||{}; let x=M; const h=opts.h||rowH;
    if(opts.fill){ doc.rect(M,y,cols.reduce((a,c)=>a+c.w,0),h).fill(opts.fill); }
    doc.font(opts.bold?"Helvetica-Bold":"Helvetica").fontSize(opts.size||6.5);
    for(let i=0;i<cols.length;i++){ const c=cols[i];
      doc.fillColor(opts.color||ink).text(String(cells[i]==null?"":cells[i]), x+2, y+4, {width:c.w-4, align:c.a, ellipsis:true, lineBreak:false});
      x+=c.w; }
    doc.moveTo(M,y+h).lineTo(M+cols.reduce((a,c)=>a+c.w,0),y+h).strokeColor(line).lineWidth(0.4).stroke();
    y+=h; };
  drawRow(cols.map(c=>c.h), {fill:"#e6f2ec", bold:true, color:green, h:20, size:6});
  let n=0; const T={base:0,transport:0,brut:0,acompte:0,pret:0,primesv:0};
  for(const l of s.lines){ n++;
    const stc=struct[l.employeeId]||{base:0,gains:[],transport:0};
    const gainAmt=(lbl)=>{ const g=(stc.gains||[]).find(x=>x.label===lbl); return g?g.amount:0; };
    const brut=stc.base+ (stc.gains||[]).reduce((a,g)=>a+g.amount,0) + stc.transport;
    const acompte=acompteTotal(l.employeeId, s.period, req);
    const pret=loanEcheance(l.employeeId, s.period, req).total;
    const primesv=(l.primes||[]).reduce((a,p)=>a+(Number(p.amount)||0),0);
    T.base+=stc.base; T.transport+=stc.transport; T.brut+=brut; T.acompte+=acompte; T.pret+=pret; T.primesv+=primesv;
    if(y>doc.page.height-72){ doc.addPage(); y=24; drawRow(cols.map(c=>c.h), {fill:"#e6f2ec", bold:true, color:green, h:20, size:6}); }
    const cells=cols.map(c=>{
      if(c.h==="N°") return n; if(c.h==="Nom") return l.name; if(c.h==="Contrat") return l.contrat||""; if(c.h==="Cat") return l.category||"";
      if(c.kind==="hire") return (l.hireDate||empHireDate(empById[l.employeeId]||{})||"").toString().slice(0,10);
      if(c.kind==="anc") return seniorityLabel(empById[l.employeeId]||{}, s.period);
      if(c.h==="Sal. base") return F(stc.base);
      if(c.gain) return F(gainAmt(c.gain));
      if(c.kind==="transport") return F(stc.transport);
      if(c.kind==="brut") return F(brut);
      if(c.kind==="pres") return F(l.joursPresence);
      if(c.kind==="hs120") return l.hs120||""; if(c.kind==="hs130") return l.hs130||""; if(c.kind==="hs140") return l.hs140||""; if(c.kind==="nuit") return l.hsNuit||"";
      if(c.kind==="primesv") return F(primesv);
      if(c.kind==="acompte") return F(acompte);
      if(c.kind==="pret") return F(pret);
      if(c.kind==="conge"){ const _ci=congeInfo(empById[l.employeeId]||{}, s.period, req); return _ci.due ? (Number(l.congeAmount)>0?F(l.congeAmount):"DÛ") : ""; }
      return "";
    });
    drawRow(cells, {size:6.5});
  }
  const totCells=cols.map(c=>{ if(c.h==="Nom") return "TOTAUX ("+n+")"; if(c.h==="Sal. base") return F(T.base); if(c.kind==="transport") return F(T.transport); if(c.kind==="brut") return F(T.brut); if(c.kind==="primesv") return F(T.primesv); if(c.kind==="acompte") return F(T.acompte); if(c.kind==="pret") return F(T.pret); return ""; });
  drawRow(totCells, {bold:true, fill:"#f3f4f6", h:18, size:6.5});
  y+=8;
  // détail des primes variables par employé (sous le tableau)
  const withPrimes=s.lines.filter(l=>(l.primes||[]).length);
  if(withPrimes.length){ doc.font("Helvetica-Bold").fontSize(8).fillColor(ink).text("Primes variables (détail)", M, y); y+=12;
    doc.font("Helvetica").fontSize(7).fillColor(ink);
    for(const l of withPrimes){ const t=(l.primes||[]).map(p=>`${p.label} ${F(p.amount)}`).join("  ·  "); doc.text(`${l.name} : ${t}`, M, y, {width:W-2*M}); y+=10; if(y>doc.page.height-70){ doc.addPage(); y=24; } }
    y+=6;
  }
  // traçabilité + signatures
  const sigSoum=(s.signatures||[]).find(x=>x.kind==="SOUMISSION");
  const sigBap=(s.signatures||[]).find(x=>x.kind==="BON_A_PAYER");
  doc.font("Helvetica").fontSize(8).fillColor(grey);
  doc.text(`Créé par : ${s.createdByName||"-"}  ·  Généré/imprimé par : ${req.user.fullName||""} le ${new Date().toISOString().slice(0,16).replace("T"," ")}`, M, y); y+=12;
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(9).text("Signatures électroniques", M, y); y+=13;
  doc.font("Helvetica").fontSize(8);
  if(sigSoum) doc.fillColor(ink).text(`Soumis & signé (GPF) : ${sigSoum.name} (${sigSoum.role}) le ${sigSoum.at.slice(0,16).replace("T"," ")} — empreinte SHA-256 : ${(sigSoum.sha256||"").slice(0,24)}…`, M, y, {width:W-2*M});
  else doc.fillColor(grey).text("Soumis & signé (GPF) : en attente", M, y);
  y+=12;
  if(sigBap) doc.fillColor(ink).text(`Bon à payer (${sigBap.role}) : ${sigBap.name} le ${sigBap.at.slice(0,16).replace("T"," ")} — empreinte SHA-256 : ${(sigBap.sha256||"").slice(0,24)}…`, M, y, {width:W-2*M});
  else doc.fillColor(grey).text("Bon à payer : en attente (CD / Audit)", M, y);
  y+=15;
  doc.fillColor(grey).fontSize(7).text("Document généré par SGRHP — MBOKA Mon RH. Toute modification postérieure à la signature est tracée dans le journal d'audit.", M, y, {width:W-2*M});
  bEvent(s, req, "BORDEREAU_PDF_GENERE", {}); save();
  doc.end();
});

/* --- Rapprochement automatique : snapshot signé (GPF) vs paie calculée --- */
function buildControl(s, req){
  const run=mine(db.payRuns, req).slice().sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||"")).find(r=>r.period===s.period);
  const slips = run ? mine(db.payslips, req).filter(x=>x.runId===run.id) : [];
  const slipByEmp={}; slips.forEach(x=>{ slipByEmp[x.employeeId]=x; });
  const _nk=nomSorter(req); const ref = (s.snapshot || s.lines || []).slice().sort((a,b)=>_nk(a.employeeId,b.employeeId));
  const acks = (s.control&&s.control.acks) || [];
  const ackOf=(emp,field)=> acks.find(a=>a.employeeId===emp&&a.field===field);
  const cmp=(emp,field,label,soumis,calcule,detail)=>{
    soumis=Math.round(Number(soumis)||0); calcule=Math.round(Number(calcule)||0);
    const st = soumis===calcule ? "OK" : "ECART";
    const a = st==="ECART" ? ackOf(emp,field) : null;
    return { field, label, soumis, calcule, delta:calcule-soumis, status:(st==="ECART"&&a)?"ACK":st, reason:a?a.reason:null, detail:detail||null };
  };
  let ecarts=0, nonCalcule=0; const lines=[];
  for(const l of ref){
    const sl=slipByEmp[l.employeeId];
    if(!sl){ nonCalcule++; lines.push({ employeeId:l.employeeId, name:l.name, status:"NON_CALCULE", checks:[] }); continue; }
    const inp=sl.input||{}; const ot=inp.overtime||{};
    const od=(inp.otherDeductions||[]);
    const sumOD=(code)=> od.filter(d=>String(d.code)===code).reduce((a,d)=>a+(Number(d.amount)||0),0);
    const loanE=loanEcheance(l.employeeId, s.period, req);
    const loan=loanE.total;
    const primesSoumis=(l.primes||[]).reduce((a,p)=>a+(Number(p.amount)||0),0);
    // Primes calculées = éléments variables réellement injectés (fromBordereau) pour cet employé/période.
    const primeTypes=new Set(["PRIME","RAPPEL","TREIZE","INDEMNITE"]);
    const injected=mine(db.payElements, req).filter(e=>e.employeeId===l.employeeId && e.period===s.period && e.fromBordereau && primeTypes.has(e.type) && !e.fieldKey && !e.conge);
    const gainsFromEls=injected.reduce((a,e)=>a+(Number(e.amount)||0),0);
    const acoList=acompteList(l.employeeId, s.period, req);
    const brouillons=acoList.filter(a=>a.status!=="VALIDE");
    const TS="Feuille de temps signée (GPF) → bulletin calculé (Paie)";
    const checks=[
      cmp(l.employeeId,"jours","Jours de présence", l.joursPresence, inp.workedDays, { groupe:"Temps", source:TS, items:[{k:"Feuille signée",v:(l.joursPresence||0)+" j"},{k:"Bulletin calculé",v:(inp.workedDays||0)+" j"}] }),
      cmp(l.employeeId,"hs120","HS 120%", l.hs120, ot.tier1, { groupe:"Temps", source:TS, items:[{k:"Feuille signée",v:(l.hs120||0)+" h"},{k:"Bulletin calculé",v:(ot.tier1||0)+" h"}] }),
      cmp(l.employeeId,"hs130","HS 130%", l.hs130, ot.tier2, { groupe:"Temps", source:TS, items:[{k:"Feuille signée",v:(l.hs130||0)+" h"},{k:"Bulletin calculé",v:(ot.tier2||0)+" h"}] }),
      cmp(l.employeeId,"hs140","HS 140%", l.hs140, ot.tier3, { groupe:"Temps", source:TS, items:[{k:"Feuille signée",v:(l.hs140||0)+" h"},{k:"Bulletin calculé",v:(ot.tier3||0)+" h"}] }),
      cmp(l.employeeId,"nuit","Heures de nuit", l.hsNuit, ot.night, { groupe:"Temps", source:TS, items:[{k:"Feuille signée",v:(l.hsNuit||0)+" h"},{k:"Bulletin calculé",v:(ot.night||0)+" h"}] }),
      cmp(l.employeeId,"primes","Primes variables (total)", primesSoumis, gainsFromEls, { groupe:"Temps", source:"Primes du bordereau signé → éléments injectés en paie", items:(l.primes||[]).map(p=>({k:p.label,v:String(Math.round(p.amount)).replace(/\B(?=(\d{3})+(?!\d))/g," ")})) }),
      cmp(l.employeeId,"acompte","Acompte sur salaire", acompteTotalAll(l.employeeId, s.period, req), sumOD("7000"), { groupe:"Acompte", source:"Registre des acomptes (tous statuts) → retenue sur bulletin (validés uniquement)", items:acoList.map(a=>({k:(a.momo?("N° "+a.momo):"Acompte")+" — "+(a.status==="VALIDE"?"Validé":"Brouillon"),v:String(a.amount).replace(/\B(?=(\d{3})+(?!\d))/g," ")})), note:brouillons.length?(brouillons.length+" acompte(s) en brouillon non retenu(s) — à valider dans « Acomptes sur salaire »."):"" }),
      cmp(l.employeeId,"pret","Échéance prêt", loan, sumOD("7010"), { groupe:"Acompte", source:"Échéancier de prêt → retenue sur bulletin", items:(loanE.detail||[]).map(d=>({k:d.label+" ("+d.n+"/"+d.of+")",v:String(d.amount).replace(/\B(?=(\d{3})+(?!\d))/g," ")})) }),
    ];
    // colonnes personnalisées : bordereau signé vs élément injecté (par fieldKey)
    const _cdefs=fieldsForSheet(req, s.portfolioId);
    for(const d of _cdefs){
      const soum=Number((l.custom||{})[d.key])||0;
      const injEls=mine(db.payElements, req).filter(e=>e.employeeId===l.employeeId && e.period===s.period && e.fromBordereau && e.fieldKey===d.key);
      const calc=injEls.reduce((a,e)=>a+(Number(d.kind==="HOURS"?e.hours:e.amount)||0),0);
      checks.push(cmp(l.employeeId,"cf_"+d.key,d.label, soum, calc, { groupe:"Temps", source:"Colonne personnalisée → élément injecté ("+(d.kind==="HOURS"?d.overtimeType:("rubrique "+d.rubriqueCode))+")", items:[{k:"Bordereau signé",v:String(soum)},{k:"Injecté en paie",v:String(calc)}] }));
    }
    // Congé : si le congé de l'employé est dû ce mois (anniversaire d'embauche), il doit être traité.
    const _emp=mine(db.employees, req).find(e=>e.id===l.employeeId)||{};
    const ci=congeInfo(_emp, s.period, req);
    if(ci.due){
      const soumC=Math.round(Number(l.congeAmount)||0);
      const congeEl=mine(db.payElements, req).filter(e=>e.employeeId===l.employeeId && e.period===s.period && e.fromBordereau && e.conge).reduce((a,e)=>a+(Number(e.amount)||0),0);
      const calcC=Math.round(congeEl);
      const ackC=acks.find(a=>a.employeeId===l.employeeId&&a.field==="conge");
      let st = (soumC===calcC && soumC>0) ? "OK" : "ECART";
      if(st==="ECART" && ackC) st="ACK";
      checks.push({ field:"conge", label:"Congé dû ce mois", soumis:soumC, calcule:calcC, delta:calcC-soumC, status:st, reason:ackC?ackC.reason:null,
        detail:{ groupe:"Congé", source:"Dû d'après la date d'embauche ("+(ci.hireDate||"")+") et l'ancienneté",
          note: soumC>0 ? "" : "Congé DÛ ce mois — indemnité non saisie. Payez l'allocation de congé, ou justifiez un report.",
          items:[ {k:"Ancienneté",v:ci.seniorityLabel||(ci.seniorityYears+" an(s)")}, {k:"Droit annuel",v:(ci.entitlementDays!=null?ci.entitlementDays+" j":"—")}, {k:"Acquis",v:(ci.accruedDays!=null?ci.accruedDays+" j":"—")}, {k:"Indemnité saisie",v:String(soumC)} ] } });
    }
    const lineEcarts=checks.filter(c=>c.status==="ECART").length;
    ecarts+=lineEcarts;
    lines.push({ employeeId:l.employeeId, name:l.name, net:sl.result&&sl.result.totals?sl.result.totals.netAPayer:0,
      status: lineEcarts>0?"ECART":(checks.some(c=>c.status==="ACK")?"ACK":"OK"), checks });
  }
  const openEcarts=lines.reduce((a,ln)=>a+ln.checks.filter(c=>c.status==="ECART").length,0);
  return { at:new Date().toISOString(), runId:run?run.id:null, computed:!!run&&slips.length>0,
    status: (!run||!slips.length)?"NON_CALCULE" : (openEcarts>0?"ECARTS":"CONFORME"),
    counts:{ lignes:lines.length, ecarts:openEcarts, nonCalcule }, acks, lines };
}

router.post("/bordereaux/:id/control", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  if(s.status==="BROUILLON") return res.status(409).json({error:"Bordereau non soumis - rien à contrôler."});
  const prevAcks=(s.control&&s.control.acks)||[];
  s.control=buildControl(s, req); s.control.acks=prevAcks;
  s.control=buildControl(s, req); // rebuild with acks applied
  if(s.status==="SOUMIS") s.status="CONTROLE";
  bEvent(s, req, "CONTROLE_EXECUTE", { statut:s.control.status, ecarts:s.control.counts.ecarts, nonCalcule:s.control.counts.nonCalcule });
  save(); res.json(sheetOut(s, req));
});

/* --- Justifier un écart (motif obligatoire) --- */
router.post("/bordereaux/:id/ack", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  const { employeeId, field, reason } = req.body||{};
  if(!employeeId||!field||!String(reason||"").trim()) return res.status(400).json({error:"employeeId, field et motif obligatoires"});
  s.control=s.control||buildControl(s, req); s.control.acks=s.control.acks||[];
  s.control.acks=s.control.acks.filter(a=>!(a.employeeId===employeeId&&a.field===field));
  s.control.acks.push({ employeeId, field, reason:String(reason).slice(0,240), by:req.user.fullName||"", role:req.user.role, at:new Date().toISOString() });
  s.control=buildControl(s, req);
  bEvent(s, req, "ECART_JUSTIFIE", { employeeId, field, motif:String(reason).slice(0,120) });
  save(); res.json(sheetOut(s, req));
});

/* --- Bon à payer (CD / Audit) : signature + contrôle de séparation des tâches --- */
router.post("/bordereaux/:id/bon-a-payer", allow("CD","ADM","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  if(s.status==="BROUILLON") return res.status(409).json({error:"Bordereau non soumis."});
  if(s.status==="BON_A_PAYER") return res.status(409).json({error:"Déjà validé Bon à payer."});
  if(s.submittedBy===req.user.id) return res.status(403).json({error:"Séparation des tâches : le signataire du Bon à payer doit être différent du GPF qui a soumis le bordereau."});
  s.control=buildControl(s, req);
  if(!s.control.computed) return res.status(409).json({error:"La paie n'est pas encore calculée pour cette période."});
  const unjustified=[];
  for(const ln of s.control.lines) for(const c of ln.checks) if(c.status==="ECART") unjustified.push(`${ln.name} · ${c.label}`);
  if(unjustified.length) return res.status(409).json({error:`Écarts non justifiés (${unjustified.length}) : ${unjustified.slice(0,5).join(" ; ")}${unjustified.length>5?" …":""}. Justifiez chaque écart avant de signer.`, unjustified});
  const payload=_sha({snapshot:s.snapshot, control:s.control.lines});
  s.status="BON_A_PAYER"; s.bapBy=req.user.id; s.bapByName=req.user.fullName||""; s.bapAt=new Date().toISOString();
  const sig=esign(s, req, "BON_A_PAYER", payload);
  bEvent(s, req, "BON_A_PAYER_SIGNE", { signataire:req.user.fullName||"", role:req.user.role, signature:sig.seq, empreinte:payload.slice(0,16) });
  save(); res.json(sheetOut(s, req));
});
/* =================================================================== *
 *  ACOMPTES SUR SALAIRE  (registre dédié, par client & période)       *
 *  Mireroir de l'Excel : client, employé, n° OM/MOMO, montant.        *
 *  Retenu à 100% sur le mois (le moteur de paie lit ce registre).     *
 * =================================================================== */
function _empNomKey(e){ return (((e&&e.lastName)||"")+" "+((e&&e.firstName)||"")).trim().toLowerCase(); }
function nomSorter(req){ const m={}; mine(db.employees, req).forEach(e=>{ m[e.id]=_empNomKey(e); }); return (idA,idB)=> (m[idA]||"").localeCompare(m[idB]||"", "fr", {sensitivity:"base"}); }
/* Canal effectif d'un acompte : explicite, sinon déduit de l'opérateur du numéro. */
function acompteChannel(a){ if(a&&(a.channel==="OM"||a.channel==="MOMO")) return a.channel; const op=_phone.cmOperator(a&&a.momo); if(op==="ORANGE")return "OM"; if(op==="MTN")return "MOMO"; return "AUTRE"; }
function acompteChannelKey(a){ const c=(a&&a.channel)||acompteChannel(a); return (c==="OM"||c==="MOMO")?c:"AUTRE"; }
function acompteOut(a, req){
  const pf=mine(db.portfolios, req).find(p=>p.id===a.portfolioId);
  const e=mine(db.employees, req).find(x=>x.id===a.employeeId);
  return Object.assign({}, a, { portfolioName:pf?pf.name:"", employeeName:a.employeeName||(e?`${e.firstName||""} ${e.lastName||""}`.trim():""), matricule:a.matricule||(e?(e.matricule||""):"") });
}
router.get("/acomptes", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const { period, portfolioId, employeeId } = req.query;
  let list=mine(db.payAcomptes, req);
  if(period) list=list.filter(a=>a.period===period);
  if(portfolioId) list=list.filter(a=>a.portfolioId===portfolioId);
  if(employeeId) list=list.filter(a=>a.employeeId===employeeId);
  const _nk=nomSorter(req); res.json(list.slice().sort((a,b)=>(b.period||"").localeCompare(a.period||"")||_nk(a.employeeId,b.employeeId)).map(a=>Object.assign(acompteOut(a, req),{channel:acompteChannel(a)})));
});
/** Net mensuel estimé de l'employé pour la période (pour la règle du tiers). 0 si incalculable. */
function netEstimate(emp, period, req){
  try { if(!baseSalaryOf(emp, req)) return 0; const { result }=computeFor(emp, period, req); return Math.round((result&&result.totals&&result.totals.netAPayer)||0); }
  catch(e){ return 0; }
}
/** Valide canal + numéro OM/MOMO. Renvoie {ok, error?} ou {mismatch, detected, expected}. */
function validateAcompteMoney(b){
  const channel=String(b.channel||"").toUpperCase();
  if(!["OM","MOMO"].includes(channel)) return { error:"Choisissez le canal : Orange Money (OM) ou MTN Mobile Money (MOMO)." };
  const num=_phone.normalizeCmPhone(b.momo);
  if(!_phone.isCmMobile(num)) return { error:"Numéro mobile camerounais invalide (9 chiffres commençant par 6)." };
  const detected=_phone.cmOperator(num), expected=_phone.channelOperator(channel);
  if(detected && expected && detected!==expected && b.confirmMismatch!==true)
    return { mismatch:true, detected, expected, num, channel,
      message:`Ce numéro semble être ${_phone.operatorLabel(detected)}, alors que vous avez choisi ${channel==="OM"?"Orange Money":"MTN Mobile Money"} (${_phone.operatorLabel(expected)}). Vérifiez le numéro, ou confirmez si le compte a été porté.` };
  return { ok:true, channel, num };
}

router.post("/acomptes", allow("RP","ADM","GPF","CD"), (req,res)=>{
  const b=req.body||{}; const period=(b.period||"").trim();
  if(!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({error:"Période attendue au format AAAA-MM"});
  if(!b.employeeId) return res.status(400).json({error:"Employé obligatoire"});
  const amount=Math.round(Number(b.amount)||0);
  if(!(amount>0)) return res.status(400).json({error:"Montant obligatoire"});
  if(runLocked(period, req)) return res.status(409).json({error:"Période clôturée - saisie impossible"});
  const e=mine(db.employees, req).find(x=>x.id===b.employeeId);
  if(!e) return res.status(404).json({error:"Employé introuvable"});
  // 1) Canal + numéro OM/MOMO
  const mv=validateAcompteMoney(b);
  if(mv.error) return res.status(400).json({error:mv.error});
  if(mv.mismatch) return res.status(409).json({reason:"OPERATOR_MISMATCH", detectedOperator:mv.detected, expectedOperator:mv.expected, message:mv.message});
  // 2) Règle du tiers : l'acompte ne doit pas dépasser 1/3 du net (sauf approbation CD/ADM ou passage en prêt)
  const net=netEstimate(e, period, req);
  const maxThird=Math.floor(net/3);
  const isMgr=["CD","ADM"].includes(req.user.role);
  let overThird=false;
  if(net>0 && amount>maxThird){
    if(b.approveOverThird===true && isMgr){ overThird=true; }
    else return res.status(409).json({ reason:"OVER_THIRD", maxThird, net, amount,
      canApprove:isMgr,
      message:`Cet acompte (${amount.toLocaleString("fr-FR")} FCFA) dépasse le tiers du salaire net (max ${maxThird.toLocaleString("fr-FR")} FCFA sur un net estimé de ${net.toLocaleString("fr-FR")} FCFA). Créez un prêt (échéancier), ou faites approuver le dépassement par un CD/Administrateur.` });
  }
  const a=stamp({ id:id("aco"), period, portfolioId:b.portfolioId||(e&&e.portfolioId)||"", employeeId:b.employeeId,
    employeeName:`${e.firstName||""} ${e.lastName||""}`.trim(), matricule:e.matricule||"",
    channel:mv.channel, momo:mv.num, amount, note:String(b.note||"").slice(0,120),
    netRef:net, maxThird, overThird, overThirdApprovedBy: overThird?req.user.id:null, overThirdApprovedByName: overThird?(req.user.fullName||""):null,
    status:"BROUILLON", createdBy:req.user.id, createdByName:req.user.fullName||"", createdAt:new Date().toISOString() }, req);
  db.payAcomptes.push(a); recomputeEmployeeOpenRun(req, a.period, a.employeeId); save();
  audit(req.user, "CREATED", "PayAcompte", a.id, { period, employeeId:a.employeeId, amount, channel:mv.channel, overThird });
  res.status(201).json(acompteOut(a, req));
});
router.put("/acomptes/:id", allow("RP","ADM","GPF","CD"), (req,res)=>{
  const a=mine(db.payAcomptes, req).find(x=>x.id===req.params.id); if(!a) return res.status(404).json({error:"Acompte introuvable"});
  if(runComputed(a.period, req)) return res.status(409).json({error:"La paie de cette période a été calculée - acompte figé (corrigez par régularisation le mois suivant)."});
  if(a.status==="VALIDE") return res.status(409).json({error:"Acompte validé - dévalidez-le avant de le modifier."});
  const b=req.body||{}; const e=mine(db.employees, req).find(x=>x.id===a.employeeId)||{};
  // canal/numéro si modifiés
  if(b.channel!=null || b.momo!=null){
    const mv=validateAcompteMoney({ channel:b.channel!=null?b.channel:a.channel, momo:b.momo!=null?b.momo:a.momo, confirmMismatch:b.confirmMismatch });
    if(mv.error) return res.status(400).json({error:mv.error});
    if(mv.mismatch) return res.status(409).json({reason:"OPERATOR_MISMATCH", detectedOperator:mv.detected, expectedOperator:mv.expected, message:mv.message});
    a.channel=mv.channel; a.momo=mv.num;
  }
  if(b.amount!=null){
    const amount=Math.round(Number(b.amount)||0);
    if(!(amount>0)) return res.status(400).json({error:"Montant invalide"});
    const net=netEstimate(e, a.period, req); const maxThird=Math.floor(net/3); const isMgr=["CD","ADM"].includes(req.user.role);
    if(net>0 && amount>maxThird){
      if(b.approveOverThird===true && isMgr){ a.overThird=true; a.overThirdApprovedBy=req.user.id; a.overThirdApprovedByName=req.user.fullName||""; }
      else return res.status(409).json({ reason:"OVER_THIRD", maxThird, net, amount, canApprove:isMgr,
        message:`Cet acompte (${amount.toLocaleString("fr-FR")} FCFA) dépasse le tiers du net (max ${maxThird.toLocaleString("fr-FR")} FCFA). Créez un prêt, ou faites approuver le dépassement par un CD/Administrateur.` });
    }
    a.amount=amount; a.netRef=net; a.maxThird=maxThird;
  }
  if(b.note!=null) a.note=String(b.note).slice(0,120);
  recomputeEmployeeOpenRun(req, a.period, a.employeeId); save(); audit(req.user, "UPDATED", "PayAcompte", a.id, { amount:a.amount });
  res.json(acompteOut(a, req));
});
router.delete("/acomptes/:id", allow("RP","ADM","GPF","CD"), (req,res)=>{
  const a=mine(db.payAcomptes, req).find(x=>x.id===req.params.id); if(!a) return res.status(404).json({error:"Acompte introuvable"});
  if(runComputed(a.period, req)) return res.status(409).json({error:"La paie de cette période a été calculée - acompte figé (corrigez par régularisation le mois suivant)."});
  if(a.status==="VALIDE") return res.status(409).json({error:"Acompte validé - dévalidez-le avant de le supprimer."});
  const _p=a.period, _e=a.employeeId; db.payAcomptes.splice(db.payAcomptes.indexOf(a),1); recomputeEmployeeOpenRun(req, _p, _e); save();
  audit(req.user, "DELETED", "PayAcompte", a.id, { period:_p, employeeId:_e });
  res.json({ ok:true });
});
/* Acompte total d'un employé sur une période (utilisé par le contrôle du bordereau). */
function acompteTotal(empId, period, req){
  return mine(db.payAcomptes, req).filter(a=>a.employeeId===empId && a.period===period && a.status==="VALIDE").reduce((s,a)=>s+(Number(a.amount)||0),0);
}
function acompteTotalAll(empId, period, req){
  return mine(db.payAcomptes, req).filter(a=>a.employeeId===empId && a.period===period).reduce((s,a)=>s+(Number(a.amount)||0),0);
}
function acompteList(empId, period, req){
  return mine(db.payAcomptes, req).filter(a=>a.employeeId===empId && a.period===period).map(a=>({amount:Number(a.amount)||0, momo:a.momo||"", status:a.status||"BROUILLON"}));
}
/* Recalcule le bulletin d'un employé si la paie du mois est déjà calculée (et non clôturée),
   afin qu'un changement d'acompte soit immédiatement répercuté sur la paie. */
function recomputeEmployeeOpenRun(req, period, employeeId){
  const run=mine(db.payRuns, req).find(r=>r.period===period && r.status!=="CLOSED");
  if(!run) return false;
  const emp=mine(db.employees, req).find(e=>e.id===employeeId);
  if(!emp || !baseSalaryOf(emp, req)) return false;
  const existing=mine(db.payslips, req).find(x=>x.runId===run.id && x.employeeId===emp.id);
  if(!existing) return false;
  const { input, result }=computeFor(emp, run.period, req);
  existing.input=input; existing.result=result; existing.status="CALCULATED"; existing.recomputedAt=new Date().toISOString();
  run.count=mine(db.payslips, req).filter(x=>x.runId===run.id).length;
  return true;
}
/* --- Acompte : validation workflow (BROUILLON -> VALIDE) --- */
router.post("/acomptes/:id/validate", allow("CD","ADM","RJ"), (req,res)=>{
  const a=mine(db.payAcomptes, req).find(x=>x.id===req.params.id); if(!a) return res.status(404).json({error:"Acompte introuvable"});
  if(runLocked(a.period, req)) return res.status(409).json({error:"Période clôturée"});
  if(a.status==="VALIDE") return res.status(409).json({error:"Déjà validé"});
  a.status="VALIDE"; a.validatedBy=req.user.id; a.validatedByName=req.user.fullName||""; a.validatedAt=new Date().toISOString();
  recomputeEmployeeOpenRun(req, a.period, a.employeeId); save(); audit(req.user, "VALIDATED", "PayAcompte", a.id, { period:a.period, employeeId:a.employeeId, amount:a.amount });
  res.json(acompteOut(a, req));
});
router.post("/acomptes/:id/unvalidate", allow("CD","ADM"), (req,res)=>{
  const a=mine(db.payAcomptes, req).find(x=>x.id===req.params.id); if(!a) return res.status(404).json({error:"Acompte introuvable"});
  if(runComputed(a.period, req)) return res.status(409).json({error:"La paie de cette période a été calculée - dévalidation impossible (corrigez par régularisation le mois suivant)."});
  a.status="BROUILLON"; delete a.validatedBy; delete a.validatedByName; delete a.validatedAt;
  recomputeEmployeeOpenRun(req, a.period, a.employeeId); save(); audit(req.user, "UNVALIDATED", "PayAcompte", a.id, { period:a.period });
  res.json(acompteOut(a, req));
});
/* Valider en lot tous les brouillons d'un client/période. */
router.post("/acomptes/validate-batch", allow("CD","ADM","RJ"), (req,res)=>{
  const { period, portfolioId } = req.body||{};
  let list=mine(db.payAcomptes, req).filter(a=>a.status!=="VALIDE");
  if(period) list=list.filter(a=>a.period===period);
  if(portfolioId) list=list.filter(a=>a.portfolioId===portfolioId);
  let n=0; const touched=new Set(); for(const a of list){ if(runLocked(a.period, req)) continue; a.status="VALIDE"; a.validatedBy=req.user.id; a.validatedByName=req.user.fullName||""; a.validatedAt=new Date().toISOString(); touched.add(a.period+"|"+a.employeeId); n++; }
  for(const k of touched){ const [p,e]=k.split("|"); recomputeEmployeeOpenRun(req, p, e); }
  save(); audit(req.user, "VALIDATED_BATCH", "PayAcompte", "", { period, portfolioId, count:n });
  res.json({ ok:true, validated:n });
});

/* --- Export des acomptes (pdf / xlsx / csv) --- */
function acompteRows(req, period, portfolioId){
  let list=mine(db.payAcomptes, req);
  if(period) list=list.filter(a=>a.period===period);
  if(portfolioId) list=list.filter(a=>a.portfolioId===portfolioId);
  const _nk=nomSorter(req); return list.map(a=>Object.assign(acompteOut(a, req),{channel:acompteChannel(a)})).sort((x,y)=>_nk(x.employeeId,y.employeeId));
}
router.get("/acomptes/export", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const { period, portfolioId, format } = req.query;
  const rows=acompteRows(req, period, portfolioId);   // triés par NOM, avec canal effectif
  const fmt=(format||"pdf").toLowerCase();
  const F=(n)=>String(Math.round(Number(n)||0)).replace(/\B(?=(\d{3})+(?!\d))/g," ");
  const CH=[{k:"OM",label:"ORANGE MONEY (OM)"},{k:"MOMO",label:"MTN MOBILE MONEY (MOMO)"},{k:"AUTRE",label:"AUTRES"}];
  const groups=CH.map(c=>({ ...c, items:rows.filter(a=>acompteChannelKey(a)===c.k) })).filter(g=>g.items.length);
  const grand=rows.reduce((t,a)=>t+(Number(a.amount)||0),0);
  const fname=`Acomptes_${period||"tous"}`;
  const head=["Client","Employé","N° mobile","Montant","Statut"];

  if(fmt==="csv"){
    const lines=[["ACOMPTES SUR SALAIRE — "+(period||"toutes périodes")],[]];
    for(const g of groups){ const sub=g.items.reduce((t,a)=>t+(Number(a.amount)||0),0);
      lines.push([g.label+" — "+g.items.length+" acompte(s)"]); lines.push(head);
      for(const a of g.items) lines.push([a.portfolioName||"", a.employeeName||"", _phone.formatCmPhone(a.momo)||a.momo||"", a.amount||0, a.status==="VALIDE"?"Validé":"Brouillon"]);
      lines.push(["","","SOUS-TOTAL "+g.k, sub, ""]); lines.push([]);
    }
    lines.push(["","","TOTAL GÉNÉRAL", grand, ""]);
    return sendCSV(res, fname+".csv", lines);
  }
  if(fmt==="xlsx"){
    let XLSX; try{ XLSX=require("xlsx"); }catch(e){ return res.status(500).json({error:"Module Excel indisponible"}); }
    if(!(XLSX&&XLSX.utils&&typeof XLSX.utils.aoa_to_sheet==="function")) return res.status(500).json({error:"Export Excel indisponible sur ce serveur"});
    const aoa=[["ACOMPTES SUR SALAIRE — "+(period||"toutes périodes")],[]];
    for(const g of groups){ const sub=g.items.reduce((t,a)=>t+(Number(a.amount)||0),0);
      aoa.push([g.label+" — "+g.items.length+" acompte(s)"]); aoa.push(head);
      for(const a of g.items) aoa.push([a.portfolioName||"", a.employeeName||"", _phone.formatCmPhone(a.momo)||a.momo||"", a.amount||0, a.status==="VALIDE"?"Validé":"Brouillon"]);
      aoa.push(["","","SOUS-TOTAL "+g.k, sub, ""]); aoa.push([]);
    }
    aoa.push(["","","TOTAL GÉNÉRAL", grand, ""]);
    const ws=XLSX.utils.aoa_to_sheet(aoa); ws["!cols"]=[{wch:20},{wch:28},{wch:16},{wch:12},{wch:12}];
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Acomptes");
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="${fname}.xlsx"`);
    return res.send(XLSX.write(wb, { type:"buffer", bookType:"xlsx" }));
  }
  // PDF — une SECTION par canal (OM / MOMO), chacune avec son sous-total
  const tenant=(db.tenants||[]).find(t=>(t.id)===(req.user.tenantId||"t1"))||{name:""};
  const doc=new PDFDocument({ size:"A4", margin:36 });
  const chunks=[]; doc.on("data",d=>chunks.push(d));
  doc.on("end",()=>{ res.setHeader("Content-Type","application/pdf"); res.setHeader("Content-Disposition",`inline; filename="${fname}.pdf"`); res.end(Buffer.concat(chunks)); });
  const green="#0b7a4b", ink="#111827", line="#d1d5db"; const W=doc.page.width, M=36; let y=40;
  doc.fillColor(green).font("Helvetica-Bold").fontSize(15).text("Acomptes sur salaire", M, y);
  doc.fillColor(ink).font("Helvetica").fontSize(10).text(tenant.name||"", M, y+2, {align:"right", width:W-2*M}); y+=22;
  doc.fontSize(10).text(`Période : ${period||"toutes"}     Nombre : ${rows.length}`, M, y); y+=18;
  const cols=[{h:"Client",w:120,a:"l"},{h:"Employé",w:160,a:"l"},{h:"N° mobile",w:95,a:"l"},{h:"Montant",w:75,a:"r"},{h:"Statut",w:0,a:"l"}];
  let used=cols.reduce((a,c)=>a+c.w,0); cols[cols.length-1].w=W-2*M-used;
  const row=(cells,o)=>{ o=o||{}; let x=M; const h=o.h||16; if(o.fill){ doc.rect(M,y,W-2*M,h).fill(o.fill); }
    doc.font(o.bold?"Helvetica-Bold":"Helvetica").fontSize(o.size||9);
    for(let i=0;i<cols.length;i++){ doc.fillColor(o.color||ink).text(String(cells[i]==null?"":cells[i]),x+3,y+4,{width:cols[i].w-6,align:cols[i].a,ellipsis:true,lineBreak:false}); x+=cols[i].w; }
    doc.moveTo(M,y+h).lineTo(W-M,y+h).strokeColor(line).lineWidth(0.5).stroke(); y+=h; };
  const sectionBanner=(g)=>{ if(y>doc.page.height-90){ doc.addPage(); y=40; }
    const col=g.k==="OM"?"#c2410c":(g.k==="MOMO"?"#b45309":"#475569");
    doc.rect(M,y,W-2*M,20).fill(col); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10).text(g.label+"   ("+g.items.length+" acompte(s))", M+6, y+5); y+=20;
    row(cols.map(c=>c.h), {fill:"#e6f2ec",bold:true,color:green,h:18}); };
  if(!groups.length){ doc.fontSize(11).fillColor(ink).text("Aucun acompte pour ce filtre.", M, y); doc.end(); return; }
  for(const g of groups){ sectionBanner(g); const sub=g.items.reduce((t,a)=>t+(Number(a.amount)||0),0);
    for(const a of g.items){ if(y>doc.page.height-70){ doc.addPage(); y=40; row(cols.map(c=>c.h), {fill:"#e6f2ec",bold:true,color:green,h:18}); }
      row([a.portfolioName||"", a.employeeName||"", _phone.formatCmPhone(a.momo)||a.momo||"", F(a.amount), a.status==="VALIDE"?"Validé":"Brouillon"]); }
    row(["","","SOUS-TOTAL "+g.k, F(sub), ""], {bold:true, fill:"#f3f4f6", h:18}); y+=8;
  }
  row(["","","TOTAL GÉNÉRAL", F(grand), ""], {bold:true, fill:"#e6f2ec", color:green, h:20});
  doc.end();
});

/* --- Export du bordereau (xlsx / csv) : matrice éléments de salaire + variables --- */
router.get("/bordereaux/:id/export", allow("RP","ADM","GPF","CD","RJ"), (req,res)=>{
  const s=findSheet(req, req.params.id); if(!s) return res.status(404).json({error:"Bordereau introuvable"});
  const fmt=(req.query.format||"csv").toLowerCase();
  const pf=mine(db.portfolios, req).find(p=>p.id===s.portfolioId);
  const empById={}; mine(db.employees, req).forEach(e=>{ empById[e.id]=e; });
  const gainLabels=[]; const struct={};
  for(const l of s.lines){ const e=empById[l.employeeId]; const st=e?structureToInput(e, req):{baseSalary:0,gains:[],transport:null};
    const gains=(st.gains||[]).map(g=>({label:g.label||g.code,amount:Number(g.amount)||0}));
    for(const g of gains) if(!gainLabels.includes(g.label)) gainLabels.push(g.label);
    struct[l.employeeId]={base:Number(st.baseSalary)||0, gains, transport:(st.transport&&Number(st.transport.amount))||0};
  }
  const head=["N°","Nom","Contrat","Cat","Date embauche","Ancienneté","Salaire base",...gainLabels,"Transport","Brut contractuel","Présences","HS120","HS130","HS140","Nuit","Primes variables","Acompte","Échéance prêt","Congé dû","Indemnité congé"];
  const data=[]; let n=0;
  for(const l of s.lines){ n++; const stc=struct[l.employeeId]||{base:0,gains:[],transport:0};
    const gv=(lbl)=>{ const g=(stc.gains||[]).find(x=>x.label===lbl); return g?g.amount:0; };
    const brut=stc.base+(stc.gains||[]).reduce((a,g)=>a+g.amount,0)+stc.transport;
    const primesv=(l.primes||[]).reduce((a,p)=>a+(Number(p.amount)||0),0);
    const _e=empById[l.employeeId]||{}; const _ci=congeInfo(_e, s.period, req);
    data.push([n, l.name, l.contrat||"", l.category||"", (l.hireDate||empHireDate(_e)||"").toString().slice(0,10), seniorityLabel(_e, s.period), stc.base, ...gainLabels.map(gv), stc.transport, brut, l.joursPresence||0, l.hs120||0, l.hs130||0, l.hs140||0, l.hsNuit||0, primesv, acompteTotal(l.employeeId, s.period, req), loanEcheance(l.employeeId, s.period, req).total, _ci.due?"OUI":"", Math.round(Number(l.congeAmount)||0)]);
  }
  const fname=`Bordereau_${(pf?pf.name:"client").replace(/[^\w]/g,"_")}_${s.period}`;
  if(fmt==="csv"){ return sendCSV(res, fname+".csv", [head, ...data]); }
  let XLSX; try{ XLSX=require("xlsx"); }catch(e){ return res.status(500).json({error:"Module Excel indisponible"}); }
  if(!(XLSX&&XLSX.utils&&typeof XLSX.utils.aoa_to_sheet==="function")) return res.status(500).json({error:"Export Excel indisponible sur ce serveur"});
  const aoa=[[`BORDEREAU D'ÉLÉMENTS — ${pf?pf.name:""} — ${s.period} (${s.status})`],[],head,...data];
  const ws=XLSX.utils.aoa_to_sheet(aoa); ws["!cols"]=head.map((h,i)=>({wch:i===1?26:12}));
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Bordereau");
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="${fname}.xlsx"`);
  bEvent(s, req, "BORDEREAU_EXPORT", { format:fmt }); save();
  res.send(XLSX.write(wb, { type:"buffer", bookType:"xlsx" }));
});





/* ============================ RUNS ============================= */
router.get("/runs", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  res.json(mine(db.payRuns, req).slice().sort((a, b) => (b.period || "").localeCompare(a.period || "")));
});

// État d'ouverture (mois par mois) : mois à ouvrir + blocage éventuel si le mois précédent n'est pas clôturé.
router.get("/runs/open-state", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  res.json(payOpenState(req));
});

router.post("/runs", allow("RP", "ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
    if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisee - demandez le droit a votre administrateur" });

  const period = (req.body && req.body.period || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "Période attendue au format YYYY-MM" });
  if (mine(db.payRuns, req).some(r => r.period === period))
    return res.status(409).json({ error: "Une paie existe déjà pour cette période" });
  // Ouverture mois par mois : le mois précédent doit être clôturé, et on ouvre le mois qui suit la dernière paie.
  const st = payOpenState(req);
  if (st.hasRuns) {
    if (!st.canOpen)
      return res.status(409).json({ error: `Clôturez d'abord la paie de ${st.blockedBy.period} avant d'ouvrir un nouveau mois. La paie s'ouvre mois par mois.` });
    if (period !== st.nextPeriod)
      return res.status(409).json({ error: `La paie s'ouvre mois par mois : la prochaine période à ouvrir est ${st.nextPeriod} (le mois qui suit ${st.latest.period}).` });
  }
  const run = stamp({ id: id("run"), period, label: req.body.label || `Paie ${period}`, status: "OPEN",
    createdBy: req.user.id, createdAt: new Date().toISOString(), computedAt: null, closedAt: null, count: 0 }, req);
  db.payRuns.push(run); save();
  audit(req.user, "CREATED", "PayRun", run.id, { period });
  res.status(201).json(run);
});

router.get("/runs/:id", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const _nk = nomSorter(req); const slips = mine(db.payslips, req).filter(s => s.runId === run.id).sort((a,b)=>_nk(a.employeeId,b.employeeId)).map(summary);
  res.json({ run, payslips: slips, totals: runTotals(run, req) });
});

/** Compute (or recompute) payslips for all active employees in the run's period. */
router.post("/runs/:id/compute", allow("RP", "ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
    if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisee - demandez le droit a votre administrateur" });

  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status === "CLOSED") return res.status(409).json({ error: "Paie clôturée" });

  const pfId = req.body && req.body.portfolioId;
  let emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED");
  if (pfId) emps = emps.filter(e => e.portfolioId === pfId);
  const empIds = new Set(emps.map(e => e.id));
  // clear previous payslips for this run (scoped to the selected portfolio when given)
  db.payslips = db.payslips.filter(s => !(s.runId === run.id && (s.tenantId || "t1") === (run.tenantId || "t1") && (!pfId || empIds.has(s.employeeId))));
  let n = 0;
  for (const emp of emps) {
    const base = baseSalaryOf(emp, req);
    if (!base) continue; // skip employees without a resolvable base salary
    const { input, result } = computeFor(emp, run.period, req);
    db.payslips.push(stamp({
      id: id("slip"), runId: run.id, period: run.period, employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`, matricule: emp.matricule || emp.id.slice(-6),
      department: (emp.contract && emp.contract.category) || "", input, result,
      status: "CALCULATED", generatedFile: null, createdAt: new Date().toISOString(),
    }, req));
    n++;
  }
  run.status = "CALCULATED"; run.computedAt = new Date().toISOString();
  run.count = mine(db.payslips, req).filter(x => x.runId === run.id).length;
  save();
  audit(req.user, "COMPUTED", "PayRun", run.id, { period: run.period, employees: n, portfolioId: pfId || null });
  res.json({ run, computed: n, totals: runTotals(run, req) });
});

/* Import d'un pointage (timesheet) : jours travaillés, absences, heures supplémentaires par matricule. */
router.get("/runs/:id/timesheet-template", allow("RP", "ADM", "GPF", "CD", "RJ"), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const pfId = req.query.portfolioId;
  let emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED");
  if (pfId) emps = emps.filter(e => e.portfolioId === pfId);
  const head = ["Matricule", "Nom", "Jours travailles", "Absence (jours)", "HS 20%", "HS 30%", "HS 40%", "Heures nuit"];
  const aoa = [head];
  emps.forEach(e => aoa.push([e.matricule || "", `${e.firstName || ""} ${e.lastName || ""}`.trim(), "", "", "", "", "", ""]));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Pointage");
  res.setHeader("Content-Disposition", `attachment; filename="pointage_${run.period}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

router.post("/runs/:id/timesheet", allow("RP", "ADM", "GPF", "CD", "RJ"), tsUpload.single("file"), (req, res) => {
  if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisée" });
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status === "CLOSED") return res.status(409).json({ error: "Paie clôturée" });
  let rows;
  try { const wb = XLSX.read(req.file.buffer, { type: "buffer" }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false }); }
  catch (e) { return res.status(400).json({ error: "Fichier illisible : " + e.message }); }
  const norm = (k) => String(k || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const pick = (obj, tests) => { for (const key of Object.keys(obj)) { const nk = norm(key); if (tests.some(t => t(nk))) return obj[key]; } return undefined; };
  const num = (v) => { const n = Number(String(v == null ? "" : v).replace(",", ".").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
  const empByMat = {}; mine(db.employees, req).forEach(e => { if (e.matricule) empByMat[String(e.matricule).trim()] = e; });
  const TS_TYPES = ["JOURS", "ABSENCE", "HS20", "HS30", "HS40", "NUIT"];
  let matched = 0, notFound = [];
  for (const row of rows) {
    const mat = String(pick(row, [nk => nk === "matricule" || nk === "mat"]) || "").trim();
    if (!mat) continue;
    const emp = empByMat[mat];
    if (!emp) { notFound.push(mat); continue; }
    const jours = pick(row, [nk => nk.startsWith("jours") || nk === "jt" || nk.includes("travaill")]);
    const abs = pick(row, [nk => nk.startsWith("absence") || nk === "abs"]);
    const hs20 = pick(row, [nk => nk.includes("hs20") || nk.includes("20")]);
    const hs30 = pick(row, [nk => nk.includes("hs30") || nk.includes("30")]);
    const hs40 = pick(row, [nk => nk.includes("hs40") || nk.includes("40")]);
    const nuit = pick(row, [nk => nk.includes("nuit") || nk.includes("night")]);
    // Le pointage fait autorité : on retire les éléments d'assiduité/HS existants de la période.
    db.payElements = db.payElements.filter(e => !(e.employeeId === emp.id && e.period === run.period && (e.tenantId || "t1") === (req.user.tenantId || "t1") && TS_TYPES.includes(e.type)));
    const addEl = (type, field, val) => { if (val === undefined || val === "" || num(val) <= 0) return; const rec = stamp({ id: id("pe"), employeeId: emp.id, period: run.period, type, fromTimesheet: true, createdAt: new Date().toISOString() }, req); rec[field] = num(val); db.payElements.push(rec); };
    addEl("JOURS", "days", jours);
    addEl("ABSENCE", "days", abs);
    addEl("HS20", "hours", hs20);
    addEl("HS30", "hours", hs30);
    addEl("HS40", "hours", hs40);
    addEl("NUIT", "hours", nuit);
    matched++;
  }
  save();
  audit(req.user, "TIMESHEET_IMPORT", "PayRun", run.id, { period: run.period, matched, notFound: notFound.length });
  // Recalcule immédiatement si demandé.
  let computed = 0;
  if (req.body && (req.body.compute === "1" || req.body.compute === "true")) {
    const emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED");
    const ids = new Set(rows.map(r => String(pick(r, [nk => nk === "matricule" || nk === "mat"]) || "").trim()));
    db.payslips = db.payslips.filter(x => !(x.runId === run.id && (x.tenantId || "t1") === (run.tenantId || "t1")));
    for (const emp of emps) { if (!baseSalaryOf(emp, req)) continue; const { input, result } = computeFor(emp, run.period, req);
      db.payslips.push(stamp({ id: id("slip"), runId: run.id, period: run.period, employeeId: emp.id, employeeName: `${emp.firstName} ${emp.lastName}`, matricule: emp.matricule || emp.id.slice(-6), department: (emp.contract && emp.contract.category) || "", input, result, status: "CALCULATED", generatedFile: null, createdAt: new Date().toISOString() }, req)); computed++; }
    run.status = "CALCULATED"; run.computedAt = new Date().toISOString(); run.count = computed; save();
  }
  res.json({ ok: true, matched, notFound, computed });
});

// Per-employee roster for a run (status: PENDING / CALCULATED / CLOSED).
router.get("/runs/:id/roster", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const byEmp = {}; mine(db.payslips, req).filter(s => s.runId === run.id).forEach(s => { byEmp[s.employeeId] = s; });
  const _pfName = {}; mine(db.portfolios, req).forEach(p => { _pfName[p.id] = (p.name || "").toLowerCase(); });
  const roster = mine(db.employees, req)
    .filter(e => (e.status || "").toUpperCase() !== "ARCHIVED")
    .sort((a, b) => (_pfName[a.portfolioId] || "~").localeCompare(_pfName[b.portfolioId] || "~", "fr", { sensitivity: "base" }) ||
      `${a.firstName||""} ${a.lastName||""}`.localeCompare(`${b.firstName||""} ${b.lastName||""}`, "fr", { sensitivity: "base" }))
    .map(e => { const s = byEmp[e.id]; return {
      employeeId: e.id, name: `${e.firstName} ${e.lastName}`, matricule: e.matricule || e.id.slice(-6),
      portfolioId: e.portfolioId, category: (e.contract && e.contract.category) || "",
      hasBase: baseSalaryOf(e, req) > 0, status: s ? s.status : "PENDING",
      net: s ? s.result.totals.netAPayer : null, brut: s ? s.result.totals.brutTotal : null,
      contractType: (e.contract && e.contract.type) || "", contractEnd: (e.contract && e.contract.endDate) || null,
      payslipId: s ? s.id : null, edited: s ? !!s.edited : false };
    });
  res.json({ run, roster, totals: runTotals(run, req) });
});

// Compute (or recompute) ONE employee's bulletin.
router.post("/runs/:id/employees/:eid/compute", allow("RP", "ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
  if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisee - demandez le droit a votre administrateur" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status === "CLOSED") return res.status(409).json({ error: "Paie cloturee" });
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employe introuvable" });
  if (!baseSalaryOf(emp, req)) return res.status(422).json({ error: "Salaire de base introuvable (grille ou structure de paie)" });
  const { input, result } = computeFor(emp, run.period, req);
  let s = mine(db.payslips, req).find(x => x.runId === run.id && x.employeeId === emp.id);
  if (s) { s.input = input; s.result = result; s.status = "CALCULATED"; s.edited = false; s.recomputedAt = new Date().toISOString(); }
  else { s = stamp({ id: id("slip"), runId: run.id, period: run.period, employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`, matricule: emp.matricule || emp.id.slice(-6),
      department: (emp.contract && emp.contract.category) || "", input, result,
      status: "CALCULATED", generatedFile: null, createdAt: new Date().toISOString() }, req);
    db.payslips.push(s); }
  if (run.status === "OPEN") run.status = "CALCULATED";
  run.count = mine(db.payslips, req).filter(x => x.runId === run.id).length;
  save();
  audit(req.user, "COMPUTED_ONE", "Payslip", s.id, { employeeId: emp.id, period: run.period });
  res.json(s);
});

// Simulation: compute a preview for an employee WITHOUT saving anything.
router.post("/simulate/:eid", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employe introuvable" });
  if (!baseSalaryOf(emp, req)) return res.status(422).json({ error: "Salaire de base introuvable" });
  const period = (req.body && req.body.period) || new Date().toISOString().slice(0, 7);
  const { input, result } = computeFor(emp, period, req);
  res.json({ employeeId: emp.id, employeeName: `${emp.firstName} ${emp.lastName}`, matricule: emp.matricule || "", period, input, result, simulation: true });
});

/* Calcul à l'envers : à partir d'un net à payer cible, trouver le montant de la rubrique d'ajustement. */
router.post("/reverse/:eid", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });
  const b = req.body || {};
  const period = b.period || new Date().toISOString().slice(0, 7);
  const targetNet = Number(b.targetNet);
  if (!(targetNet > 0)) return res.status(400).json({ error: "Net à payer cible invalide" });
  const code = String(b.code || "2000");
  const rub = mine(db.payRubriques, req).find(r => String(r.code) === code);
  const label = b.label || (rub && rub.label) || "Ajustement (net cible)";
  const cnps = rub ? !!rub.cnps : true, impo = rub ? !!rub.impo : true;
  const sol = reverseSolve(emp, period, req, targetNet, code, label, cnps, impo);
  // Détail du bulletin obtenu avec le montant trouvé.
  const { input, result } = computeFor(emp, period, req, { extraGain: { code, label, amount: sol.amount, cnps, impo } });
  const out = { employeeId: emp.id, employeeName: `${emp.firstName} ${emp.lastName}`.trim(), matricule: emp.matricule || "", period, targetNet, code, label, amount: sol.amount, net: sol.net, iterations: sol.iterations, alreadyReached: !!sol.alreadyReached, input, result, simulation: true };
  // Appliquer : enregistre le montant comme élément variable (PRIME) pour cette période.
  if (b.apply) {
    if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisée" });
    // Retire un éventuel ajustement précédent de même code.
    db.payElements = db.payElements.filter(e => !(e.employeeId === emp.id && e.period === period && e.reverseAdj && e.code === code && (e.tenantId || "t1") === (req.user.tenantId || "t1")));
    const rec = stamp({ id: id("pe"), employeeId: emp.id, period, type: "PRIME", code, label, amount: sol.amount, cnps, impo, reverseAdj: true, createdAt: new Date().toISOString() }, req);
    db.payElements.push(rec); save();
    audit(req.user, "REVERSE_CALC", "Employee", emp.id, { period, targetNet, code, amount: sol.amount });
    out.applied = true; out.elementId = rec.id;
  }
  res.json(out);
});

/** Close the period: lock payslips and roll year-to-date cumuls. */
router.post("/runs/:id/close", allow("RP", "ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
    if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisee - demandez le droit a votre administrateur" });

  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status === "CLOSED") return res.status(409).json({ error: "Déjà clôturée" });
  if (run.status !== "CALCULATED") return res.status(409).json({ error: "Calculez la paie avant de clôturer" });

  const year = run.period.slice(0, 4);
  for (const s of mine(db.payslips, req).filter(x => x.runId === run.id)) {
    s.status = "CLOSED";
    let cum = db.payCumuls.find(c => (c.tenantId || "t1") === (run.tenantId || "t1") && c.employeeId === s.employeeId && c.year === year);
    if (!cum) { cum = stamp({ id: id("cum"), employeeId: s.employeeId, year, brut: 0, net: 0, irpp: 0, cnps: 0, periods: [] }, req); db.payCumuls.push(cum); }
    if (!cum.periods.includes(run.period)) {
      cum.brut += s.result.totals.brutTotal; cum.net += s.result.totals.netAPayer;
      cum.irpp += s.result.totals.irpp; cum.cnps += s.result.totals.cnpsSalarie;
      cum.periods.push(run.period);
    }
  }
  run.status = "CLOSED"; run.closedAt = new Date().toISOString();
  save();
  audit(req.user, "CLOSED", "PayRun", run.id, { period: run.period });
  // La comptabilisation ne se fait plus automatiquement à la clôture : elle passe par le Contrôle de passation (bouton « Transférer en comptabilité »).
  res.json({ run });
});
// Transfert manuel paie -> comptabilité (ADM/CD/GPF), seulement après clôture. Idempotent (renvoie l'écriture existante).
// Contrôle de passation (pré-vol) - sans comptabiliser.
router.get("/runs/:id/passation-check", allow("RP", "ADM", "CD", "GPF"), (req, res) => {
  const rep = require("./accounting").payrollPassationCheck(req, req.params.id);
  if (!rep) return res.status(404).json({ error: "Paie introuvable" });
  res.json(rep);
});
router.post("/runs/:id/passation-provisoire", allow("RP", "ADM", "CD", "GPF"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  try {
    const e = require("./accounting").generateProvisionalPayrollEntry(req, run.id, { allowSuspense: !!(req.body && req.body.allowSuspense) });
    if (!e) return res.status(400).json({ error: "Paie vide." });
    const debit = (e.lines || []).reduce((a, l) => a + (l.debit || 0), 0);
    res.json({ ok: true, provisoire: true, entryId: e.id, pieceNo: e.pieceNo || "", lines: (e.lines || []).length, debit });
  } catch (err) { res.status(err.status || 500).json({ error: err.message, report: err.report || null }); }
});
router.post("/runs/:id/transfer-accounting", allow("RP", "ADM", "CD", "GPF"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status !== "CLOSED") return res.status(409).json({ error: "Transfert impossible : la paie du mois doit d'abord être CLÔTURÉE." });
  try {
    const e = require("./accounting").generatePayrollEntry(req, run.id, { allowSuspense: !!(req.body && req.body.allowSuspense) });
    if (!e) return res.status(400).json({ error: "Paie vide - aucune écriture à générer." });
    const debit = (e.lines || []).reduce((a, l) => a + (l.debit || 0), 0);
    const credit = (e.lines || []).reduce((a, l) => a + (l.credit || 0), 0);
    res.json({ ok: true, entryId: e.id, pieceNo: e.pieceNo || "", lines: (e.lines || []).length, debit, credit, balanced: debit === credit });
  } catch (err) { res.status(err.status || 500).json({ error: err.message, report: err.report || null }); }
});
router.get("/runs/:id/cloture-report.pdf", allow("RP", "ADM", "CD", "GPF"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  const T = {}; const add = (k, v) => T[k] = (T[k] || 0) + (Number(v) || 0);
  for (const s of slips) { const t = (s.result && s.result.totals) || {};
    add("brut", t.brutTotal); add("net", t.netAPayer); add("cnpsSal", t.cnpsSalarie); add("cnpsPat", t.cnpsPatronal);
    add("irpp", t.irpp); add("cac", t.cac); add("cfc", (t.cfcSalarie || 0) + (t.cfcPatronal || 0)); add("rav", t.rav); add("tdl", t.tdl); add("fne", t.fnePatronal); }
  const P = n => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const rows = []; const sec = t => rows.push({ cells: [t, ""], bold: true, fill: "#e6efe9" }); const kv = (k, v, b) => rows.push({ cells: [k, v], bold: !!b });
  sec("Période de paie");
  kv("Statut de la période", run.status === "CLOSED" ? "CLÔTURÉE" : run.status);
  kv("Effectif (bulletins)", String(slips.length));
  sec("Masse salariale");
  kv("Total brut", P(T.brut));
  kv("Total charges patronales", P(T.chgPat));
  kv("Total net à payer", P(T.net), true);
  sec("Cotisations sociales & impôts sur salaires");
  kv("CNPS part salariale (PVID)", P(T.cnpsSal));
  kv("CNPS part patronale", P(T.cnpsPat));
  kv("IRPP", P(T.irpp)); kv("CAC (10 % IRPP)", P(T.cac)); kv("Crédit foncier (CFC)", P(T.cfc)); kv("Redevance audiovisuelle (RAV)", P(T.rav)); kv("Taxe communale (TDL)", P(T.tdl)); kv("FNE", P(T.fne));
  sec("Déclarations à effectuer (échéance le 15 du mois suivant)");
  kv("Total CNPS à déclarer", P((T.cnpsSal || 0) + (T.cnpsPat || 0)), true);
  kv("Total DIPE (impôts) à déclarer", P((T.irpp || 0) + (T.cac || 0) + (T.cfc || 0) + (T.rav || 0) + (T.tdl || 0) + (T.fne || 0)), true);
  sec("Passation comptable");
  kv("Passation provisoire", run.provisional ? ("faite le " + String(run.provisional.at || "").slice(0, 10)) : "non");
  kv("Comptabilisation définitive", (run.finalized || run.acctEntryId) ? "oui" : "non");
  require("./accounting").reportPDF(req, res, { filename: "Rapport_cloture_paie_" + run.period, title: "Rapport de clôture de paie", subtitle: "Période " + run.period, period: run.period,
    columns: [{ h: "Élément", w: 360 }, { h: "Montant (FCFA)", w: 187, a: "r" }], rows });
});

/* Rouvrir une période clôturée (ADM) : annule les cumuls de la période, déverrouille les
 * bulletins pour permettre un recalcul (ex. correction de barème), puis re-clôture ensuite. */
router.post("/runs/:id/reopen", allow("RP", "ADM"), (req, res) => {
  // Clôture de paie DÉFINITIVE : une période clôturée ne peut plus être rouverte
  // (déclarations CNPS/DIPE et cumuls figés). Toute correction se fait par régularisation
  // sur la période suivante. Réouverture désactivée volontairement.
  return res.status(403).json({ error: "Clôture de paie définitive : la réouverture d'une période clôturée n'est pas autorisée. Corrigez par une régularisation sur la période suivante." });
  if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisée" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status !== "CLOSED") return res.status(409).json({ error: "La période n'est pas clôturée" });
  const year = run.period.slice(0, 4);
  for (const s of mine(db.payslips, req).filter(x => x.runId === run.id)) {
    const cum = db.payCumuls.find(c => (c.tenantId || "t1") === (run.tenantId || "t1") && c.employeeId === s.employeeId && c.year === year);
    if (cum && Array.isArray(cum.periods) && cum.periods.includes(run.period)) {
      cum.brut -= s.result.totals.brutTotal; cum.net -= s.result.totals.netAPayer;
      cum.irpp -= s.result.totals.irpp; cum.cnps -= s.result.totals.cnpsSalarie;
      cum.periods = cum.periods.filter(p => p !== run.period);
    }
    s.status = "CALCULATED";
  }
  run.status = "CALCULATED"; delete run.closedAt;
  if (run.acctEntryId) delete run.acctEntryId; // l'écriture comptable sera régénérée à la re-clôture
  save();
  audit(req.user, "REOPENED", "PayRun", run.id, { period: run.period });
  res.json({ run });
});

/* ========================== PAYSLIPS ========================== */
function summary(s) {
  const t = s.result.totals;
  return { id: s.id, employeeId: s.employeeId, employeeName: s.employeeName, matricule: s.matricule,
    brut: t.brutTotal, retenues: t.totalRetenues, net: t.netAPayer, cout: t.coutTotalEmployeur, status: s.status };
}
function runTotals(run, req) {
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  return slips.reduce((a, s) => {
    const t = s.result.totals;
    a.brut += t.brutTotal; a.net += t.netAPayer; a.cnps += t.cnpsSalarie + t.cnpsPatronal;
    a.irpp += t.irpp; a.charges += t.chargesPatronales; a.cout += t.coutTotalEmployeur; a.count++;
    return a;
  }, { brut: 0, net: 0, cnps: 0, irpp: 0, charges: 0, cout: 0, count: 0 });
}

router.get("/dashboard", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const runs = mine(db.payRuns, req).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const emps = mine(db.employees, req).filter(e => String(e.status || "").toUpperCase() !== "ARCHIVED");
  const actifs = emps.filter(e => String(e.status || "").toUpperCase() === "ACTIVE").length;
  const trend = runs.slice(-8).map(r => { const t = runTotals(r, req); return { period: r.period, brut: t.brut, net: t.net, cout: t.cout, count: t.count, status: r.status }; });
  const last = runs.length ? runs[runs.length - 1] : null;
  const lastT = last ? runTotals(last, req) : null;
  res.json({
    kpi: {
      effectif: emps.length, actifs, runs: runs.length,
      clotures: runs.filter(r => r.status === "CLOSED").length,
      masseDerniere: lastT ? lastT.brut : 0,
      netDernier: lastT ? lastT.net : 0,
      coutDernier: lastT ? lastT.cout : 0,
      bulletinsDernier: lastT ? lastT.count : 0,
    },
    lastRun: last ? { id: last.id, period: last.period, status: last.status, label: last.label } : null,
    trend,
  });
});
router.get("/payslips/:id", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Bulletin introuvable" });
  res.json(s);
});

/* Duplicatas : liste des bulletins d'un salarié (mois précédents). */
router.get("/employees/:eid/payslips", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const rows = mine(db.payslips, req).filter(x => x.employeeId === req.params.eid)
    .map(x => ({ id: x.id, period: x.period, date: (x.result && x.result.meta && x.result.meta.payDate) || x.createdAt || "",
      net: (x.result && x.result.totals && x.result.totals.netAPayer) || 0, status: x.status }))
    .sort((a, b) => String(b.period).localeCompare(String(a.period)));
  res.json(rows);
});

/* PDF bulletin de paie */
// Résout le libellé d'une rubrique en direct depuis le référentiel (par code), afin que
// toute modification de libellé se reflète aussi sur les bulletins déjà calculés.
function rubCatalogLabel(tid) {
  const m = {};
  for (const rb of (db.payRubriques || [])) if ((rb.tenantId || "t1") === (tid || "t1")) m[String(rb.code)] = rb.label;
  return (code, fallback) => m[String(code)] || fallback || "";
}
function drawPayslip(doc, s, emp, tenant) {
  const _cfg = (db.payrollConfig || []).find(c => (c.tenantId || "t1") === (s.tenantId || "t1")) || {};
  if ((_cfg.payslipDesign || "classic") === "modern") return drawPayslipModern(doc, s, emp, tenant);
  const t = s.result.totals, r = s.result;
  const F = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const F2 = (n) => { const v = Math.round((n || 0) * 100) / 100; const [i, d] = v.toFixed(2).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + d; };
  const N3 = (n) => Number(n).toFixed(3).replace(/\B(?=(\d{3})+(?!\d))\./, "$&").replace(/(\d)(?=(\d{3})+,)/g, "$1").replace(".", ",");
  const C = emp.contract || {};
  const MS = { Single: "Célibataire", Married: "Marié(e)", Divorced: "Divorcé(e)", Widowed: "Veuf(ve)" };
  const fdate = (d) => { if (!d) return ""; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d)); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : d; };
  const shortConv = (n) => { if (!n) return ""; const stop = new Set(["convention","conventions","collective","collectives","nationale","interprofessionnelle","de","du","des","la","le","les","l","d"]); const w = String(n).replace(/[''\u2019]/g, " ").split(/\s+/).filter(Boolean); while (w.length && stop.has(w[0].toLowerCase())) w.shift(); const o = w.join(" ") || String(n); return o.charAt(0).toUpperCase() + o.slice(1); };
  const yrs = emp.hireDate ? seniorityLabel(emp, s.period).replace(" an(s) ", " an(s) et ") : "";
  const cum = (db.payCumuls || []).find(c => (c.tenantId||"t1")===(s.tenantId||"t1") && c.employeeId===s.employeeId && c.year===s.period.slice(0,4));
  const [yy, mm] = s.period.split("-"); const last = new Date(Number(yy), Number(mm), 0).getDate();
  const dS = `01/${mm}/${yy.slice(2)}`, dE = `${String(last).padStart(2,"0")}/${mm}/${yy.slice(2)}`;

  doc.lineWidth(0.6).strokeColor("#000").fillColor("#000");
  const T = (x, y, txt, o) => { o = o || {}; if (o.b) doc.font("Helvetica-Bold"); else doc.font("Helvetica");
    doc.fontSize(o.s || 8).text(txt == null ? "" : String(txt), x, y, { width: o.w, align: o.a, lineBreak: false }); doc.font("Helvetica"); };
  const BX = (x, y, w, h) => doc.rect(x, y, w, h).stroke();
  const HL = (x1, x2, y) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
  const VL = (x, y1, y2) => doc.moveTo(x, y1).lineTo(x, y2).stroke();

  /* ===== HEADER ===== */
  BX(18, 18, 300, 110);
  const CO = (db.settings && db.settings.branding && db.settings.branding.company) || {};
  T(26, 24, CO.name || tenant.name || "SOCIÉTÉ", { b: 1, s: 10, w: 288 });
  if (CO.address) T(26, 39, CO.address, { s: 8, w: 288 });
  if (CO.city) T(26, 50, CO.city, { s: 8, w: 288 });
  T(310, 20, "BULLETIN  DE  PAIE", { b: 1, s: 21, w: 270, a: "center" });
  T(360, 58, "Période du", { b: 1 }); T(415, 58, dS, { b: 1 }); T(470, 58, "au", { b: 1 }); T(490, 58, dE, { b: 1 });
  T(360, 70, "Paiement le", { b: 1 }); T(415, 70, dE); T(470, 70, "par", { b: 1 }); T(490, 70, C.paymentMethod || "Virement");
  T(318, 86, "Banque", { b: 1 }); T(358, 86, String(emp.bankName || C.bankName || "").slice(0, 20), { s: 7 }); T(445, 87, "N° Compte", { b: 1, s: 7 }); T(490, 87, emp.bankAccount || C.bankIban || "", { s: 7 });
  // labels inside company box
  T(26, 88, "N° Contribuable", { b: 1 }); T(110, 88, CO.niu || tenant.niu || "");
  T(190, 88, "N° Employeur", { b: 1 }); T(255, 88, CO.employerNo || tenant.cnpsEmployer || "");
  // employee box (right)
  BX(310, 98, 267, 60);
  T(318, 104, "Matricule", { b: 1 }); T(375, 104, s.matricule || "");
  T(320, 128, `${emp.civility || ""}  ${(emp.firstName||"")} ${(emp.lastName||"")}`.trim(), { b: 1, s: 10, w: 250 });
  // resolve convention name from the employee's portfolio
  const _pf = (db.portfolios || []).find(p => p.id === emp.portfolioId);
  const _conv = _pf ? (db.conventions || []).find(c => c.id === _pf.conventionId) : null;
  const convName = C.convention || emp.convention || (_conv && _conv.name) || "";
  // left info block
  let iy = 168; const li = (l, v, l2, v2) => {
    T(26, iy, l, { b: 1 }); T(120, iy, v); if (l2) { T(300, iy, l2, { b: 1 }); T(380, iy, v2); } iy += 12; };
  li("Conv. coll.", convName || "", "Emploi", C.position || emp.position || "");
  li("N° CNPS", cnpsFull(emp), "Sit Fam", MS[emp.maritalStatus] || emp.maritalStatus || "");
  li("Date Embauche", fdate(emp.hireDate), "Nbre Enfants", emp.children != null ? emp.children : "");
  li("Ancienneté", yrs, "Qualification", emp.qualification || "");
  li("N° DIPE", emp.dipe || CO.dipe || tenant.dipe || "", "Département", emp.department || "");
  li("Catégorie", C.category || "", "Jour/Mois", "30,00");

  /* ===== MAIN TABLE ===== */
  const X = { n: 18, des: 52, nb: 232, base: 288, txs: 348, gain: 392, rets: 452, txp: 508, retp: 540, end: 577 };
  let TY = 250;                    // table top
  const hEnd = 636;                // table bottom (fixed height)
  // header (2 rows)
  BX(X.n, TY, X.end - X.n, 22);
  VL(X.des, TY, hEnd); VL(X.nb, TY, hEnd); VL(X.base, TY, hEnd);
  VL(X.txs, TY, hEnd); VL(X.gain, TY, hEnd); VL(X.rets, TY, hEnd); VL(X.txp, TY, hEnd); VL(X.retp, TY, hEnd);
  VL(X.n, TY, hEnd); VL(X.end, TY, hEnd); // left & right table borders (full height)
  HL(X.n, X.end, hEnd);                   // bottom border of the table
  HL(X.txs, X.end, TY + 11);       // split under the two group headers
  T(X.n, TY + 6, "N°", { b: 1, s: 7, w: X.des - X.n, a: "center" });
  T(X.des, TY + 6, "Désignation", { b: 1, s: 7, w: X.nb - X.des, a: "center" });
  T(X.nb, TY + 6, "Nombre", { b: 1, s: 7, w: X.base - X.nb, a: "center" });
  T(X.base, TY + 6, "Base", { b: 1, s: 7, w: X.txs - X.base, a: "center" });
  T(X.txs, TY + 1, "Part salariale", { b: 1, s: 7, w: X.txp - X.txs, a: "center" });
  T(X.txp, TY + 1, "Part patronale", { b: 1, s: 7, w: X.end - X.txp, a: "center" });
  T(X.txs, TY + 13, "Taux", { b: 1, s: 6.5, w: X.gain - X.txs, a: "center" });
  T(X.gain, TY + 13, "Gain", { b: 1, s: 6.5, w: X.rets - X.gain, a: "center" });
  T(X.rets, TY + 13, "Retenue", { b: 1, s: 6.5, w: X.txp - X.rets, a: "center" });
  T(X.txp, TY + 13, "Taux", { b: 1, s: 6.5, w: X.retp - X.txp, a: "center" });
  T(X.retp, TY + 13, "Retenue", { b: 1, s: 6.5, w: X.end - X.retp, a: "center" });
  const SLBL = { "5000":"PENSION VIEILLESSE","5010":"ALLOCATIONS FAMILIALES","5020":"ACCIDENT DE TRAVAIL","5025":"IRPP1","5045":"CAC/IRPP 1","5050":"CREDIT FONCIER","5060":"CREDIT FONCIER PATR.","5070":"FNE","5080":"REDEVANCE CRTV","5090":"TAXE COMMUNALE" };
  const _clbl = rubCatalogLabel(s.tenantId);
  const dlbl = (l) => (_clbl(l.code) || SLBL[l.code] || l.label || "").toUpperCase();
  let y = TY + 24;
  const cell = (x, xe, v, al) => { if (v || v === 0) T(x + 1, y, v, { s: 7.5, w: xe - x - 2, a: al || "right" }); };
  const _isTransportC = (l) => l._transportTaxable !== undefined || String(l.code) === "3513";
  const _allGainsC = r.lines.filter(l => (l.kind === "GAIN" || l.kind === "AVANTAGE") && l.gain);
  const gains = _allGainsC.filter(l => l.impo || l.cnps || _isTransportC(l));
  const _nonSoumisC = _allGainsC.filter(l => !(l.impo || l.cnps) && !_isTransportC(l));
  const _retenuesC = r.lines.filter(l => l.kind === "RETENUE" && l.retenue);
  const _brutSoumisC = gains.reduce((a, l) => a + (l.gain || 0), 0);
  for (const l of gains) {
    if (!l.gain) continue;
    T(X.n + 1, y, l.code, { s: 7.5, w: X.des - X.n - 2, a: "center" });
    T(X.des + 2, y, dlbl(l), { s: 7.5, w: X.nb - X.des - 4 });
    if (l.nombre) cell(X.nb, X.base, Number(l.nombre).toFixed(3).replace(/\B(?=(\d{3})+(?!\d))(?=\d*\.)/g, " ").replace(".", ","));
    if (l.base) cell(X.base, X.txs, F2(l.base));
    if (l.rate && Number(l.rate) !== 1) cell(X.txs, X.gain, (Number(l.rate) * 100).toFixed(2));
    cell(X.gain, X.rets, F(l.gain));
    y += 12;
  }
  HL(X.gain, X.rets, y + 1);
  y += 3; T(X.des, y, "Total Brut", { b: 1, s: 8, w: X.nb - X.des, a: "center" }); cell(X.gain, X.rets, F(_brutSoumisC)); doc.font("Helvetica-Bold"); y += 14; doc.font("Helvetica");
  const cot = r.lines.filter(l => l.kind === "COTIS" || l.kind === "IMPOT");
  for (const l of cot) {
    T(X.n + 1, y, l.code, { s: 7.5, w: X.des - X.n - 2, a: "center" });
    T(X.des + 2, y, dlbl(l), { s: 7.5, w: X.nb - X.des - 4 });
    if (l.base) cell(X.base, X.txs, F2(l.base));
    if (l.rate) cell(X.txs, X.gain, (l.rate * 100).toFixed(2));
    if (l.retenue) cell(X.rets, X.txp, F(l.retenue));
    if (l.employerRate) cell(X.txp, X.retp, (l.employerRate * 100).toFixed(2));
    cell(X.retp, X.end, F(l.employer || 0));
    y += 12;
  }
  HL(X.rets, X.txp, y + 1); HL(X.retp, X.end, y + 1);
  y += 3; T(X.des, y, "Total Cotisations", { b: 1, s: 8, w: X.nb - X.des, a: "center" });
  cell(X.rets, X.txp, F((t.cnpsSalarie||0) + (t.totalImpots||0))); cell(X.retp, X.end, F((t.cnpsPatronal||0) + (t.cfcPatronal||0)));
  y += 14;
  // Éléments non soumis (indemnités non imposables ajoutées au net ; acomptes/prêts retenus).
  if ((_nonSoumisC.length || _retenuesC.length) && y < 606) {
    T(X.n + 1, y, "", { s: 7.5 }); T(X.des + 2, y, "ÉLÉMENTS NON SOUMIS", { b: 1, s: 7.5, w: X.gain - X.des - 4 }); y += 12;
    for (const l of _nonSoumisC) { if (y > 620) break;
      T(X.n + 1, y, l.code, { s: 7.5, w: X.des - X.n - 2, a: "center" }); T(X.des + 2, y, dlbl(l), { s: 7.5, w: X.rets - X.des - 4 });
      cell(X.gain, X.rets, F(l.gain)); y += 12; }
    for (const l of _retenuesC) { if (y > 620) break;
      T(X.n + 1, y, l.code, { s: 7.5, w: X.des - X.n - 2, a: "center" }); T(X.des + 2, y, dlbl(l), { s: 7.5, w: X.rets - X.des - 4 });
      cell(X.rets, X.txp, "-" + F(l.retenue)); y += 12; }
    const nsNetC = _nonSoumisC.reduce((a,l)=>a+(l.gain||0),0) - _retenuesC.reduce((a,l)=>a+(l.retenue||0),0);
    T(X.des, y, "Total éléments non soumis", { b: 1, s: 8, w: X.nb - X.des, a: "center" });
    cell(X.gain, X.rets, (nsNetC<0?"-":"") + F(Math.abs(nsNetC)));
  }

  /* ===== SUMMARY BAND ===== */
  let by = 644; const bh = 34;
  const bc = [["Cumuls",18,44],["Salaire brut",62,58],["Charges\nsalariales",120,52],["Charges\npatronales",172,52],["Avantages en\nnature",224,52],["Salaire taxable",276,58],["Jours\ntravaillées",334,44],["Heures\nsupplémentaires",378,58],["",436,0]];
  BX(18, by, 418, bh);
  const cxs = [18,62,120,172,224,276,334,378]; const cxe = [62,120,172,224,276,334,378,436];
  cxs.slice(1).forEach(x => VL(x, by, by + bh));
  VL(436, by, by + bh);
  HL(18, 436, by + 12); HL(18, 436, by + 23);
  const hd = [["Cumuls",18,44],["Salaire brut",62,58],["Charges salariales",120,52],["Charges patronales",172,52],["Avantages nature",224,52],["Salaire taxable",276,58],["Jours travaillées",334,44],["Heures supp.",378,58]];
  hd.forEach(([lb,x,w]) => T(x, by + 2, lb, { b: 1, s: 5.5, w, a: x===18?"left":"right" }));
  const band = (name, ry, vals) => { T(20, ry, name, { b: 1, s: 7 });
    const xs=[62,120,172,224,276,334,378], ws=[58,52,52,52,58,44,58];
    vals.forEach((v,i) => T(xs[i], ry, v, { s: 7, w: ws[i], a: "right" })); };
  band("Période", by + 13, [F(_brutSoumisC), F((t.cnpsSalarie||0)+(t.totalImpots||0)), F((t.cnpsPatronal||0)+(t.cfcPatronal||0)), F(t.avantagesNature||0), F(t.netImposable), (r.meta&&r.meta.workedDays)||30, 0]);
  if (cum) band("Année", by + 24, [F(cum.brut), "", "", "", "", "", ""]);
  // NET A PAYER box
  BX(500, by, 77, bh);
  T(500, by + 3, "NET A PAYER", { b: 1, s: 8, w: 77, a: "center" });
  T(500, by + 18, F(t.netAPayer), { b: 1, s: 12, w: 77, a: "center" });

  /* ===== CONGÉS + SIGNATURE ===== */
  let cy = by + bh + 8;
  BX(18, cy, 250, 34);
  T(24, cy + 3, "Compteurs", { b: 1, s: 6.5 }); T(90, cy + 3, "Pris", { b: 1, s: 6.5 }); T(130, cy + 3, "Restant", { b: 1, s: 6.5 }); T(180, cy + 3, "Acquis C. Brut congés", { b: 1, s: 6 });
  T(24, cy + 20, "Congés", { s: 7 }); T(90, cy + 20, "0", { s: 7 }); T(130, cy + 20, "0", { s: 7 });
  T(180, cy + 20, F((r.meta && r.meta.leaveProvisionMonthly) || 0), { s: 7 });
  BX(470, cy, 107, 44);
  T(474, cy + 2, "Signature", { b: 1, s: 7 });
  T(280, cy + 3, "Congés acquis : " + ((r.meta && r.meta.leaveAccrued) || 2.5) + " j/mois", { s: 7 });

  // Authenticity QR - scans to the public /verify page; vector-drawn so it is synchronous
  try {
    const QR = require("qrcode");
    const base = process.env.PUBLIC_URL || "";
    const url = `${base}/verify/${s.id}?h=${payslipSig(s)}`;
    const m = QR.create(url, { errorCorrectionLevel: "M" }).modules;
    const nn = m.size, bits = m.data, qsz = 42, qx = 414, qy = cy - 2, csz = qsz / nn;
    doc.fillColor("#000");
    for (let rr = 0; rr < nn; rr++) for (let cc = 0; cc < nn; cc++) if (bits[rr * nn + cc]) doc.rect(qx + cc * csz, qy + rr * csz, csz + 0.4, csz + 0.4).fill();
    doc.fillColor("#000");
    T(qx - 6, qy + qsz + 1, "Scannez pour vérifier l'authenticité", { s: 4.5, w: 66 });
  } catch (e) {}

  /* ===== FOOTER ===== */
  T(18, 812, "Pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée. Tout paiement indu doit être immédiatement signalé et retourné en caisse.", { s: 6, w: 500 });
  T(520, 812, "TAKE CARE", { b: 1, s: 7 });
}
function drawPayslipModern(doc, s, emp, tenant) {
  const _clbl = rubCatalogLabel(s.tenantId);
  const t = s.result.totals, r = s.result;
  const F = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const F2 = (n) => { const v = Math.round((n || 0) * 100) / 100; const [i, d] = v.toFixed(2).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + d; };
  const NB = (n) => { if (n == null || n === "") return ""; const v = Number(n); if (isNaN(v)) return String(n); return (Math.round(v * 1000) / 1000).toString().replace(".", ","); };
  const C = emp.contract || {};
  const CO = (db.settings && db.settings.branding && db.settings.branding.company) || {};
  const MS = { Single: "Célibataire", Married: "Marié(e)", Divorced: "Divorcé(e)", Widowed: "Veuf(ve)" };
  const fdate = (d) => { if (!d) return ""; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d)); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : d; };
  const shortConv = (n) => { if (!n) return ""; const stop = new Set(["convention","conventions","collective","collectives","nationale","interprofessionnelle","de","du","des","la","le","les","l","d"]); const w = String(n).replace(/[''’]/g, " ").split(/\s+/).filter(Boolean); while (w.length && stop.has(w[0].toLowerCase())) w.shift(); const o = w.join(" ") || String(n); return o.charAt(0).toUpperCase() + o.slice(1); };
  const yrs = emp.hireDate ? seniorityLabel(emp, s.period) : "";
  const _pf = (db.portfolios || []).find(p => p.id === emp.portfolioId);
  const _conv = _pf ? (db.conventions || []).find(c => c.id === _pf.conventionId) : null;
  const convName = C.convention || emp.convention || (_conv && _conv.name) || "";
  const [yy, mm] = s.period.split("-"); const last = new Date(Number(yy), Number(mm), 0).getDate();
  const dS = `01/${mm}/${yy.slice(2)}`, dE = `${String(last).padStart(2, "0")}/${mm}/${yy.slice(2)}`;
  const cum = (db.payCumuls || []).find(c => (c.tenantId || "t1") === (s.tenantId || "t1") && c.employeeId === s.employeeId && c.year === s.period.slice(0, 4));
  const workedDays = (r.meta && r.meta.workedDays != null) ? r.meta.workedDays : 30;

  const NAVY = "#1b2a4a", MUT = "#000000", LINE = "#e5e7eb", CARD = "#f6f8fb", STRIPE = "#f2f5f9", TXT = "#000000";
  const L = 30, RgT = 565, W = RgT - L;
  const txt = (x, y, str, o) => { o = o || {}; doc.font(o.b ? "Helvetica-Bold" : "Helvetica").fontSize(o.s || 7.5).fillColor(o.c || TXT)
    .text(str == null ? "" : String(str), x, y, { width: o.w, align: o.a || "left", lineBreak: false }); };
  const card = (x, y, w, h, fill) => { doc.save(); doc.roundedRect(x, y, w, h, 4).fillAndStroke(fill || "#ffffff", LINE); doc.restore(); };

  let y = 28;
  /* HEADER */
  card(L, y, W, 52, CARD);
  txt(L + 12, y + 9, CO.name || tenant.name || "SOCIÉTÉ", { b: 1, s: 12, c: TXT, w: 250 });
  txt(L + 12, y + 26, [CO.address, CO.city].filter(Boolean).join(" - "), { s: 6.5, c: MUT, w: 250 });
  txt(L + 12, y + 37, `N° Contribuable ${CO.niu || tenant.niu || "-"}   -   N° Employeur ${CO.employerNo || tenant.cnpsEmployer || "-"}`, { s: 6.5, c: MUT, w: 260 });
  txt(RgT - 240, y + 7, "BULLETIN DE PAIE", { b: 1, s: 12, c: TXT, w: 228, a: "right" });
  txt(RgT - 240, y + 24, `Période du ${dS} au ${dE}`, { s: 7, c: MUT, w: 228, a: "right" });
  txt(RgT - 240, y + 34, `Payé le ${dE} par ${C.paymentMethod || "Virement"}`, { s: 7, c: MUT, w: 228, a: "right" });
  txt(RgT - 240, y + 44, `Banque ${String(emp.bankName || C.bankName || "-").slice(0,18)}  Cpte ${emp.bankAccount || C.bankIban || "-"}`, { s: 6.5, c: MUT, w: 228, a: "right" });
  y += 60;

  /* EMPLOYÉ card - full detail grid */
  const empH = 92;
  card(L, y, W, empH, CARD);
  txt(L + 12, y + 8, `${emp.civility || ""} ${(emp.firstName||"")} ${(emp.lastName||"")}`.trim(), { b: 1, s: 11, c: TXT, w: 300 });
  txt(RgT - 160, y + 9, `Matricule ${s.matricule || "-"}`, { b: 1, s: 8, c: TXT, w: 148, a: "right" });
  doc.save(); doc.moveTo(L + 12, y + 26).lineTo(RgT - 12, y + 26).strokeColor(LINE).stroke(); doc.restore();
  const colL = L + 12, colM = L + 190, colR = L + 372;
  const pairs = [
    ["Conv. coll.", convName || ""], ["Emploi", C.position || emp.position || ""], ["Catégorie", C.category || ""],
    ["N° CNPS", cnpsFull(emp)], ["Sit. Fam.", MS[emp.maritalStatus] || emp.maritalStatus || ""], ["Nbre Enfants", emp.children != null ? String(emp.children) : ""],
    ["Date Embauche", fdate(emp.hireDate)], ["Ancienneté", yrs], ["Qualification", emp.qualification || ""],
    ["N° DIPE", emp.dipe || CO.dipe || tenant.dipe || ""], ["Département", emp.department || ""], ["Jour / Mois", F2(workedDays)],
  ];
  const cx = [colL, colM, colR]; let gy = y + 32;
  // Valeur ajustée pour tenir sur UNE seule ligne (rétrécit la police au besoin, ex. nom complet de convention).
  const fitTxt = (x, yy, str, w) => { let vs = 7.5; const v = String(str == null ? "" : str);
    doc.font("Helvetica").fontSize(vs); while (vs > 5 && doc.widthOfString(v) > w - 2) { vs -= 0.5; doc.fontSize(vs); }
    txt(x, yy, v, { s: vs, c: TXT, w }); };
  pairs.forEach((p, i) => { const c = cx[i % 3]; if (i % 3 === 0 && i) gy += 15;
    txt(c, gy, p[0], { b: 1, s: 6.5, c: MUT, w: 60 }); fitTxt(c + 58, gy, p[1], 116); });
  y += empH + 8;

  /* generic table */
  const drawTable = (title, cols, headers, rows, totalRow) => {
    const rowH = 13.5, headH = 15;
    txt(L + 2, y, title, { b: 1, s: 8.5, c: TXT }); y += 13;
    const top = y, bh = headH + rows.length * rowH + (totalRow ? rowH : 0);
    doc.save(); doc.roundedRect(L, y, W, headH, 3).fill(NAVY); doc.restore();
    headers.forEach((h, i) => txt(cols[i].x + (cols[i].a === "right" ? 0 : 6), y + 4, h, { b: 1, s: 6.5, c: "#ffffff", w: cols[i].w - 6, a: cols[i].a }));
    y += headH;
    rows.forEach((rw, ri) => { if (ri % 2) { doc.save(); doc.rect(L, y, W, rowH).fill(STRIPE); doc.restore(); }
      rw.forEach((v, i) => txt(cols[i].x + (cols[i].a === "right" ? 0 : 6), y + 3, v, { s: 7.5, w: cols[i].w - 6, a: cols[i].a, c: TXT })); y += rowH; });
    if (totalRow) { doc.save(); doc.rect(L, y, W, rowH).fill("#e9eef5"); doc.restore();
      totalRow.forEach((v, i) => { if (v != null && v !== "") txt(cols[i].x + (cols[i].a === "right" ? 0 : 6), y + 3, v, { b: 1, s: 8, w: cols[i].w - 6, a: cols[i].a, c: TXT }); }); y += rowH; }
    doc.save(); doc.roundedRect(L, top, W, bh, 3).stroke(LINE); doc.restore(); y += 8;
  };

  /* Rémunération : N° | Désignation | Nombre | Base | Part salariale | Part patronale */
  const gcols = [{x:L,w:24,a:"left"},{x:L+24,w:150,a:"left"},{x:L+174,w:52,a:"right"},{x:L+226,w:74,a:"right"},{x:L+300,w:52,a:"right"},{x:L+352,w:95,a:"right"},{x:L+447,w:W-447,a:"right"}];
  // Classement : éléments soumis (imposables ou cotisables) vs non soumis. Le transport (assiette
  // spécifique) reste dans la rémunération. Les non soumis sont présentés sous le total des cotisations.
  const _isTransport = (l) => l._transportTaxable !== undefined || String(l.code) === "3513";
  const _allGains = r.lines.filter(l => (l.kind === "GAIN" || l.kind === "AVANTAGE") && l.gain);
  const _soumis = _allGains.filter(l => l.impo || l.cnps || _isTransport(l));
  const _nonSoumis = _allGains.filter(l => !(l.impo || l.cnps) && !_isTransport(l));
  const _retenues = r.lines.filter(l => l.kind === "RETENUE" && l.retenue);
  const _brutSoumis = _soumis.reduce((a, l) => a + (l.gain || 0), 0);
  const gtaux = (l) => (l.rate && Number(l.rate) !== 1) ? (Number(l.rate) * 100).toFixed(2) : "";
  drawTable("Rémunération", gcols, ["N°","Désignation","Nombre","Base","Taux","Part salariale","Part patronale"],
    _soumis.map(l => [l.code||"", _clbl(l.code, l.label), l.nombre?NB(l.nombre):"", l.base?F2(l.base):"", gtaux(l), F(l.gain), ""]),
    ["","TOTAL BRUT","","","",F(_brutSoumis),""]);

  /* Cotisations & retenues - en-tête groupé (Part salariale / Part patronale), façon Sage */
  {
    const cot = r.lines.filter(l => l.kind === "COTIS" || l.kind === "IMPOT");
    const rate = (v) => ((Number(v)||0)*100).toFixed(2);   // taux : 0 -> "0.00"
    const amt = (v) => (Number(v)||0) ? F(v) : "0";        // montant : 0 -> "0"
    // Colonnes [x, w] : N°, Cotisation, Base, [Taux|Montant]sal, [Taux|Montant]pat (les deux groupes serrés)
    const cN=[L,32], cC=[L+32,130], cB=[L+162,76], cTS=[L+246,40], cMS=[L+286,80], cTP=[L+408,40], cMP=[L+448,W-448];
    txt(L + 2, y, "Cotisations & retenues", { b:1, s:8.5, c:TXT }); y += 13;
    const rowH=13.5, h1=13, h2=13, top=y, bh = h1+h2 + cot.length*rowH + rowH;
    // Fond d'en-tête (2 lignes)
    doc.save(); doc.roundedRect(L, y, W, h1+h2, 3).fill(NAVY); doc.restore();
    const midY = y + (h1+h2)/2 - 4;
    txt(cN[0]+6, midY, "N°", {b:1,s:6.5,c:"#ffffff",w:cN[1]-6,a:"left"});
    txt(cC[0]+6, midY, "Cotisation", {b:1,s:6.5,c:"#ffffff",w:cC[1]-6,a:"left"});
    txt(cB[0], midY, "Base", {b:1,s:6.5,c:"#ffffff",w:cB[1]-6,a:"right"});
    txt(cTS[0], y+2, "Part salariale", {b:1,s:6.5,c:"#ffffff",w:(cMS[0]+cMS[1])-cTS[0],a:"center"});
    txt(cTP[0], y+2, "Part patronale", {b:1,s:6.5,c:"#ffffff",w:(cMP[0]+cMP[1])-cTP[0],a:"center"});
    const r2 = y + h1 + 2;
    txt(cTS[0], r2, "Taux", {b:1,s:6.5,c:"#ffffff",w:cTS[1]-6,a:"right"});
    txt(cMS[0], r2, "Montant", {b:1,s:6.5,c:"#ffffff",w:cMS[1]-6,a:"right"});
    txt(cTP[0], r2, "Taux", {b:1,s:6.5,c:"#ffffff",w:cTP[1]-6,a:"right"});
    txt(cMP[0], r2, "Montant", {b:1,s:6.5,c:"#ffffff",w:cMP[1]-6,a:"right"});
    y += h1 + h2;
    cot.forEach((l, ri) => {
      if (ri % 2) { doc.save(); doc.rect(L, y, W, rowH).fill(STRIPE); doc.restore(); }
      txt(cN[0]+6, y+3, l.code||"", {s:7.5,w:cN[1]-6,a:"left"});
      txt(cC[0]+6, y+3, _clbl(l.code, l.label), {s:7.5,w:cC[1]-6,a:"left"});
      txt(cB[0], y+3, l.base?F2(l.base):"0", {s:7.5,w:cB[1]-6,a:"right"});
      txt(cTS[0], y+3, rate(l.rate), {s:7.5,w:cTS[1]-6,a:"right"});
      txt(cMS[0], y+3, amt(l.retenue), {s:7.5,w:cMS[1]-6,a:"right"});
      txt(cTP[0], y+3, rate(l.employerRate), {s:7.5,w:cTP[1]-6,a:"right"});
      txt(cMP[0], y+3, amt(l.employer), {s:7.5,w:cMP[1]-6,a:"right"});
      y += rowH;
    });
    doc.save(); doc.rect(L, y, W, rowH).fill("#e9eef5"); doc.restore();
    txt(cC[0]+6, y+3, "TOTAL COTISATIONS", {b:1,s:8,w:210,a:"left"});
    txt(cMS[0], y+3, F((t.cnpsSalarie||0)+(t.totalImpots||0)), {b:1,s:8,w:cMS[1]-6,a:"right"});
    txt(cMP[0], y+3, F((t.cnpsPatronal||0)+(t.cfcPatronal||0)), {b:1,s:8,w:cMP[1]-6,a:"right"});
    y += rowH;
    doc.save(); doc.roundedRect(L, top, W, bh, 3).stroke(LINE); doc.restore(); y += 8;
  }

  /* Éléments non soumis à cotisation : indemnités/primes non imposables (ajoutées au net)
     et retenues (acomptes, prêts, retenues diverses — soustraites du net). */
  if (_nonSoumis.length || _retenues.length) {
    if (y > 636) { doc.addPage(); y = 28; }
    const nscols = [{x:L,w:28,a:"left"},{x:L+28,w:W-28-110,a:"left"},{x:L+W-110,w:110,a:"right"}];
    const nsRows = [
      ..._nonSoumis.map(l => [l.code||"", _clbl(l.code, l.label), F(l.gain)]),
      ..._retenues.map(l => [l.code||"", _clbl(l.code, l.label), "-" + F(l.retenue)]),
    ];
    const nsNet = _nonSoumis.reduce((a,l)=>a+(l.gain||0),0) - _retenues.reduce((a,l)=>a+(l.retenue||0),0);
    drawTable("Éléments non soumis (ajoutés / retenus sur le net)", nscols,
      ["N°","Désignation","Montant"], nsRows,
      ["","TOTAL ÉLÉMENTS NON SOUMIS", (nsNet<0?"-":"") + F(Math.abs(nsNet))]);
  }

  if (y > 648) { doc.addPage(); y = 28; }

  /* CUMUL DE LA PÉRIODE - dedicated, 2 columns */
  const heuresSupp = r.lines.filter(l => l.hours).reduce((a, l) => a + Number(l.hours || 0), 0);
  const sumRows = [
    ["Salaire brut", F(_brutSoumis)], ["Charges salariales", F((t.cnpsSalarie||0)+(t.totalImpots||0))],
    ["Charges patronales", F((t.cnpsPatronal||0)+(t.cfcPatronal||0))], ["Avantages en nature", F(t.avantagesNature||0)],
    ["Salaire taxable", F(t.netImposable||0)], ["Jours travaillés", F2(workedDays)],
    ["Heures supplémentaires", NB(heuresSupp)||"0"], ["Cumul brut annuel", F(cum ? cum.brut : _brutSoumis)],
  ];
  const rowsPerCol = Math.ceil(sumRows.length / 2), sumH = 22 + rowsPerCol * 13 + 8;
  card(L, y, W, sumH, CARD);
  txt(L + 12, y + 8, "CUMUL DE LA PÉRIODE", { b: 1, s: 8.5, c: TXT });
  const colW = (W - 24) / 2;
  sumRows.forEach((rw, i) => { const col = Math.floor(i / rowsPerCol), row = i % rowsPerCol;
    const bx = L + 12 + col * colW, byy = y + 24 + row * 13;
    txt(bx, byy, rw[0], { s: 7.5, c: MUT, w: colW - 90 }); txt(bx + colW - 92, byy, rw[1] + " FCFA", { b: 1, s: 8, c: TXT, w: 80, a: "right" }); });
  y += sumH + 8;

  /* NET À PAYER - usual place, bottom */
  if (y > 700) { doc.addPage(); y = 28; }
  const nbw = 240, nbx = RgT - nbw;
  doc.save(); doc.roundedRect(nbx, y, nbw, 36, 4).fill(NAVY); doc.restore();
  txt(nbx + 12, y + 7, "NET À PAYER", { b: 1, s: 8, c: "#ffffff", w: nbw - 24 });
  txt(nbx + 12, y + 19, F(t.netAPayer) + " FCFA", { b: 1, s: 12, c: "#ffffff", w: nbw - 24, a: "right" });
  y += 44;

  /* CONGÉS + AUTHENTIFICATION */
  const half = (W - 10) / 2, bh2 = 52;
  card(L, y, half, bh2); card(L + half + 10, y, half, bh2);
  txt(L + 10, y + 8, "CONGÉS", { b: 1, s: 6.5, c: MUT });
  txt(L + 10, y + 22, `Pris ${(r.meta && r.meta.leaveTaken) || 0}    -    Restant ${(r.meta && r.meta.leaveBalance) || 0}`, { s: 7.5, c: TXT, w: half - 20 });
  txt(L + 10, y + 35, `Acquis ${(r.meta && r.meta.leaveAccrued) || 2.5} j/mois`, { s: 7.5, c: TXT, w: half - 20 });
  txt(L + half + 20, y + 8, "AUTHENTIFICATION", { b: 1, s: 6.5, c: MUT });
  try {
    const QR = require("qrcode");
    const base = process.env.PUBLIC_URL || "";
    const url = `${base}/verify/${s.id}?h=${payslipSig(s)}`;
    const m = QR.create(url, { errorCorrectionLevel: "M" }).modules;
    const nn = m.size, bits = m.data, qsz = 34, qx = L + half + 20, qy = y + 16, csz = qsz / nn;
    doc.fillColor("#000");
    for (let rr = 0; rr < nn; rr++) for (let cc = 0; cc < nn; cc++) if (bits[rr * nn + cc]) doc.rect(qx + cc * csz, qy + rr * csz, csz + 0.4, csz + 0.4).fill();
  } catch (e) {}
  txt(L + half + 20 + 44, y + 22, "Signature", { s: 7.5, c: MUT });
  doc.save(); doc.moveTo(L + half + 20 + 44, y + 40).lineTo(L + W - 10, y + 40).dash(2, { space: 2 }).strokeColor(MUT).stroke(); doc.undash(); doc.restore();
  y += bh2 + 6;

  txt(L, Math.min(y, 812), "Conservez ce bulletin de paie sans limitation de durée.", { s: 6, c: MUT, w: 400 });
}
function payslipDoc(s, emp, tenant) { const doc = new PDFDocument({ margin: 18, size: "A4" }); drawPayslip(doc, s, emp, tenant); return doc; }
function payslipBuffer(s, emp, tenant) {
  return new Promise((resolve, reject) => {
    const doc = payslipDoc(s, emp, tenant);
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

router.get("/payslips/:id/pdf", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Bulletin introuvable" });
  const emp = mine(db.employees, req).find(e => e.id === s.employeeId) || {};
  const tenant = (db.tenants || []).find(t => t.id === (s.tenantId || "t1")) || { name: "SGRHP" };
  audit(req.user, req.query.print === "1" ? "PRINTED" : "DOWNLOADED", "Payslip", s.id, { employeeId: s.employeeId, period: s.period });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Bulletin_${(s.employeeName||"").replace(/[^\w]/g,"_")}_${s.period}.pdf"`);
  const doc = payslipDoc(s, emp, tenant);
  doc.pipe(res); doc.end();
});

/* Tous les bulletins d'une paie (option: un portefeuille) en un seul PDF */
router.get("/runs/:id/payslips.pdf", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const pfId = req.query.portfolioId || null;
  const empById = {}; mine(db.employees, req).forEach(e => empById[e.id] = e);
  let slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  if (pfId) slips = slips.filter(s => { const e = empById[s.employeeId]; return e && e.portfolioId === pfId; });
  slips.sort((a, b) => String(a.employeeName || "").localeCompare(String(b.employeeName || "")));
  if (!slips.length) return res.status(404).json({ error: "Aucun bulletin pour ce filtre" });
  const tenant = (db.tenants || []).find(t => t.id === (run.tenantId || "t1")) || { name: "SGRHP" };
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Bulletins_${run.period}${pfId ? "_portefeuille" : ""}.pdf"`);
  const doc = new PDFDocument({ margin: 18, size: "A4" });
  doc.pipe(res);
  slips.forEach((s, i) => { if (i) doc.addPage(); try { drawPayslip(doc, s, empById[s.employeeId] || {}, tenant); } catch (e) {} });
  doc.end();
});

/* ===================== FICHE INDIVIDUELLE (annuelle) ===================== */
const FI_MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
function ficheIndividuelle(eid, year, req) {
  const emp = mine(db.employees, req).find(e => e.id === eid); if (!emp) return null;
  const yr = String(year);
  const byMonth = {};
  mine(db.payslips, req).filter(s => s.employeeId === eid && String(s.period || "").slice(0, 4) === yr)
    .forEach(s => { byMonth[parseInt(String(s.period).slice(5, 7), 10)] = s; });
  const idx = {};
  for (let m = 1; m <= 12; m++) { const s = byMonth[m]; if (!s) continue;
    for (const l of (s.result.lines || [])) {
      const amt = l.kind === "GAIN" ? (l.gain || 0) : ((l.retenue || 0) || (l.employer || 0));
      if (!amt) continue;
      const r = idx[l.code] || (idx[l.code] = { code: l.code, label: l.label, kind: l.kind, monthly: new Array(12).fill(0) });
      r.monthly[m - 1] += amt;
    }
  }
  const rubriques = Object.values(idx).map(r => ({ ...r, total: r.monthly.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const sumRow = (label, fn) => { const monthly = new Array(12).fill(0); for (let m = 1; m <= 12; m++) { const s = byMonth[m]; if (s) monthly[m - 1] = Math.round(fn(s.result.totals || {}, s.result.meta || {}) || 0); } return { label, monthly, total: monthly.reduce((a, b) => a + b, 0) }; };
  const summary = [
    sumRow("Total Brut", t => t.brutTotal), sumRow("Cotisations salariales", t => t.totalRetenues),
    sumRow("Cotisations patronales", t => t.chargesPatronales), sumRow("Net imposable", t => t.netImposable),
    sumRow("Net à payer", t => t.netAPayer), sumRow("Coût total employeur", t => t.coutTotalEmployeur),
    sumRow("Jours de présence", (t, meta) => meta.workedDays || 0),
  ];
  return { employee: { id: emp.id, name: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(), matricule: emp.matricule || "", category: (emp.contract && emp.contract.category) || "" }, year: Number(year), months: FI_MOIS, rubriques, summary };
}
router.get("/employees/:eid/fiche", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const fi = ficheIndividuelle(req.params.eid, year, req);
  if (!fi) return res.status(404).json({ error: "Employé introuvable" });
  res.json(fi);
});
router.get("/employees/:eid/fiche.xlsx", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const fi = ficheIndividuelle(req.params.eid, req.query.year || new Date().getFullYear(), req);
  if (!fi) return res.status(404).json({ error: "Employé introuvable" });
  const head = ["Rubrique", ...fi.months.map(m => m.slice(0, 4)), "Total"];
  const aoa = [[`Fiche individuelle - ${fi.employee.name} (${fi.employee.matricule})`], [`Année ${fi.year}`], [], head];
  fi.rubriques.forEach(r => aoa.push([`${r.code} ${r.label}`, ...r.monthly.map(x => Math.round(x)), Math.round(r.total)]));
  aoa.push([]);
  fi.summary.forEach(r => aoa.push([r.label, ...r.monthly.map(x => Math.round(x)), Math.round(r.total)]));
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 34 }, ...fi.months.map(() => ({ wch: 10 })), { wch: 12 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Fiche individuelle");
  res.setHeader("Content-Disposition", `attachment; filename="FI_${(fi.employee.name || "").replace(/[^\w]/g, "_")}_${fi.year}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});
router.get("/employees/:eid/fiche.pdf", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const fi = ficheIndividuelle(req.params.eid, req.query.year || new Date().getFullYear(), req);
  if (!fi) return res.status(404).json({ error: "Employé introuvable" });
  const F = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const doc = new PDFDocument({ margin: 20, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="FI_${(fi.employee.name || "").replace(/[^\w]/g, "_")}_${fi.year}.pdf"`);
  doc.pipe(res);
  doc.fontSize(13).font("Helvetica-Bold").text(`Fiche individuelle - ${fi.employee.name}`, 20, 20);
  doc.fontSize(9).font("Helvetica").fillColor("#555").text(`Matricule ${fi.employee.matricule || "-"} - Catégorie ${fi.employee.category || "-"} - Année ${fi.year}`, 20, 38);
  doc.fillColor("#111");
  const X0 = 20, W = 802, cLabel = 150, cTot = 60, cM = (W - cLabel - cTot) / 12;
  let y = 58;
  const rowH = 13;
  const drawRow = (label, cells, bold, total) => {
    if (y > 545) { doc.addPage(); y = 20; }
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(7);
    doc.text(label, X0, y, { width: cLabel - 2, ellipsis: true });
    cells.forEach((c, i) => doc.text(F(c), X0 + cLabel + i * cM, y, { width: cM - 2, align: "right" }));
    doc.text(F(total), X0 + cLabel + 12 * cM, y, { width: cTot - 2, align: "right" });
    y += rowH;
  };
  drawRow("Rubrique", fi.months.map((m, i) => m.slice(0, 3)), true, "Total");
  doc.moveTo(X0, y - 2).lineTo(X0 + W, y - 2).strokeColor("#ccc").stroke();
  fi.rubriques.forEach(r => drawRow(`${r.code} ${r.label}`, r.monthly, false, r.total));
  y += 4; doc.moveTo(X0, y - 2).lineTo(X0 + W, y - 2).strokeColor("#999").stroke();
  fi.summary.forEach(r => drawRow(r.label, r.monthly, true, r.total));
  doc.end();
});

/* ===================== LIVRE DE PAIE ========================== */
router.get("/runs/:id/livre", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.livre")) return res.status(403).json({ error: "Livre de paie non autorise - demandez le droit a votre administrateur" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  res.json({ run, rows: slips.map(summary), totals: runTotals(run, req) });
});

/* ================= ÉTATS DES COTISATIONS ===================== */
router.get("/runs/:id/cotisations", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.cotisations")) return res.status(403).json({ error: "Etats des cotisations non autorise - demandez le droit a votre administrateur" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  const agg = {};
  for (const s of slips) for (const l of s.result.lines) {
    if (l.kind !== "COTIS" && l.kind !== "IMPOT") continue;
    const a = agg[l.code] || (agg[l.code] = { code: l.code, label: l.label, base: 0, salarie: 0, patronal: 0 });
    a.base += l.base || 0; a.salarie += l.retenue || 0; a.patronal += l.employer || 0;
  }
  res.json({ run, lignes: Object.values(agg), totals: runTotals(run, req) });
});

// Edit an individual payslip: override specific rubrique AMOUNTS by hand (formula/base
// stay locked). Re-totals without re-running the engine. Adjusts cumuls if the run is closed.
router.put("/payslips/:id/lines", allow("RP", "ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
  if (req.user.role !== "ADM") {
    const _u = db.users.find(x => x.id === req.user.id);
    if (!(((_u && _u.permissions) || []).includes("payroll.edit")))
      return res.status(403).json({ error: "Correction de paie non autorisée - demandez le droit à l'administrateur" });
  }
  const s = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Bulletin introuvable" });
  const run = mine(db.payRuns, req).find(r => r.id === s.runId);
  const closed = run && run.status === "CLOSED";
  if (closed && !(req.body && req.body.force))
    return res.status(409).json({ error: "Paie clôturée",
      requiresConfirmation: true,
      warning: "Cette paie est clôturée. Corriger ce bulletin ajustera les cumuls de l'employé. Confirmez pour appliquer." });
  const before = { ...s.result.totals };
  if (Array.isArray(req.body.lines)) {
    // Full edit: add / remove / modify rubriques (formula not re-run; amounts as given)
    s.result.lines = req.body.lines
      .filter(l => l && l.code)
      .map(l => {
        const o = { code: String(l.code), label: String(l.label || l.code), kind: l.kind || "GAIN",
          base: Number(l.base) || 0, rate: Number(l.rate) || 0,
          gain: Math.round(Number(l.gain) || 0), retenue: Math.round(Number(l.retenue) || 0),
          employer: Math.round(Number(l.employer) || 0), employerRate: Number(l.employerRate) || 0,
          cnps: !!l.cnps, impo: !!l.impo, manual: true };
        // Préserver les quantités (nombre de jours/heures) : elles ne sont pas éditées à l'écran
        // mais doivent rester sur le bulletin après correction.
        if (l.nombre !== undefined && l.nombre !== null && l.nombre !== "") o.nombre = Number(l.nombre);
        if (l.hours !== undefined && l.hours !== null && l.hours !== "") o.hours = Number(l.hours);
        return o;
      });
  } else {
    const overrides = (req.body && req.body.overrides) || {};
    for (const l of s.result.lines) {
      const o = overrides[l.code]; if (!o) continue;
      if (o.gain !== undefined && l.kind === "GAIN") { l.gain = Math.round(Number(o.gain) || 0); l.manual = true; }
      if (o.retenue !== undefined) { l.retenue = Math.round(Number(o.retenue) || 0); l.manual = true; }
      if (o.employer !== undefined) { l.employer = Math.round(Number(o.employer) || 0); l.manual = true; }
    }
  }
  recomputePayslip(s);
  const t = s.result.totals;
  s.edited = true;
  if (closed) {
    const cum = db.payCumuls.find(c => (c.tenantId || "t1") === (s.tenantId || "t1") && c.employeeId === s.employeeId && c.year === s.period.slice(0, 4));
    if (cum) { cum.brut += t.brutTotal - before.brutTotal; cum.net += t.netAPayer - before.netAPayer;
      cum.irpp += (t.irpp || 0) - (before.irpp || 0); cum.cnps += (t.cnpsSalarie || 0) - (before.cnpsSalarie || 0); }
  }
  save();
  audit(req.user, "PAYSLIP_EDITED", "Payslip", s.id, { employeeId: s.employeeId, period: s.period, mode: Array.isArray(req.body.lines) ? "full" : "override", lineCount: s.result.lines.length, closed });
  res.json(s);
});

/* ---------------- Exports (CSV / Excel-openable) ---------------- */
router.get("/runs/:id/livre/export", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.livre")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const rows = [["Matricule", "Nom", "Catégorie", "Brut", "CNPS sal.", "IRPP", "CAC", "CFC", "RAV", "TDL", "Autres retenues", "Total retenues", "Net à payer", "Charges patronales", "Coût employeur"]];
  for (const s2 of mine(db.payslips, req).filter(x => x.runId === run.id)) {
    const t = s2.result.totals;
    rows.push([s2.matricule, s2.employeeName, s2.department, t.brutTotal, t.cnpsSalarie, t.irpp, t.cac, t.cfcSalarie, t.rav, t.tdl, t.autresRetenues, t.totalRetenues, t.netAPayer, t.chargesPatronales, t.coutTotalEmployeur]);
  }
  const tt = runTotals(run, req);
  rows.push(["", "TOTAUX (" + tt.count + ")", "", tt.brut, "", "", "", "", "", "", "", "", tt.net, tt.charges, tt.cout]);
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "livre", format: "csv" });
  sendCSV(res, `Livre_de_paie_${run.period}.csv`, rows);
});
router.get("/runs/:id/cotisations/export", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.cotisations")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const agg = {};
  for (const s2 of mine(db.payslips, req).filter(x => x.runId === run.id))
    for (const l of s2.result.lines) {
      if (l.kind !== "COTIS" && l.kind !== "IMPOT") continue;
      const a = agg[l.code] || (agg[l.code] = { code: l.code, label: l.label, base: 0, sal: 0, pat: 0 });
      a.base += l.base || 0; a.sal += l.retenue || 0; a.pat += l.employer || 0;
    }
  const rows = [["Code", "Cotisation", "Base cumulée", "Part salariale", "Part patronale"]];
  for (const a of Object.values(agg)) rows.push([a.code, a.label, a.base, a.sal, a.pat]);
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "cotisations", format: "csv" });
  sendCSV(res, `Etats_cotisations_${run.period}.csv`, rows);
});

/* ============ LIVRE DE PAIE & ÉTAT DES COTISATIONS - PDF / Excel ============ */
function _sexOf(e) { const c = (e && e.civility) || ""; return (c === "Mme" || c === "Mlle") ? "F" : "H"; }
function _slipsOfRun(run, req) {
  return mine(db.payslips, req).filter(x => x.runId === run.id)
    .sort((a, b) => String(a.matricule || "").localeCompare(String(b.matricule || "")));
}
function _tenantOf(run) { return (db.tenants || []).find(t => t.id === (run.tenantId || "t1")) || { name: "SGRHP" }; }
const _NF = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function cotisData(run, req) {
  const slips = _slipsOfRun(run, req);
  const empById = {}; mine(db.employees, req).forEach(e => empById[e.id] = e);
  const order = [], agg = {};
  for (const s of slips) {
    const sex = _sexOf(empById[s.employeeId]);
    for (const l of s.result.lines) {
      if (l.kind !== "COTIS" && l.kind !== "IMPOT") continue;
      let a = agg[l.code];
      if (!a) { a = agg[l.code] = { code: l.code, label: l.label, rateSal: 0, ratePat: 0, base: 0, sal: 0, pat: 0, seen: {}, nH: 0, nF: 0 }; order.push(l.code); }
      if (l.rate) a.rateSal = l.rate;
      if (l.employerRate) a.ratePat = l.employerRate;
      a.base += l.base || 0; a.sal += l.retenue || 0; a.pat += l.employer || 0;
      if (((l.retenue || 0) > 0 || (l.employer || 0) > 0) && !a.seen[s.employeeId]) { a.seen[s.employeeId] = 1; if (sex === "F") a.nF++; else a.nH++; }
    }
  }
  return order.map(c => { const a = agg[c]; return {
    code: a.code, label: a.label, rateSal: a.rateSal, ratePat: a.ratePat, rateGlobal: a.rateSal + a.ratePat,
    base: Math.round(a.base), sal: Math.round(a.sal), pat: Math.round(a.pat), global: Math.round(a.sal + a.pat), nH: a.nH, nF: a.nF }; });
}

function livreData(run, req) {
  const slips = _slipsOfRun(run, req);
  const empById = {}; mine(db.employees, req).forEach(e => empById[e.id] = e);
  const cols = slips.map(s => { const e = empById[s.employeeId] || {}; return { matricule: s.matricule || "", civ: e.civility || "", name: s.employeeName || "", slip: s }; });
  const gainCodes = [], cotisCodes = [], gLbl = {}, cLbl = {};
  for (const s of slips) for (const l of s.result.lines) {
    if (l.kind === "GAIN" || l.kind === "AVANTAGE") { if (!(l.code in gLbl)) { gLbl[l.code] = l.label; gainCodes.push(l.code); } }
    else if ((l.kind === "COTIS" || l.kind === "IMPOT") && (l.retenue || 0) > 0) { if (!(l.code in cLbl)) { cLbl[l.code] = l.label; cotisCodes.push(l.code); } }
  }
  gainCodes.sort(); cotisCodes.sort();
  const gainOf = (slip, code) => { const l = slip.result.lines.find(x => x.code === code && (x.kind === "GAIN" || x.kind === "AVANTAGE")); return l ? Math.round(l.gain || 0) : 0; };
  const cotisOf = (slip, code) => { const l = slip.result.lines.find(x => x.code === code && (x.kind === "COTIS" || x.kind === "IMPOT")); return l ? Math.round(l.retenue || 0) : 0; };
  const brut = (slip) => Math.round(slip.result.totals.brutTotal || 0);
  const totCot = (slip) => Math.round((slip.result.totals.cnpsSalarie || 0) + (slip.result.totals.totalImpots || 0));
  return { cols, gainCodes, cotisCodes, gLbl, cLbl, gainOf, cotisOf, brut, totCot };
}

const _SUMMARY = [
  ["Présence", s => (s.result.meta && s.result.meta.workedDays) || 30],
  ["Brut", s => Math.round(s.result.totals.brutTotal || 0)],
  ["Cotisations salariales", s => Math.round((s.result.totals.cnpsSalarie || 0) + (s.result.totals.totalImpots || 0))],
  ["Cotisations patronales", s => Math.round(s.result.totals.chargesPatronales || 0)],
  ["Net à payer", s => Math.round(s.result.totals.netAPayer || 0)],
  ["Net imposable", s => Math.round(s.result.totals.netImposable || 0)],
  ["Avantages en nature", s => Math.round(s.result.totals.avantagesNature || 0)],
  ["Coût total", s => Math.round(s.result.totals.coutTotalEmployeur || 0)],
  ["ETP", () => 1],
];

/* ---- Livre de paie : Excel (matrice) ---- */
router.get("/runs/:id/livre/excel", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.livre")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const XLSX = require("xlsx");
  const D = livreData(run, req), C = D.cols;
  const aoa = [];
  aoa.push(["Code", "Rubrique", ...C.map(c => c.matricule)]);
  aoa.push(["", "", ...C.map(c => `${c.civ} ${c.name}`.trim())]);
  for (const code of D.gainCodes) aoa.push([code, D.gLbl[code], ...C.map(c => D.gainOf(c.slip, code) || "")]);
  aoa.push(["", "TOTAL BRUT", ...C.map(c => D.brut(c.slip))]);
  for (const code of D.cotisCodes) aoa.push([code, D.cLbl[code], ...C.map(c => D.cotisOf(c.slip, code) || "")]);
  aoa.push(["", "TOTAL COTISATION", ...C.map(c => D.totCot(c.slip))]);
  aoa.push([]);
  for (const [lbl, fn] of _SUMMARY) aoa.push(["", lbl, ...C.map(c => fn(c.slip))]);
  aoa.push(["", "Nombre de salariés", C.length]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Livre de paie");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "livre", format: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Livre_de_paie_${run.period}.xlsx"`);
  res.send(buf);
});

/* ---- Livre de paie : PDF (matrice, colonnes paginées) ---- */
router.get("/runs/:id/livre/pdf", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.livre")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const D = livreData(run, req), tenant = _tenantOf(run);
  const doc = new PDFDocument({ margin: 18, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Livre_de_paie_${run.period}.pdf"`);
  doc.pipe(res);
  const _now=new Date(), _d=_now.toLocaleDateString("fr-FR"), _t=_now.toLocaleTimeString("fr-FR");
  const _fmtD=(p)=>{const a=String(p||"").split("-");return a.length>=2?("01/"+a[1]+"/"+String(a[0]).slice(2)):p;};
  const _from=_fmtD(run.period), _to=(()=>{const a=String(run.period).split("-");const y=+a[0],m=+a[1];const dd=new Date(y,m,0).getDate();return String(dd).padStart(2,"0")+"/"+a[1]+"/"+String(y).slice(2);})();
  const x0=20, labelW=150, colW=78;
  const totFn=(fn)=>D.cols.reduce((a,c)=>a+fn(c.slip),0);
  const PER = 7, groups = [];
  for (let i = 0; i < D.cols.length; i += PER) groups.push(D.cols.slice(i, i + PER));
  if (!groups.length) groups.push([]);
  function band(page, nBody, hasTotal){
    let y=20; const bandW=doc.page.width-2*x0;
    doc.save(); doc.rect(x0,y,bandW,50).fill("#d7e6cf"); doc.restore();
    doc.lineWidth(0.8).strokeColor("#000").rect(x0,y,bandW,50).stroke();
    doc.fillColor("#000").font("Helvetica").fontSize(7.5);
    doc.text("Date du jour : "+_d, x0+6, y+6,{lineBreak:false});
    doc.text("Heure : "+_t, x0+6, y+18,{lineBreak:false});
    doc.text("Edition en : Francs", x0+6, y+34,{lineBreak:false});
    doc.font("Helvetica-Bold").fontSize(14).text("Livre de paie  /  P E R I O D E", x0, y+8,{width:bandW,align:"center"});
    doc.font("Helvetica").fontSize(8).text("Période du "+_from+" au "+_to, x0, y+28,{width:bandW,align:"center"});
    doc.fontSize(7.5).text("Page : "+page+"/"+groups.length, x0, y+6,{width:bandW-6,align:"right"});
    y+=50;
    doc.rect(x0,y,bandW,14).stroke(); doc.font("Helvetica").fontSize(8);
    doc.text("Société : "+(tenant.name||""), x0+6, y+3,{lineBreak:false});
    doc.text("© MBOKA Mon RH   V 1.0", x0, y+3,{width:bandW-6,align:"right"});
    y+=14;
    doc.rect(x0,y,bandW,13).stroke();
    doc.font("Helvetica").fontSize(7.5).text("Ventilation par Salarié", x0+6, y+3,{lineBreak:false});
    y+=13;
    return y;
  }
  groups.forEach((grp, gi) => {
    if (gi > 0) doc.addPage();
    const isLast = gi === groups.length - 1;
    const nBody = grp.length;
    let y = band(gi+1, nBody, isLast);
    const headTop = y;
    const colX = (i) => x0 + labelW + i * colW;
    const totX = colX(nBody);
    const fullW = labelW + nBody*colW + (isLast?colW:0);
    const T = (x, yy, txt, o) => { o = o || {}; doc.font(o.b ? "Helvetica-Bold" : "Helvetica").fontSize(o.s || 7).fillColor(o.c || "#000").text(txt == null ? "" : String(txt), x, yy, { width: o.w, align: o.a, lineBreak: false }); };
    const HH = 30;
    doc.rect(x0, y, fullW, HH).fillAndStroke("#e6efe9", "#000");
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(8).text("Rubriques", x0 + 3, y + 3, { lineBreak: false });
    grp.forEach((c, i) => {
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#000").text(String(c.matricule || ""), colX(i) + 2, y + 2.5, { width: colW - 4, lineBreak: false, ellipsis: true });
      doc.font("Helvetica").fontSize(5.6).text(`${c.civ || ""} ${c.name || ""}`.trim(), colX(i) + 2, y + 10.5, { width: colW - 4, height: 17, lineBreak: true, ellipsis: true });
    });
    if (isLast) doc.font("Helvetica-Bold").fontSize(8).fillColor("#000").text("Total", totX + 2, y + 3, { width: colW - 4, lineBreak: false });
    // séparateurs verticaux d'en-tête
    doc.lineWidth(0.4).strokeColor("#000");
    for (let i = 0; i <= nBody + (isLast?1:0); i++) { const vx = x0 + labelW + i * colW; doc.moveTo(vx, y).lineTo(vx, y + HH).stroke(); }
    doc.moveTo(x0 + labelW, y).lineTo(x0 + labelW, y + HH).stroke();
    y += HH;
    const rowH = 11;
    const row = (code, label, vals, hl, totVal) => {
      if (hl) doc.rect(x0, y, fullW, rowH).fillAndStroke("#fdf6c8", "#e5c200");
      doc.fillColor("#000");
      if (code) T(x0 + 3, y + 2, code, { s: 6.3, w: 26 });
      T(x0 + 31, y + 2, label, { b: !!hl, s: hl ? 7 : 6.6, w: labelW - 34 });
      vals.forEach((v, i) => T(colX(i), y + 2, v === 0 || v === "" ? "" : _NF(v), { b: !!hl, s: 6.6, w: colW - 4, a: "right" }));
      if (isLast) T(totX, y + 2, (totVal === 0 || totVal === "" || totVal == null) ? "" : _NF(totVal), { b: true, s: 6.6, w: colW - 4, a: "right" });
      if (!hl) { doc.lineWidth(0.25).strokeColor("#e3e3e3").moveTo(x0, y + rowH).lineTo(x0 + fullW, y + rowH).stroke(); }
      y += rowH;
    };
    for (const code of D.gainCodes) row(code, D.gLbl[code], grp.map(c => D.gainOf(c.slip, code)), false, totFn(s => D.gainOf(s, code)));
    row("", "Total Brut", grp.map(c => D.brut(c.slip)), true, totFn(s => D.brut(s)));
    for (const code of D.cotisCodes) row(code, D.cLbl[code], grp.map(c => D.cotisOf(c.slip, code)), false, totFn(s => D.cotisOf(s, code)));
    row("", "Total Cotisation", grp.map(c => D.totCot(c.slip)), true, totFn(s => D.totCot(s)));
    y += 4;
    for (const [lbl, fn] of _SUMMARY) row("", lbl, grp.map(c => fn(c.slip)), false, totFn(s => fn(s)));
    if (isLast) { y += 2; row("", "Nombre de salariés", grp.map(() => ""), false, D.cols.length); }
    doc.lineWidth(0.4).strokeColor("#999");
    const nAll = nBody + (isLast ? 1 : 0);
    for (let i = 0; i <= nAll; i++) { const vx = x0 + labelW + i * colW; doc.moveTo(vx, headTop).lineTo(vx, y).stroke(); }
    doc.moveTo(x0, headTop).lineTo(x0, y).stroke();
    doc.rect(x0, headTop, fullW, y - headTop).stroke();
  });
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "livre", format: "pdf" });
  doc.end();
});

/* ---- État des cotisations : Excel ---- */
router.get("/runs/:id/cotisations/excel", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.cotisations")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const XLSX = require("xlsx");
  const lignes = cotisData(run, req);
  const aoa = [["Code", "Intitulé rubrique", "Taux salarial", "Taux patronal", "Taux global", "Assiette", "Montant salarial", "Montant patronal", "Montant global", "Nb hommes", "Nb femmes"]];
  for (const l of lignes) aoa.push([l.code, l.label, +(l.rateSal * 100).toFixed(2), +(l.ratePat * 100).toFixed(2), +(l.rateGlobal * 100).toFixed(2), l.base, l.sal, l.pat, l.global, l.nH, l.nF]);
  const tot = lignes.reduce((o, l) => { o.sal += l.sal; o.pat += l.pat; o.g += l.global; return o; }, { sal: 0, pat: 0, g: 0 });
  aoa.push([]); aoa.push(["", "TOTAUX", "", "", "", "", tot.sal, tot.pat, tot.g, "", ""]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Cotisations");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "cotisations", format: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Etat_cotisations_${run.period}.xlsx"`);
  res.send(buf);
});

/* ---- État des cotisations : PDF ---- */
router.get("/runs/:id/cotisations/pdf", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.cotisations")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const lignes = cotisData(run, req), tenant = _tenantOf(run);
  const doc = new PDFDocument({ margin: 24, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Etat_cotisations_${run.period}.pdf"`);
  doc.pipe(res);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#000").text(`État des cotisations  -  ${run.period}`, { align: "center" });
  doc.font("Helvetica").fontSize(9).text(`${tenant.name || ""}   -   Base de déclaration CNPS & impôts (DIPE)`, { align: "center" });
  doc.moveDown(0.6);
  const cols = [["Code", 34, "left"], ["Intitulé rubrique", 170, "left"], ["Tx sal.", 42, "right"], ["Tx pat.", 42, "right"], ["Tx glob.", 44, "right"], ["Assiette", 88, "right"], ["M. salarial", 78, "right"], ["M. patronal", 78, "right"], ["M. global", 78, "right"], ["H", 30, "right"], ["F", 30, "right"]];
  const x0 = 24; let x = x0; const xs = cols.map(c => { const cx = x; x += c[1]; return cx; }); const totW = x - x0;
  let y = doc.y;
  const T = (cx, yy, txt, w, al, b, sz) => doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(sz || 8).text(txt == null ? "" : String(txt), cx + 2, yy, { width: w - 4, align: al, lineBreak: false });
  doc.rect(x0, y, totW, 16).fillAndStroke("#e6efe9", "#000"); doc.fillColor("#000");
  cols.forEach((c, i) => T(xs[i], y + 4, c[0], c[1], c[2], true, 7.5));
  y += 16;
  const pct = (v) => (v * 100).toFixed(2).replace(".", ",");
  for (const l of lignes) {
    const cells = [l.code, l.label, l.rateSal ? pct(l.rateSal) : "", l.ratePat ? pct(l.ratePat) : "", pct(l.rateGlobal), _NF(l.base), _NF(l.sal), _NF(l.pat), _NF(l.global), l.nH, l.nF];
    cells.forEach((v, i) => T(xs[i], y + 2, v, cols[i][1], cols[i][2], false, 7.5));
    doc.lineWidth(0.3).strokeColor("#ccc").moveTo(x0, y + 12).lineTo(x0 + totW, y + 12).stroke();
    y += 13;
    if (y > 560) { doc.addPage(); y = 40; }
  }
  const tot = lignes.reduce((o, l) => { o.sal += l.sal; o.pat += l.pat; o.g += l.global; return o; }, { sal: 0, pat: 0, g: 0 });
  y += 2; doc.lineWidth(0.6).strokeColor("#000").moveTo(x0, y).lineTo(x0 + totW, y).stroke(); y += 3;
  T(xs[1], y, "TOTAUX", cols[1][1], "left", true); T(xs[6], y, _NF(tot.sal), cols[6][1], "right", true); T(xs[7], y, _NF(tot.pat), cols[7][1], "right", true); T(xs[8], y, _NF(tot.g), cols[8][1], "right", true);
  doc.rect(x0, doc.y, totW, 0);
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "cotisations", format: "pdf" });
  doc.end();
});
// Ordre de virement - net salaries with bank details, for the bank.
router.get("/runs/:id/virement", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  if (!canRunPayroll(req)) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  // Contrôle GPF <-> Paie : si des bordereaux existent pour la période, ils doivent tous être « Bon à payer ».
  const periodSheets = mine(db.payElementSheets, req).filter(sh => sh.period === run.period);
  const pending = periodSheets.filter(sh => sh.status !== "BON_A_PAYER");
  if (periodSheets.length && pending.length) {
    const pfs = mine(db.portfolios, req);
    const names = pending.map(sh => (pfs.find(p => p.id === sh.portfolioId) || {}).name || "(client)");
    return res.status(409).json({ error: `Ordre de virement bloqué : ${pending.length} bordereau(x) en attente de « Bon à payer » (${names.slice(0,5).join(", ")}${names.length>5?"…":""}). Faites signer le Bon à payer (CD/Audit) avant d'éditer le virement.` });
  }
  const rows = [["Matricule", "Bénéficiaire", "Nom banque", "Code banque", "Code guichet", "N° de compte", "Clé RIB", "RIB complet", "Montant net", "Devise", "Motif"]];
  let total = 0;
  for (const s2 of mine(db.payslips, req).filter(x => x.runId === run.id)) {
    const emp = mine(db.employees, req).find(e => e.id === s2.employeeId) || {};
    const c = emp.contract || {}; const bk = emp.bank || {};
    const code = bk.code || emp.bankCode || "", gui = bk.branch || emp.bankBranch || "", acc = bk.account || emp.bankAccount || c.bankIban || "", key = bk.key || emp.bankKey || "";
    const rib = [code, gui, acc, key].filter(Boolean).join(" ");
    const net = s2.result.totals.netAPayer; total += net;
    rows.push([s2.matricule, s2.employeeName, bk.name || emp.bankName || c.bankName || "", code, gui, acc, key, rib, net, "XAF", `Salaire ${run.period}`]);
  }
  rows.push(["", "TOTAL", "", "", "", "", "", "", total, "XAF", `Ordre de virement ${run.period}`]);
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "virement", format: "csv" });
  sendCSV(res, `Ordre_de_virement_${run.period}.csv`, rows);
});
// Email a payslip summary to the employee.
async function sendPayslipEmail(s2, req) {
  const emp = mine(db.employees, req).find(e => e.id === s2.employeeId) || {};
  if (!emp.email) throw new Error("Aucune adresse email pour " + (s2.employeeName || "ce salarié"));
  const tenant = (db.tenants || []).find(t => t.id === (s2.tenantId || "t1")) || { name: "SGRHP" };
  const t = s2.result.totals;
  const ref = String(s2.id || "").toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const body =
    `Bonjour ${s2.employeeName},\n\n` +
    `Veuillez trouver ci-joint votre bulletin de paie pour la période ${s2.period}.\n\n` +
    `Salaire brut   : ${money(t.brutTotal)} XAF\n` +
    `Total retenues : ${money(t.totalRetenues)} XAF\n` +
    `Net à payer    : ${money(t.netAPayer)} XAF\n\n` +
    `Cordialement,\nLe service RH - ${tenant.name}\n\n` +
    `----------------------------------------------------------------------\n` +
    `AUTHENTICITÉ : Ce message et le bulletin ci-joint (PDF) ont été générés\n` +
    `automatiquement par le système RH & Paie de ${tenant.name} (SGRHP).\n` +
    `Référence du document : ${ref}\n` +
    `Émis le : ${today}\n` +
    `Ceci est une communication officielle. Pour toute vérification, contactez\n` +
    `le service RH de ${tenant.name}. Ne communiquez ce bulletin à personne.`;
  const pdf = await payslipBuffer(s2, emp, tenant);
  const filename = `Bulletin_${String(s2.employeeName || "").replace(/[^\w]/g, "_")}_${s2.period}.pdf`;
  await require("../mailer").send(emp.email, `Bulletin de paie ${s2.period} - ${tenant.name}`, body,
    [{ filename, content: pdf, contentType: "application/pdf" }]);
  s2.emailedAt = new Date().toISOString(); save();
  audit(req.user, "EMAILED", "Payslip", s2.id, { to: emp.email, period: s2.period });
  return emp.email;
}

router.post("/payslips/:id/email", allow("RP", "ADM", "CD", "RJ", "GPF"), async (req, res) => {
  const s2 = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s2) return res.status(404).json({ error: "Bulletin introuvable" });
  try { const to = await sendPayslipEmail(s2, req); res.json({ ok: true, to }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Bulk: email every computed payslip of a run (optionally filtered to one portfolio).
router.post("/runs/:id/email-portfolio", allow("RP", "ADM", "CD", "RJ", "GPF"), async (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const pfId = (req.body && req.body.portfolioId) || null;
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  const slips = mine(db.payslips, req).filter(x => x.runId === run.id &&
    (!pfId || (empById[x.employeeId] && empById[x.employeeId].portfolioId === pfId)));
  let sent = 0; const errors = [];
  for (const s2 of slips) {
    try { await sendPayslipEmail(s2, req); sent++; }
    catch (e) { errors.push(`${s2.employeeName}: ${e.message}`); }
  }
  audit(req.user, "EMAILED_BULK", "PayRun", run.id, { portfolioId: pfId, sent, failed: errors.length });
  res.json({ ok: true, sent, failed: errors.length, errors: errors.slice(0, 25) });
});

/* ---------------- Prêts (loans with échéancier) ---------------- */
router.get("/loans", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const { employeeId } = req.query;
  let list = mine(db.payLoans, req);
  if (employeeId) list = list.filter(l => l.employeeId === employeeId);
  res.json(list);
});
router.post("/loans", allow("RP", "ADM", "GPF"), (req, res) => {
  const b = req.body || {};
  if (!b.employeeId || !(Number(b.principal) > 0) || !(Number(b.installments) > 0))
    return res.status(400).json({ error: "employeeId, principal et nombre d'échéances requis" });
  const principal = Number(b.principal), installments = Math.round(Number(b.installments));
  const l = stamp({ id: id("loan"), employeeId: b.employeeId, label: b.label || "Prêt",
    principal, installments, monthlyAmount: Math.round(principal / installments),
    startPeriod: b.startPeriod || new Date().toISOString().slice(0, 7), active: true,
    createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.payLoans.push(l); save();
  audit(req.user, "CREATED", "PayLoan", l.id, { employeeId: l.employeeId, principal, installments });
  res.status(201).json(l);
});
router.put("/loans/:id", allow("RP", "ADM", "GPF"), (req, res) => {
  const l = mine(db.payLoans, req).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: "Prêt introuvable" });
  if (req.body.active !== undefined) l.active = !!req.body.active;
  save(); res.json(l);
});
router.delete("/loans/:id", allow("RP", "ADM", "GPF"), (req, res) => {
  const i = db.payLoans.findIndex(x => x.id === req.params.id && (x.tenantId || "t1") === (req.user.tenantId || "t1"));
  if (i < 0) return res.status(404).json({ error: "Introuvable" });
  db.payLoans.splice(i, 1); save(); res.json({ ok: true });
});

/* ---------------- Passation comptable ---------------- */
const ACC_DEFAULTS = { salairesBrut: "641", chargesPatronales: "645", cnps: "431", impots: "447", netAPayer: "421", avances: "425" };
function accountingOf(req) { const c = configOf(req); return { ...ACC_DEFAULTS, ...(c.accounting || {}) }; }

function buildJournal(run, req) {
  const model = accountingOf(req);
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  const zero = () => ({ brut: 0, cnpsSal: 0, cnpsPat: 0, impots: 0, chargesPat: 0, cfcFnePat: 0, net: 0, autres: 0 });
  const agg = zero(), byPf = {};
  for (const s of slips) {
    const t = s.result.totals;
    const emp = mine(db.employees, req).find(e => e.id === s.employeeId) || {};
    const pf = emp.portfolioId || "-";
    const acc = (o) => {
      o.brut += t.brutTotal; o.cnpsSal += t.cnpsSalarie; o.cnpsPat += t.cnpsPatronal;
      o.impots += (t.irpp || 0) + (t.cac || 0) + (t.cfcSalarie || 0) + (t.rav || 0) + (t.tdl || 0);
      o.chargesPat += t.chargesPatronales; o.cfcFnePat += (t.cfcPatronal || 0) + (t.fnePatronal || 0);
      o.net += t.netAPayer; o.autres += (t.autresRetenues || 0);
    };
    acc(agg); acc(byPf[pf] = byPf[pf] || zero());
  }
  const E = (compte, libelle, debit, credit) => ({ compte, libelle, debit: Math.round(debit || 0), credit: Math.round(credit || 0) });
  const entries = [
    E(model.salairesBrut, "Rémunérations brutes", agg.brut, 0),
    E(model.chargesPatronales, "Charges patronales", agg.chargesPat, 0),
    E(model.cnps, "CNPS (salariale + patronale)", 0, agg.cnpsSal + agg.cnpsPat),
    E(model.impots, "Impôts & taxes (IRPP/CAC/CFC/RAV/TDL/FNE)", 0, agg.impots + agg.cfcFnePat),
    E(model.avances, "Acomptes / prêts (avances)", 0, agg.autres),
    E(model.netAPayer, "Net à payer au personnel", 0, agg.net),
  ].filter(e => e.debit || e.credit);
  const totalDebit = entries.reduce((a, e) => a + e.debit, 0), totalCredit = entries.reduce((a, e) => a + e.credit, 0);
  const ventilation = Object.keys(byPf).map(pf => ({ portfolio: pf, ...byPf[pf] }));
  return { model, entries, totalDebit, totalCredit, balanced: totalDebit === totalCredit, ventilation };
}

router.get("/accounting-model", allow("RP", "ADM", "CD", "RJ"), (req, res) => res.json(accountingOf(req)));
router.put("/accounting-model", allow("RP", "ADM"), (req, res) => {
  const c = configOf(req); c.accounting = { ...ACC_DEFAULTS, ...(c.accounting || {}), ...(req.body || {}) };
  save(); audit(req.user, "CONFIG_CHANGED", "AccountingModel", c.id, { accounting: c.accounting });
  res.json(c.accounting);
});
router.get("/runs/:id/journal", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  if (!hasPayPerm(req, "payroll.compta")) return res.status(403).json({ error: "Passation comptable non autorisée" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  res.json({ run, ...buildJournal(run, req) });
});
router.get("/runs/:id/journal/export", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  if (!hasPayPerm(req, "payroll.compta")) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const j = buildJournal(run, req);
  const rows = [["Compte", "Libellé", "Débit", "Crédit"]];
  for (const e of j.entries) rows.push([e.compte, e.libelle, e.debit || "", e.credit || ""]);
  rows.push(["", "TOTAUX", j.totalDebit, j.totalCredit]);
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "journal", format: "csv" });
  sendCSV(res, `Journal_paie_${run.period}.csv`, rows);
});


/* ============ Solde de tout compte / droits de rupture (CCN Commerce Art. 42-48) ============ */
const _solde = require("../payroll/soldeToutCompte");
router.get("/rupture/motifs", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => res.json(_solde.MOTIFS));
router.post("/solde/:eid", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Salarié introuvable" });
  const b = req.body || {};
  const cfg = configOf(req);
  const c = emp.contract || {};
  const endDate = b.endDate || c.endDate || new Date().toISOString().slice(0, 10);
  const period = String(endDate).slice(0, 7);
  const salaireCategoriel = Number(b.salaireCategoriel) > 0 ? Number(b.salaireCategoriel) : baseSalaryOf(emp, req);
  const years = Number(b.seniorityYears) >= 0 && b.seniorityYears !== undefined ? Number(b.seniorityYears) : seniorityYearsFrac(emp, endDate);
  const sr = seniorityRate(Math.floor(years), cfg);
  const primeAnciennete = Number(b.primeAnciennete) >= 0 && b.primeAnciennete !== "" && b.primeAnciennete !== undefined ? Number(b.primeAnciennete) : Math.round(salaireCategoriel * sr);
  let leaveDays = Number(b.leaveDays);
  if (!(leaveDays >= 0)) { try { leaveDays = require("./hr").leaveBalance(emp).remaining; } catch (e) { leaveDays = 0; } }
  const dailyRate = Number(b.dailyRate) > 0 ? Number(b.dailyRate) : Math.round(salaireCategoriel / (cfg.standardMonthlyDays || 30));
  const out = _solde.computeSolde({
    motif: b.motif || c.departureReason || "licenciement",
    category: c.category || "", seniorityYears: years,
    salaireCategoriel, primeAnciennete, sursalaire: Number(b.sursalaire) || 0,
    monthlyRef: Number(b.monthlyRef) || 0, leaveDays: leaveDays || 0, dailyRate,
    preavisRespecte: b.preavisRespecte !== false,
  }, cfg);
  out.employee = { id: emp.id, name: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(), matricule: emp.matricule || "", category: c.category || "" };
  out.endDate = endDate; out.period = period;
  audit(req.user, "SOLDE_TOUT_COMPTE", "Employee", emp.id, { motif: out.motif, total: out.total });
  res.json(out);
});

/* ==================== ÉTATS SUR PÉRIODE (fiche, livre, cotisations) ====================
 * Période flexible from=YYYY-MM..to=YYYY-MM (un mois, plusieurs mois, à cheval sur des
 * années), filtre par portefeuille et/ou salarié, export json|csv|xlsx|pdf. */
function _monthsBetween(from, to) {
  const out = []; if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return out;
  let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard < 600) { out.push(`${y}-${String(m).padStart(2,"0")}`); m++; if (m > 12) { m = 1; y++; } guard++; }
  return out;
}
function _pfNameMap(req) { const map = {}; mine(db.portfolios, req).forEach(p => map[p.id] = p.name); return map; }
function _rangeSlips(req, q) {
  const from = q.from || q.to || new Date().toISOString().slice(0,7);
  const to = q.to || q.from || from;
  const lo = from < to ? from : to, hi = from < to ? to : from;
  const empById = {}; mine(db.employees, req).forEach(e => empById[e.id] = e);
  let slips = mine(db.payslips, req).filter(s => { const p = String(s.period||"").slice(0,7); return p >= lo && p <= hi; });
  if (q.employeeId) slips = slips.filter(s => s.employeeId === q.employeeId);
  if (q.portfolioId) slips = slips.filter(s => { const e = empById[s.employeeId]; return e && e.portfolioId === q.portfolioId; });
  if (q.q) { const t = String(q.q).toLowerCase(); slips = slips.filter(s => `${s.employeeName||""} ${s.matricule||""}`.toLowerCase().includes(t)); }
  return { slips, lo, hi, empById };
}
function _sendReport(req, res, { format, name, title, columns, rows, meta }) {
  const money = (v) => String(Math.round(v||0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  format = String(format||"json").toLowerCase();
  if (format === "csv") {
    const head = columns.map(c => '"'+String(c.label).replace(/"/g,'""')+'"').join(";");
    const body = rows.map(r => columns.map(c => { const v = r[c.key]; return c.money ? (v==null?"":Math.round(v)) : '"'+String(v==null?"":v).replace(/"/g,'""')+'"'; }).join(";")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
    return res.send("\ufeff" + head + "\n" + body);
  }
  if (format === "xlsx") {
    let XLSX; try { XLSX = require("xlsx"); } catch(e){ return res.status(500).json({ error: "Module Excel indisponible" }); }
    const aoa = [columns.map(c => c.label), ...rows.map(r => columns.map(c => r[c.key]==null?"":r[c.key]))];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Etat");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
    return res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  }
  if (format === "pdf") {
    const doc = new PDFDocument({ margin: 24, size: "A4", layout: "landscape", bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.pdf"`);
    doc.pipe(res);
    const pw = doc.page.width, x0 = 24, usable = pw - 48;
    doc.font("Helvetica-Bold").fontSize(13).text(title, x0, 24);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(meta||"", x0, 42); doc.fillColor("#000");
    const tw = columns.reduce((a,c)=>a+(c.w||70),0); const sc = usable/tw; columns.forEach(c=>c._w=(c.w||70)*sc);
    let y = 64; const xs=[]; { let x=x0; columns.forEach(c=>{ xs.push(x); x+=c._w; }); }
    const drawHead = () => { doc.rect(x0,y,usable,16).fillAndStroke("#E5E7EB","#9ca3af"); doc.fillColor("#000").font("Helvetica-Bold").fontSize(7.5);
      columns.forEach((c,i)=>doc.text(c.label, xs[i]+2, y+4, { width:c._w-4, align:c.money?"right":"left", lineBreak:false })); y+=16; };
    drawHead();
    doc.font("Helvetica").fontSize(7.5);
    for (const r of rows) { if (y>520){ doc.addPage({margin:24,size:"A4",layout:"landscape"}); y=30; drawHead(); doc.font("Helvetica").fontSize(7.5); }
      columns.forEach((c,i)=>{ const v=r[c.key]; doc.text(c.money?money(v):String(v==null?"":v), xs[i]+2, y+3, { width:c._w-4, align:c.money?"right":"left", lineBreak:false }); });
      doc.strokeColor("#e5e7eb").lineWidth(0.3).moveTo(x0,y+11).lineTo(x0+usable,y+11).stroke(); y+=12; }
    doc.end(); return;
  }
  return res.json({ columns, rows, meta, title });
}

router.get("/reports/livre", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.livre")) return res.status(403).json({ error: "Livre de paie non autorisé" });
  const { slips, lo, hi, empById } = _rangeSlips(req, req.query);
  const pfn = _pfNameMap(req);
  const rows = slips.map(s => { const t = s.result.totals; const e = empById[s.employeeId]||{};
    return { periode: s.period, matricule: s.matricule||"", nom: s.employeeName||"", portefeuille: pfn[e.portfolioId]||"",
      brut: t.brutTotal, retenues: t.totalRetenues, cnps: t.cnpsSalarie, irpp: t.irpp, net: t.netAPayer, patronal: t.chargesPatronales, cout: t.coutTotalEmployeur }; })
    .sort((a,b)=> a.periode.localeCompare(b.periode) || a.nom.localeCompare(b.nom));
  const columns = [ {key:"periode",label:"Période",w:52},{key:"matricule",label:"Matricule",w:60},{key:"nom",label:"Salarié",w:120},{key:"portefeuille",label:"Portefeuille",w:90},
    {key:"brut",label:"Brut",money:1,w:66},{key:"retenues",label:"Retenues",money:1,w:60},{key:"cnps",label:"CNPS",money:1,w:52},{key:"irpp",label:"IRPP",money:1,w:52},
    {key:"net",label:"Net à payer",money:1,w:66},{key:"patronal",label:"Ch. patron.",money:1,w:60},{key:"cout",label:"Coût employeur",money:1,w:72} ];
  _sendReport(req, res, { format: req.query.format, name: `Livre_de_paie_${lo}_${hi}`, title: `Livre de paie - ${lo} à ${hi}`, meta: `${rows.length} bulletin(s)`, columns, rows });
});

router.get("/reports/cotisations", allow("RP", "ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.cotisations")) return res.status(403).json({ error: "États des cotisations non autorisé" });
  const { slips, lo, hi } = _rangeSlips(req, req.query);
  const agg = {};
  for (const s of slips) for (const l of s.result.lines) { if (l.kind !== "COTIS" && l.kind !== "IMPOT") continue;
    const a = agg[l.code] || (agg[l.code] = { code: l.code, libelle: l.label, base: 0, salarie: 0, patronal: 0 });
    a.base += l.base||0; a.salarie += l.retenue||0; a.patronal += l.employer||0; }
  const rows = Object.values(agg).map(a=>({ ...a, total: a.salarie + a.patronal })).sort((a,b)=>String(a.code).localeCompare(String(b.code)));
  const columns = [ {key:"code",label:"Code",w:44},{key:"libelle",label:"Cotisation / impôt",w:150},{key:"base",label:"Base cumulée",money:1,w:80},
    {key:"salarie",label:"Part salariale",money:1,w:80},{key:"patronal",label:"Part patronale",money:1,w:80},{key:"total",label:"Total",money:1,w:80} ];
  _sendReport(req, res, { format: req.query.format, name: `Etat_cotisations_${lo}_${hi}`, title: `État des cotisations - ${lo} à ${hi}`, meta: `${slips.length} bulletin(s)`, columns, rows });
});

router.get("/reports/fiche", allow("RP", "ADM", "CD", "RJ", "GPF"), (req, res) => {
  const eid = req.query.employeeId; if (!eid) return res.status(400).json({ error: "employeeId requis" });
  const { slips, lo, hi, empById } = _rangeSlips(req, Object.assign({}, req.query, { employeeId: eid }));
  const e = empById[eid] || {}; const pfn = _pfNameMap(req);
  if (String(req.query.format || "").toLowerCase() === "pdf") return _ficheSagePDF(req, res, { emp: e, slips, lo, hi });
  const rows = slips.map(s => { const t = s.result.totals; return { periode: s.period, brut: t.brutTotal, netImposable: t.netImposable,
      retenues: t.totalRetenues, net: t.netAPayer, patronal: t.chargesPatronales, cout: t.coutTotalEmployeur }; })
    .sort((a,b)=>a.periode.localeCompare(b.periode));
  const columns = [ {key:"periode",label:"Période",w:60},{key:"brut",label:"Brut",money:1,w:80},{key:"netImposable",label:"Net imposable",money:1,w:90},
    {key:"retenues",label:"Retenues",money:1,w:80},{key:"net",label:"Net à payer",money:1,w:90},{key:"patronal",label:"Ch. patronales",money:1,w:90},{key:"cout",label:"Coût employeur",money:1,w:90} ];
  const nm = `${e.firstName||""} ${e.lastName||""}`.trim();
  _sendReport(req, res, { format: req.query.format, name: `Fiche_${(e.matricule||nm||eid)}_${lo}_${hi}`, title: `Fiche individuelle - ${nm} (${e.matricule||""})`, meta: `${pfn[e.portfolioId]||""} - ${lo} à ${hi}`, columns, rows });
});


/* ==================== Fiche individuelle façon Sage (rubriques x mois + Total) ==================== */
const _MOISFR = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
function _moisLabel(p){ const a=String(p||"").split("-"); const m=Number(a[1])||1; return _MOISFR[m-1]+" "+String(a[0]||"").slice(2); }
function _ficheSagePDF(req, res, opts){
  const emp = opts.emp||{}, slips=(opts.slips||[]).slice().sort((a,b)=>String(a.period).localeCompare(String(b.period)));
  const tenant = (db.tenants||[]).find(t=>t.id===(req.user.tenantId||"t1"))||{name:"Société"};
  const app = "MBOKA Mon RH";
  // union des rubriques
  const gainCodes=[], cotisCodes=[], gLbl={}, cLbl={}, gAdv={};
  for(const s of slips) for(const l of (s.result.lines||[])){
    if(l.kind==="GAIN"||l.kind==="AVANTAGE"){ if(!(l.code in gLbl)){ gLbl[l.code]=l.label; gainCodes.push(l.code); gAdv[l.code]=(l.kind==="AVANTAGE"); } }
    else if((l.kind==="COTIS"||l.kind==="IMPOT")&&(l.retenue||0)>0){ if(!(l.code in cLbl)){ cLbl[l.code]=l.label; cotisCodes.push(l.code); } }
  }
  gainCodes.sort(); cotisCodes.sort();
  const gainOf=(s,c)=>{const l=(s.result.lines||[]).find(x=>x.code===c&&(x.kind==="GAIN"||x.kind==="AVANTAGE"));return l?Math.round(l.gain||0):0;};
  const cotisOf=(s,c)=>{const l=(s.result.lines||[]).find(x=>x.code===c&&(x.kind==="COTIS"||x.kind==="IMPOT"));return l?Math.round(l.retenue||0):0;};
  const T=(s)=>s.result.totals||{}; const Mmeta=(s)=>s.result.meta||{};
  const brutOf=(s)=>Math.round(T(s).brutTotal||0), cotOf=(s)=>Math.round((T(s).cnpsSalarie||0)+(T(s).totalImpots||0));
  const SUM=[
    ["Présence",(s)=>((Mmeta(s).workedDays!=null)?Mmeta(s).workedDays:30),false],
    ["Brut",(s)=>brutOf(s),true],
    ["Cotisations salariales",(s)=>cotOf(s),true],
    ["Cotisations patronales",(s)=>Math.round(T(s).chargesPatronales||0),true],
    ["Net à payer",(s)=>Math.round(T(s).netAPayer||0),true],
    ["Net imposable",(s)=>Math.round(T(s).netImposable||0),true],
    ["Avantages en nature",(s)=>Math.round(T(s).avantagesNature||0),true],
    ["Total des heures travaillées",(s)=>((Mmeta(s).workedDays!=null)?Mmeta(s).workedDays:30),false],
    ["Total des heures d'absence",(s)=>Math.round(Mmeta(s).absenceDays||0),false],
    ["Absence",(s)=>Math.round(Mmeta(s).absenceDays||0),false],
    ["Coût total",(s)=>Math.round(T(s).coutTotalEmployeur||0),true],
  ];
  const doc=new PDFDocument({margin:20,size:"A4",layout:"portrait",bufferPages:true});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="${("Fiche_"+(emp.matricule||emp.id||"")).replace(/[^\w\-]/g,"_")}.pdf"`);
  doc.pipe(res);
  const now=new Date(), dstr=now.toLocaleDateString("fr-FR"), tstr=now.toLocaleTimeString("fr-FR");
  const mL=20, cW=555;
  const salarie = (emp.matricule||"")+"   "+(emp.civility||"M")+"   "+String(((emp.lastName||"")+" "+(emp.firstName||"")).trim().toUpperCase());
  const fmtDate=(p)=>{ const a=String(p||"").split("-"); return a.length>=2?("01/"+a[1]+"/"+String(a[0]).slice(2)):p; };
  const from=slips.length?fmtDate(slips[0].period):opts.lo, to=slips.length?fmtDate(slips[slips.length-1].period):opts.hi;
  function header(pageNum,totalPages){
    let y=20;
    doc.save(); doc.rect(mL,y,cW,58).fill("#d7e6cf"); doc.restore();
    doc.lineWidth(0.8).strokeColor("#000").rect(mL,y,cW,58).stroke();
    doc.fillColor("#000").font("Helvetica").fontSize(7.5);
    doc.text("Date du jour  :  "+dstr, mL+6, y+7,{lineBreak:false});
    doc.text("Heure           :  "+tstr, mL+6, y+20,{lineBreak:false});
    doc.text("Edition en    :  Francs", mL+6, y+42,{lineBreak:false});
    doc.font("Helvetica-Bold").fontSize(16).text("Fiche  individuelle", mL, y+8,{width:cW,align:"center"});
    doc.font("Helvetica").fontSize(8.5).text("Période  du "+from+"  au "+to, mL, y+30,{width:cW,align:"center"});
    doc.fontSize(7.5).text("Page :   "+pageNum, mL, y+7,{width:cW-6,align:"right"});
    y+=58;
    doc.rect(mL,y,cW,15).stroke(); doc.font("Helvetica").fontSize(8);
    doc.text("Société  :  "+esc0(tenant.name), mL+6, y+4,{lineBreak:false});
    doc.text("© "+app+"     V 1.0", mL, y+4,{width:cW-6,align:"right"});
    y+=15;
    doc.rect(mL,y,cW,15).stroke();
    doc.font("Helvetica").fontSize(8).text("Salarié :   "+salarie, mL+6, y+4,{lineBreak:false});
    y+=15+6;
    return y;
  }
  function esc0(s){return String(s==null?"":s);}
  // colonnes: label + mois (6) + total
  const codeW=26, labelW=124, monW=59, totW=cW-(codeW+labelW)-6*monW; // ~59
  // pagination par blocs de 6 mois
  const blocks=[]; for(let i=0;i<slips.length;i+=6) blocks.push(slips.slice(i,i+6));
  if(!blocks.length) blocks.push([]);
  blocks.forEach((blk,bi)=>{
    if(bi>0) doc.addPage({margin:20,size:"A4",layout:"portrait"});
    let y=header(bi+1,blocks.length);
    const cols=blk; const nC=cols.length;
    const xLabel=mL, xCode=mL, xFirst=mL+codeW+labelW; const xTot=xFirst+nC*monW;
    const rowH=10.6;
    const NF=_NF;
    function line(yy){ doc.lineWidth(0.3).strokeColor("#c9c9c9").moveTo(mL,yy).lineTo(mL+cW,yy).stroke(); }
    function colHeader(){
      doc.rect(mL,y,cW,14).fillAndStroke("#eef2ea","#000"); doc.fillColor("#000").font("Helvetica-Bold").fontSize(7.5);
      doc.text("Rubriques", xCode+3, y+3.5,{width:codeW+labelW-6,lineBreak:false});
      cols.forEach((s,i)=>doc.text(_moisLabel(s.period), xFirst+i*monW, y+3.5,{width:monW-3,align:"right",lineBreak:false}));
      doc.text("Total", xTot, y+3.5,{width:totW-3,align:"right",lineBreak:false});
      y+=14;
    }
    colHeader();
    function drawRow(code,label,vals,o){ o=o||{};
      if(o.fill){ doc.rect(mL,y,cW,rowH).fill(o.fill); }
      doc.fillColor("#000").font(o.bold?"Helvetica-Bold":"Helvetica").fontSize(o.bold?7:6.8);
      if(o.star) doc.text("*", mL+1, y+2.4,{width:8,lineBreak:false});
      if(code) doc.text(code, xCode+9, y+2.4,{width:codeW-6,lineBreak:false});
      doc.text(label, xCode+codeW, y+2.4,{width:labelW-4,lineBreak:false});
      let tot=0;
      cols.forEach((s,i)=>{ const v=vals(s); if(o.money!==false) tot+=v; else tot+=v; doc.text(v?( o.money===false?String(v):NF(v)):"", xFirst+i*monW, y+2.4,{width:monW-3,align:"right",lineBreak:false}); });
      doc.text(tot?(o.money===false?String(tot):NF(tot)):"", xTot, y+2.4,{width:totW-3,align:"right",lineBreak:false});
      line(y+rowH); y+=rowH;
    }
    // gains
    for(const c of gainCodes) drawRow(c, gLbl[c]||"", (s)=>gainOf(s,c), {star:gAdv[c]});
    drawRow("", "Total Brut", (s)=>brutOf(s), {bold:true, fill:"#f5f0b0"});
    for(const c of cotisCodes) drawRow(c, cLbl[c]||"", (s)=>cotisOf(s,c), {});
    drawRow("", "Total Cotisation", (s)=>cotOf(s), {bold:true, fill:"#f5f0b0"});
    y+=3;
    for(const r of SUM) drawRow("", r[0], r[1], { money:r[2] });
    // cadre extérieur
    doc.lineWidth(0.6).strokeColor("#000");
    // verticals
    const vx=[xFirst]; for(let i=1;i<=nC;i++) vx.push(xFirst+i*monW); vx.push(xTot+totW);
  });
  // page numbers already in header; also add totalPages fix
  const range=doc.bufferedPageRange();
  doc.end();
}

module.exports = router;

module.exports.payslipSig = payslipSig;
module.exports.payslipBuffer = payslipBuffer;
