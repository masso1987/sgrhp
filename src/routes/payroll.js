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
for (const k of ["payrollConfig", "payRubriques", "bulletinModels", "payRuns", "payslips", "payElements", "payCumuls"])
  if (!db[k]) db[k] = [];

const money = (n) => (Math.round(n || 0)).toLocaleString("fr-FR");
const fmtPeriod = (p) => p; // "YYYY-MM"

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
function elementsToInput(emp, period, req) {
  const els = mine(db.payElements, req).filter(e => e.employeeId === emp.id && e.period === period);
  const gains = [], nonTaxable = [], otherDeductions = [];
  const overtime = { tier1: 0, tier2: 0, tier3: 0, night: 0, sundayHoliday: 0 };
  let absenceDays = 0;
  for (const e of els) {
    switch (e.type) {
      case "PRIME": gains.push({ code: e.code, label: e.label, amount: Number(e.amount) }); break;
      case "INDEMNITE": nonTaxable.push({ code: e.code, label: e.label, amount: Number(e.amount) }); break;
      case "ACOMPTE":
      case "PRET": otherDeductions.push({ code: e.code, label: e.label, amount: Number(e.amount) }); break;
      case "HS20": overtime.tier1 += Number(e.hours || 0); break;
      case "HS30": overtime.tier2 += Number(e.hours || 0); break;
      case "HS40": overtime.tier3 += Number(e.hours || 0); break;
      case "NUIT": overtime.night += Number(e.hours || 0); break;
      case "ABSENCE": absenceDays += Number(e.days || 0); break;
      default: break;
    }
  }
  const cfg = configOf(req);
  const workedDays = Math.max(0, (cfg.standardMonthlyDays || 30) - absenceDays);
  return {
    baseSalary: baseSalaryOf(emp, req),
    workedDays, standardDays: cfg.standardMonthlyDays || 30,
    seniorityYears: seniorityYears(emp, period),
    overtime, gains, nonTaxable, otherDeductions,
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

router.post("/runs", allow("ADM"), (req, res) => {
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
router.post("/runs/:id/compute", allow("ADM"), (req, res) => {
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

/** Close the period: lock payslips and roll year-to-date cumuls. */
router.post("/runs/:id/close", allow("ADM"), (req, res) => {
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
  const doc = new PDFDocument({ margin: 42, size: "A4" });
  doc.pipe(res);
  const t = s.result.totals, r = s.result;

  doc.fontSize(15).text(tenant.name, { align: "left" });
  doc.fontSize(9).fillColor("#555").text(`${tenant.hqCity || ""}${tenant.niu ? "  ·  NIU " + tenant.niu : ""}${tenant.cnpsEmployer ? "  ·  CNPS " + tenant.cnpsEmployer : ""}`);
  doc.moveDown(0.4).fillColor("#000").fontSize(13).text(`BULLETIN DE PAIE — ${s.period}`, { align: "center" });
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor("#000");
  doc.text(`Salarié : ${s.employeeName}     Matricule : ${s.matricule}`);
  doc.text(`Catégorie : ${(emp.contract && emp.contract.category) || "—"}     Emploi : ${(emp.contract && emp.contract.position) || emp.position || "—"}`);
  doc.text(`Embauche : ${emp.hireDate || "—"}     CNPS : ${emp.cnpsNumber || "—"}`);
  doc.moveDown(0.5);

  // table header
  const cols = [42, 210, 300, 360, 430, 500]; // x positions
  const head = () => {
    doc.fontSize(8).fillColor("#000");
    doc.text("Rubrique", cols[0], doc.y, { continued: false });
    const y = doc.y - 10;
    doc.text("Base", cols[2], y); doc.text("Taux", cols[3], y);
    doc.text("Gain", cols[4], y); doc.text("Retenue", cols[5], y);
    doc.moveTo(42, doc.y).lineTo(553, doc.y).strokeColor("#ccc").stroke();
  };
  head();
  doc.fontSize(8);
  for (const l of r.lines) {
    if (!l.gain && !l.retenue && !l.employer) continue;
    const y = doc.y + 2;
    doc.fillColor("#000").text(`${l.code}  ${l.label}`, cols[0], y, { width: 250 });
    if (l.base) doc.text(money(l.base), cols[2], y, { width: 55, align: "right" });
    if (l.rate && l.rate !== 1) doc.text((l.rate * 100).toFixed(2) + "%", cols[3], y, { width: 55, align: "right" });
    if (l.gain) doc.text(money(l.gain), cols[4], y, { width: 60, align: "right" });
    if (l.retenue) doc.text(money(l.retenue), cols[5], y, { width: 53, align: "right" });
    doc.moveDown(0.2);
  }
  doc.moveTo(42, doc.y + 2).lineTo(553, doc.y + 2).strokeColor("#ccc").stroke();
  doc.moveDown(0.5).fontSize(9).fillColor("#000");
  const row = (k, v) => doc.text(k, 300, doc.y, { continued: true }).text("  " + money(v) + " XAF", { align: "right" });
  row("Salaire brut", t.brutTotal);
  row("Total retenues", t.totalRetenues);
  doc.font("Helvetica-Bold"); row("NET À PAYER", t.netAPayer); doc.font("Helvetica");
  doc.moveDown(0.4).fillColor("#555").fontSize(8);
  doc.text(`Charges patronales : ${money(t.chargesPatronales)} XAF     Coût total employeur : ${money(t.coutTotalEmployeur)} XAF`, 42);
  doc.moveDown(0.3).text(`Payé le ${new Date().toLocaleDateString("fr-FR")} — par ${(emp.contract && emp.contract.paymentMethod) || "Virement"}`);
  doc.end();
});

/* ===================== LIVRE DE PAIE ========================== */
router.get("/runs/:id/livre", allow("ADM", "CD", "RJ"), (req, res) => {
  const run = mine(db.payRuns, req).find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Paie introuvable" });
  const slips = mine(db.payslips, req).filter(s => s.runId === run.id);
  res.json({ run, rows: slips.map(summary), totals: runTotals(run, req) });
});

/* ================= ÉTATS DES COTISATIONS ===================== */
router.get("/runs/:id/cotisations", allow("ADM", "CD", "RJ"), (req, res) => {
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

module.exports = router;
