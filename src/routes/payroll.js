/**
 * SGRHP — Payroll module routes (Module Paie)
 * Config (rubriques, caisses/config, bulletins modèles) + monthly runs, variable
 * elements, batch calculation, payslips (view + PDF), livre de paie, états des
 * cotisations, and period close with cumuls.  Cameroon rules via ../payroll/engine.
 */
const router = require("express").Router();
const PDFDocument = require("pdfkit");
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const { computePayslip } = require("../payroll/engine");

/* Ensure collections exist (defensive for older stores). */
for (const k of ["payrollConfig", "payRubriques", "bulletinModels", "payRuns", "payslips", "payElements", "payCumuls", "payLoans"])
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
  if (req.user.role === "ADM") return true;
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

function periodDiff(from, to) { // whole months between "YYYY-MM" strings
  if (!from || !to) return -1;
  const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}
function configOf(req) {
  let c = mine(db.payrollConfig, req)[0];
  if (!c) { c = stamp({ id: id("pcfg"), ...require("../payroll/engine").DEFAULT_CONFIG }, req); db.payrollConfig.push(c); save(); }
  return c;
}
function baseSalaryOf(emp, req) {
  if (emp.salary && Number(emp.salary.base) > 0) return Number(emp.salary.base);
  const cat = emp.contract && emp.contract.category;
  const g = mine(db.salaryGrid, req).find(x => x.category === cat);
  return g ? Number(g.baseSalary) : 0;
}
function seniorityYears(emp, period) {
  const hire = emp.hireDate || (emp.contract && emp.contract.startDate);
  if (!hire) return 0;
  const end = period ? new Date(period + "-01") : new Date();
  const y = (end - new Date(hire)) / (365.25 * 24 * 3600 * 1000);
  return Math.max(0, Math.floor(y));
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
    if (code === "1000" || el.tag === "salary_base") { baseSalary = amount; continue; }
    if (el.tag === "allowance_transport") { transport = { code: code || "3513", label: (rub && rub.label) || el.name, amount }; continue; }
    gains.push({ code: code || "2000", label: (rub && rub.label) || el.name, amount,
      cnps: rub ? !!rub.cnps : true, impo: rub ? !!rub.impo : true });
  }
  if (!baseSalary) baseSalary = baseSalaryOf(emp, req); // fallback to the salary grid
  return { baseSalary, gains, transport };
}

function elementsToInput(emp, period, req) {
  // 1) recurring structure from the HR dossier
  const struct = structureToInput(emp, req);
  const gains = [...struct.gains], nonTaxable = [], otherDeductions = [], avantages = [];
  const overtime = { tier1: 0, tier2: 0, tier3: 0, night: 0, sundayHoliday: 0 };
  let absenceDays = 0;
  // 2) variable elements entered for this period (on top of the structure)
  const els = mine(db.payElements, req).filter(e => e.employeeId === emp.id && e.period === period);
  for (const e of els) {
    switch (e.type) {
      case "PRIME": gains.push({ code: e.code, label: e.label, amount: Number(e.amount) }); break;
      case "INDEMNITE": nonTaxable.push({ code: e.code, label: e.label, amount: Number(e.amount) }); break;
      case "ACOMPTE": otherDeductions.push({ code: "7000", label: e.label || "Acompte sur salaire", amount: Number(e.amount) }); break;
      case "PRET": otherDeductions.push({ code: "7010", label: e.label || "Remboursement de prêt", amount: Number(e.amount) }); break;
      case "HS20": overtime.tier1 += Number(e.hours || 0); break;
      case "HS30": overtime.tier2 += Number(e.hours || 0); break;
      case "HS40": overtime.tier3 += Number(e.hours || 0); break;
      case "NUIT": overtime.night += Number(e.hours || 0); break;
      case "ABSENCE": absenceDays += Number(e.days || 0); break;
      case "AVANTAGE": avantages.push({ code: e.code || "4000", label: e.label || "Avantage en nature", amount: Number(e.amount), cnps: !!e.cnps, impo: e.impo !== false }); break;
      case "TREIZE": gains.push({ code: "2514", label: e.label || "13e mois", amount: Number(e.amount) || Math.round(struct.baseSalary) }); break;
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
  const cfg = configOf(req);
  const joursEl = els.find(e => e.type === "JOURS");
  const stdDays = cfg.standardMonthlyDays || 30;
  const workedDays = joursEl != null ? Math.max(0, Number(joursEl.days))
    : Math.max(0, stdDays - absenceDays);
  return {
    baseSalary: struct.baseSalary,
    workedDays, standardDays: cfg.standardMonthlyDays || 30,
    seniorityYears: seniorityYears(emp, period),
    overtime, gains, nonTaxable, avantages, transport: struct.transport, otherDeductions,
    tdlBase: struct.baseSalary,
  };
}
function computeFor(emp, period, req) {
  const cfg = configOf(req);
  const input = elementsToInput(emp, period, req);
  const result = computePayslip(input, cfg);
  return { input, result };
}

/* ============================ CONFIG ============================ */
router.get("/config", allow("ADM", "CD", "RJ"), (req, res) => res.json(configOf(req)));

router.put("/config", allow("ADM"), (req, res) => {
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

router.get("/rubriques", allow("ADM", "CD", "RJ", "GPF"), (req, res) =>
  res.json(mine(db.payRubriques, req).map(r => ({ ...r, inUse: rubriqueInUse(r, req) }))));

router.post("/rubriques", allow("ADM"), (req, res) => {
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

router.put("/rubriques/:id", allow("ADM"), (req, res) => {
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

router.delete("/rubriques/:id", allow("ADM"), (req, res) => {
  const r = mine(db.payRubriques, req).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Introuvable" });
  if (rubriqueInUse(r, req) && !(req.query.force === "1"))
    return res.status(409).json({ error: "Rubrique utilisée dans des bulletins calculés — suppression bloquée",
      requiresConfirmation: true,
      warning: `« ${r.code} ${r.label} » est utilisée dans la paie. La supprimer peut casser des recalculs. Confirmez pour supprimer.` });
  db.payRubriques.splice(db.payRubriques.indexOf(r), 1); save();
  audit(req.user, "DELETED", "PayRubrique", r.id, { code: r.code });
  res.json({ ok: true });
});

/* Bulletins modèles */
router.get("/models", allow("ADM", "CD", "RJ", "GPF"), (req, res) => res.json(mine(db.bulletinModels, req)));
router.post("/models", allow("ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.label) return res.status(400).json({ error: "code et libellé obligatoires" });
  const m = stamp({ id: id("bmod"), code: b.code, label: b.label, type: b.type || "Mensuel",
    monthlyHours: Number(b.monthlyHours) || 173.33, lines: b.lines || [] }, req);
  db.bulletinModels.push(m); save();
  res.status(201).json(m);
});
router.put("/models/:id", allow("ADM"), (req, res) => {
  const m = mine(db.bulletinModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Introuvable" });
  Object.assign(m, req.body || {}, { id: m.id, tenantId: m.tenantId }); save();
  res.json(m);
});

/* ======================= VARIABLE ELEMENTS ===================== */
router.get("/elements", allow("ADM", "GPF", "CD", "RJ"), (req, res) => {
  const { period, employeeId } = req.query;
  let list = mine(db.payElements, req);
  if (period) list = list.filter(e => e.period === period);
  if (employeeId) list = list.filter(e => e.employeeId === employeeId);
  res.json(list);
});
router.post("/elements", allow("ADM", "GPF"), (req, res) => {
  const b = req.body || {};
  if (!b.employeeId || !b.period || !b.type) return res.status(400).json({ error: "employeeId, period, type obligatoires" });
  if (runLocked(b.period, req)) return res.status(409).json({ error: "Période clôturée — saisie impossible" });
  const e = stamp({ id: id("pel"), employeeId: b.employeeId, period: b.period, type: b.type,
    code: b.code || b.type, label: b.label || b.type, amount: b.amount ? Number(b.amount) : undefined,
    hours: b.hours ? Number(b.hours) : undefined, days: b.days ? Number(b.days) : undefined,
    createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.payElements.push(e); save();
  audit(req.user, "CREATED", "PayElement", e.id, { period: e.period, type: e.type, employeeId: e.employeeId });
  res.status(201).json(e);
});
router.delete("/elements/:id", allow("ADM", "GPF"), (req, res) => {
  const el = mine(db.payElements, req).find(x => x.id === req.params.id);
  if (!el) return res.status(404).json({ error: "Introuvable" });
  if (runLocked(el.period, req)) return res.status(409).json({ error: "Période clôturée" });
  db.payElements.splice(db.payElements.indexOf(el), 1); save();
  res.json({ ok: true });
});

function runLocked(period, req) {
  return mine(db.payRuns, req).some(r => r.period === period && r.status === "CLOSED");
}

/* ============================ RUNS ============================= */
router.get("/runs", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  res.json(mine(db.payRuns, req).slice().sort((a, b) => (b.period || "").localeCompare(a.period || "")));
});

router.post("/runs", allow("ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
    if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisee - demandez le droit a votre administrateur" });

  const period = (req.body && req.body.period || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "Période attendue au format YYYY-MM" });
  if (mine(db.payRuns, req).some(r => r.period === period))
    return res.status(409).json({ error: "Une paie existe déjà pour cette période" });
  const run = stamp({ id: id("run"), period, label: req.body.label || `Paie ${period}`, status: "OPEN",
    createdBy: req.user.id, createdAt: new Date().toISOString(), computedAt: null, closedAt: null, count: 0 }, req);
  db.payRuns.push(run); save();
  audit(req.user, "CREATED", "PayRun", run.id, { period });
  res.status(201).json(run);
});

router.get("/runs/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id).map(summary);
  res.json({ run, payslips: slips, totals: runTotals(run, req) });
});

/** Compute (or recompute) payslips for all active employees in the run's period. */
router.post("/runs/:id/compute", allow("ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
    if (!canRunPayroll(req)) return res.status(403).json({ error: "Action paie non autorisee - demandez le droit a votre administrateur" });

  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  if (run.status === "CLOSED") return res.status(409).json({ error: "Paie clôturée" });

  const emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED");
  // clear previous payslips for this run
  db.payslips = db.payslips.filter(s => !(s.runId === run.id && (s.tenantId || "t1") === (run.tenantId || "t1")));
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
  run.status = "CALCULATED"; run.computedAt = new Date().toISOString(); run.count = n;
  save();
  audit(req.user, "COMPUTED", "PayRun", run.id, { period: run.period, employees: n });
  res.json({ run, computed: n, totals: runTotals(run, req) });
});

// Per-employee roster for a run (status: PENDING / CALCULATED / CLOSED).
router.get("/runs/:id/roster", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const byEmp = {}; mine(db.payslips, req).filter(s => s.runId === run.id).forEach(s => { byEmp[s.employeeId] = s; });
  const roster = mine(db.employees, req)
    .filter(e => (e.status || "").toUpperCase() !== "ARCHIVED")
    .map(e => { const s = byEmp[e.id]; return {
      employeeId: e.id, name: `${e.firstName} ${e.lastName}`, matricule: e.matricule || e.id.slice(-6),
      portfolioId: e.portfolioId, category: (e.contract && e.contract.category) || "",
      hasBase: baseSalaryOf(e, req) > 0, status: s ? s.status : "PENDING",
      net: s ? s.result.totals.netAPayer : null, brut: s ? s.result.totals.brutTotal : null,
      payslipId: s ? s.id : null, edited: s ? !!s.edited : false };
    });
  res.json({ run, roster, totals: runTotals(run, req) });
});

// Compute (or recompute) ONE employee's bulletin.
router.post("/runs/:id/employees/:eid/compute", allow("ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
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
router.post("/simulate/:eid", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employe introuvable" });
  if (!baseSalaryOf(emp, req)) return res.status(422).json({ error: "Salaire de base introuvable" });
  const period = (req.body && req.body.period) || new Date().toISOString().slice(0, 7);
  const { input, result } = computeFor(emp, period, req);
  res.json({ employeeId: emp.id, employeeName: `${emp.firstName} ${emp.lastName}`, matricule: emp.matricule || "", period, input, result, simulation: true });
});

/** Close the period: lock payslips and roll year-to-date cumuls. */
router.post("/runs/:id/close", allow("ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
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

router.get("/payslips/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Bulletin introuvable" });
  res.json(s);
});

/* PDF bulletin de paie */
router.get("/payslips/:id/pdf", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Bulletin introuvable" });
  const emp = mine(db.employees, req).find(e => e.id === s.employeeId) || {};
  const tenant = (db.tenants || []).find(t => t.id === (s.tenantId || "t1")) || { name: "SGRHP" };
  audit(req.user, req.query.print === "1" ? "PRINTED" : "DOWNLOADED", "Payslip", s.id, { employeeId: s.employeeId, period: s.period });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Bulletin_${(s.employeeName||"").replace(/[^\w]/g,"_")}_${s.period}.pdf"`);
  const doc = new PDFDocument({ margin: 18, size: "A4" });
  doc.pipe(res);
  const t = s.result.totals, r = s.result;
  const F = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const F2 = (n) => { const v = Math.round((n || 0) * 100) / 100; const [i, d] = v.toFixed(2).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + d; };
  const N3 = (n) => Number(n).toFixed(3).replace(/\B(?=(\d{3})+(?!\d))\./, "$&").replace(/(\d)(?=(\d{3})+,)/g, "$1").replace(".", ",");
  const C = emp.contract || {};
  const yrs = (() => { const h = emp.hireDate ? new Date(emp.hireDate) : null; if (!h) return "";
    const d = new Date(s.period + "-01"); let m = (d.getFullYear()-h.getFullYear())*12 + (d.getMonth()-h.getMonth());
    if (m < 0) m = 0; return `${Math.floor(m/12)} an(s) et ${m%12} mois`; })();
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
  T(26, 26, tenant.name || "SOCIÉTÉ", { b: 1, s: 12 });
  T(310, 20, "BULLETIN  DE  PAIE", { b: 1, s: 21, w: 270, a: "center" });
  T(360, 58, "Période du", { b: 1 }); T(415, 58, dS, { b: 1 }); T(470, 58, "au", { b: 1 }); T(490, 58, dE, { b: 1 });
  T(360, 70, "Paiement le", { b: 1 }); T(415, 70, dE); T(470, 70, "par", { b: 1 }); T(490, 70, C.paymentMethod || "Virement");
  T(318, 86, "Banque", { b: 1 }); T(360, 86, emp.bankName || C.bankName || ""); T(430, 86, "N° Compte", { b: 1 }); T(480, 86, emp.bankAccount || C.bankIban || "");
  // labels inside company box
  T(26, 88, "N° Contribuable", { b: 1 }); T(110, 88, tenant.niu || "");
  T(190, 88, "N° Employeur", { b: 1 }); T(255, 88, tenant.cnpsEmployer || "");
  // employee box (right)
  BX(310, 98, 267, 60);
  T(318, 104, "Matricule", { b: 1 }); T(375, 104, s.matricule || "");
  T(320, 128, `${emp.civility || ""}  ${(emp.firstName||"")} ${(emp.lastName||"")}`.trim(), { b: 1, s: 10, w: 250 });
  // left info block
  let iy = 168; const li = (l, v, l2, v2) => {
    T(26, iy, l, { b: 1 }); T(120, iy, v); if (l2) { T(300, iy, l2, { b: 1 }); T(380, iy, v2); } iy += 12; };
  li("Conv. coll.", C.convention || emp.convention || "", "Emploi", C.position || emp.position || "");
  li("N° CNPS", emp.cnpsNumber || "", "Sit Fam", emp.maritalStatus || "");
  li("Date Embauche", emp.hireDate || "", "Nbre Enfants", emp.children != null ? emp.children : "");
  li("Ancienneté", yrs, "Qualification", emp.qualification || "");
  li("N° DIPE", emp.dipe || tenant.dipe || "", "Département", emp.department || "");
  li("Catégorie", C.category || "", "Jour/Mois", "30,00");

  /* ===== MAIN TABLE ===== */
  const X = { n: 18, des: 52, nb: 232, base: 288, txs: 348, gain: 392, rets: 452, txp: 508, retp: 540, end: 577 };
  let TY = 250;                    // table top
  const hEnd = 636;                // table bottom (fixed height)
  // header (2 rows)
  BX(X.n, TY, X.end - X.n, 22);
  VL(X.des, TY, hEnd); VL(X.nb, TY, hEnd); VL(X.base, TY, hEnd);
  VL(X.txs, TY, hEnd); VL(X.gain, TY, hEnd); VL(X.rets, TY, hEnd); VL(X.txp, TY, hEnd); VL(X.retp, TY, hEnd);
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
  const dlbl = (l) => (SLBL[l.code] || l.label || "").toUpperCase();
  let y = TY + 24;
  const cell = (x, xe, v, al) => { if (v || v === 0) T(x + 1, y, v, { s: 7.5, w: xe - x - 2, a: al || "right" }); };
  const gains = r.lines.filter(l => l.kind === "GAIN" || l.kind === "AVANTAGE");
  for (const l of gains) {
    if (!l.gain) continue;
    T(X.n + 1, y, l.code, { s: 7.5, w: X.des - X.n - 2, a: "center" });
    T(X.des + 2, y, dlbl(l), { s: 7.5, w: X.nb - X.des - 4 });
    if (l.nombre) cell(X.nb, X.base, Number(l.nombre).toFixed(3).replace(/\B(?=(\d{3})+(?!\d))(?=\d*\.)/g, " ").replace(".", ","));
    if (l.base) cell(X.base, X.txs, F2(l.base));
    cell(X.gain, X.rets, F(l.gain));
    y += 12;
  }
  y += 3; T(X.des, y, "Total Brut", { b: 1, s: 8, w: X.nb - X.des, a: "center" }); cell(X.gain, X.rets, F(t.brutTotal)); doc.font("Helvetica-Bold"); y += 14; doc.font("Helvetica");
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
  y += 3; T(X.des, y, "Total Cotisations", { b: 1, s: 8, w: X.nb - X.des, a: "center" });
  cell(X.rets, X.txp, F((t.cnpsSalarie||0) + (t.totalImpots||0))); cell(X.retp, X.end, F((t.cnpsPatronal||0) + (t.cfcPatronal||0)));

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
  band("Période", by + 13, [F(t.brutTotal), F((t.cnpsSalarie||0)+(t.totalImpots||0)), F((t.cnpsPatronal||0)+(t.cfcPatronal||0)), F(t.avantagesNature||0), F(t.netImposable), (r.meta&&r.meta.workedDays)||30, 0]);
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

  /* ===== FOOTER ===== */
  T(18, 812, "Pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée. Tout paiement indu doit être immédiatement signalé et retourné en caisse.", { s: 6, w: 500 });
  T(520, 812, "TAKE CARE", { b: 1, s: 7 });
  doc.end();
});

/* ===================== LIVRE DE PAIE ========================== */
router.get("/runs/:id/livre", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  if (!hasPayPerm(req, "payroll.livre")) return res.status(403).json({ error: "Livre de paie non autorise - demandez le droit a votre administrateur" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  res.json({ run, rows: slips.map(summary), totals: runTotals(run, req) });
});

/* ================= ÉTATS DES COTISATIONS ===================== */
router.get("/runs/:id/cotisations", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
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
router.put("/payslips/:id/lines", allow("ADM", "GPF", "CD", "RJ", "UI"), (req, res) => {
  if (req.user.role !== "ADM") {
    const _u = db.users.find(x => x.id === req.user.id);
    if (!(((_u && _u.permissions) || []).includes("payroll.edit")))
      return res.status(403).json({ error: "Correction de paie non autorisée — demandez le droit à l'administrateur" });
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
      .map(l => ({ code: String(l.code), label: String(l.label || l.code), kind: l.kind || "GAIN",
        base: Number(l.base) || 0, rate: Number(l.rate) || 0,
        gain: Math.round(Number(l.gain) || 0), retenue: Math.round(Number(l.retenue) || 0),
        employer: Math.round(Number(l.employer) || 0), employerRate: Number(l.employerRate) || 0,
        cnps: !!l.cnps, impo: !!l.impo, manual: true }));
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
router.get("/runs/:id/livre/export", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
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
router.get("/runs/:id/cotisations/export", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
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
// Ordre de virement — net salaries with bank details, for the bank.
router.get("/runs/:id/virement", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  if (!canRunPayroll(req)) return res.status(403).json({ error: "Non autorisé" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const rows = [["Matricule", "Bénéficiaire", "Banque", "N° Compte", "Montant net", "Devise", "Motif"]];
  for (const s2 of mine(db.payslips, req).filter(x => x.runId === run.id)) {
    const emp = mine(db.employees, req).find(e => e.id === s2.employeeId) || {};
    const c = emp.contract || {};
    rows.push([s2.matricule, s2.employeeName, emp.bankName || c.bankName || "", emp.bankAccount || c.bankIban || "", s2.result.totals.netAPayer, "XAF", `Salaire ${run.period}`]);
  }
  audit(req.user, "EXPORTED", "PayRun", run.id, { doc: "virement", format: "csv" });
  sendCSV(res, `Ordre_de_virement_${run.period}.csv`, rows);
});
// Email a payslip summary to the employee.
router.post("/payslips/:id/email", allow("ADM", "CD", "RJ", "GPF"), async (req, res) => {
  const s2 = mine(db.payslips, req).find(x => x.id === req.params.id);
  if (!s2) return res.status(404).json({ error: "Bulletin introuvable" });
  const emp = mine(db.employees, req).find(e => e.id === s2.employeeId) || {};
  if (!emp.email) return res.status(400).json({ error: "Aucune adresse email pour ce salarié" });
  const t = s2.result.totals;
  const text = `Bonjour ${s2.employeeName},\n\nVotre bulletin de paie ${s2.period} est disponible.\n` +
    `Salaire brut : ${money(t.brutTotal)} XAF\nTotal retenues : ${money(t.totalRetenues)} XAF\nNet à payer : ${money(t.netAPayer)} XAF\n\nCordialement.`;
  try {
    await require("../mailer").send(emp.email, `Bulletin de paie ${s2.period}`, text);
    s2.emailedAt = new Date().toISOString(); save();
    audit(req.user, "EMAILED", "Payslip", s2.id, { to: emp.email, period: s2.period });
    res.json({ ok: true, to: emp.email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- Prêts (loans with échéancier) ---------------- */
router.get("/loans", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const { employeeId } = req.query;
  let list = mine(db.payLoans, req);
  if (employeeId) list = list.filter(l => l.employeeId === employeeId);
  res.json(list);
});
router.post("/loans", allow("ADM", "GPF"), (req, res) => {
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
router.put("/loans/:id", allow("ADM", "GPF"), (req, res) => {
  const l = mine(db.payLoans, req).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: "Prêt introuvable" });
  if (req.body.active !== undefined) l.active = !!req.body.active;
  save(); res.json(l);
});
router.delete("/loans/:id", allow("ADM", "GPF"), (req, res) => {
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
    const pf = emp.portfolioId || "—";
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

router.get("/accounting-model", allow("ADM", "CD", "RJ"), (req, res) => res.json(accountingOf(req)));
router.put("/accounting-model", allow("ADM"), (req, res) => {
  const c = configOf(req); c.accounting = { ...ACC_DEFAULTS, ...(c.accounting || {}), ...(req.body || {}) };
  save(); audit(req.user, "CONFIG_CHANGED", "AccountingModel", c.id, { accounting: c.accounting });
  res.json(c.accounting);
});
router.get("/runs/:id/journal", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  if (!hasPayPerm(req, "payroll.compta")) return res.status(403).json({ error: "Passation comptable non autorisée" });
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  res.json({ run, ...buildJournal(run, req) });
});
router.get("/runs/:id/journal/export", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
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

module.exports = router;
