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
  const doc = new PDFDocument({ margin: 28, size: "A4" });
  doc.pipe(res);
  const t = s.result.totals, r = s.result;
  const F = (n) => String(Math.round(n||0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const C = (emp.contract) || {};
  const yrs = (() => { const h = emp.hireDate ? new Date(emp.hireDate) : null; if(!h) return "";
    const d = new Date(s.period + "-01"); let m=(d.getFullYear()-h.getFullYear())*12+(d.getMonth()-h.getMonth());
    return `${Math.floor(m/12)} an(s) et ${m%12} mois`; })();
  const cum = (db.payCumuls||[]).find(c => (c.tenantId||"t1")===(s.tenantId||"t1") && c.employeeId===s.employeeId && c.year===s.period.slice(0,4));
  let y = 30;
  const L = (x,txt,opt={}) => { doc.text(txt==null?"":String(txt), x, y, opt); };

  // ---- Header ----
  doc.fontSize(13).font("Helvetica-Bold"); L(28, tenant.name); doc.font("Helvetica");
  doc.fontSize(13).font("Helvetica-Bold"); L(360, "BULLETIN DE PAIE", {width:207,align:"right"}); doc.font("Helvetica");
  y+=20; doc.fontSize(8);
  L(28, `Période : ${s.period}`, {width:300}); L(360,`Payé par ${C.paymentMethod||"Virement"}`,{width:207,align:"right"});
  y+=14;
  // info grid (two columns)
  const info = [
    ["N° Contribuable", tenant.niu||"—", "Matricule", s.matricule||emp.matricule||"—"],
    ["N° Employeur (CNPS)", tenant.cnpsEmployer||"—", "N° CNPS", emp.cnpsNumber||"—"],
    ["Banque", emp.bankName||C.bankName||"—", "N° Compte", emp.bankAccount||C.bankIban||"—"],
    ["Conv. collective", C.convention||emp.convention||"—", "Catégorie", C.category||"—"],
    ["Salarié", s.employeeName, "Emploi", C.position||emp.position||"—"],
    ["Date embauche", emp.hireDate||"—", "Ancienneté", yrs||"—"],
    ["Sit. familiale", emp.maritalStatus||"—", "Nbre enfants", (emp.children!=null?emp.children:"—")],
    ["Qualification", emp.qualification||"—", "Département", emp.department||s.department||"—"],
    ["N° DIPE", emp.dipe||tenant.dipe||"—", "Jour/Mois", "30,00"],
  ];
  doc.fontSize(7.5);
  for (const [k1,v1,k2,v2] of info) {
    doc.fillColor("#666"); L(28,k1); L(300,k2);
    doc.fillColor("#000"); doc.font("Helvetica-Bold"); L(120,v1,{width:170}); L(392,v2,{width:170}); doc.font("Helvetica");
    y+=12;
  }
  y+=4;
  // ---- Rubrique table ----
  const X={num:28,des:56,nb:210,base:255,txs:312,gain:352,ret:418,txp:478,retp:512};
  const th=(lbl,x,w,al="right")=>doc.fillColor("#000").text(lbl,x,y,{width:w,align:al});
  doc.fontSize(7).font("Helvetica-Bold");
  th("N°",X.num,26,"left"); th("Désignation",X.des,150,"left"); th("Nombre",X.nb,42); th("Base",X.base,52);
  th("Taux",X.txs,38); th("Gain",X.gain,62); th("Retenue",X.ret,56); th("Tx pat",X.txp,32); th("Ret. pat",X.retp,43);
  doc.font("Helvetica"); y+=10; doc.moveTo(28,y).lineTo(567,y).strokeColor("#999").lineWidth(0.5).stroke(); y+=3;
  const rowLine=(l)=>{
    doc.fontSize(7).fillColor("#000");
    L(X.num,String(l.code).slice(0,7),{width:26}); L(X.des,l.label,{width:152});
    if(l.hours) doc.text(F(l.hours),X.nb,y,{width:42,align:"right"});
    if(l.base) doc.text(F(l.base),X.base,y,{width:52,align:"right"});
    if(l.rate&&l.rate!==1&&l.kind!=="GAIN") doc.text((l.rate*100).toFixed(2),X.txs,y,{width:38,align:"right"});
    if(l.gain) doc.text(F(l.gain),X.gain,y,{width:62,align:"right"});
    if(l.retenue) doc.text(F(l.retenue),X.ret,y,{width:56,align:"right"});
    if(l.employerRate) doc.text((l.employerRate*100).toFixed(2),X.txp,y,{width:32,align:"right"});
    if(l.employer) doc.text(F(l.employer),X.retp,y,{width:43,align:"right"});
    y+=10;
  };
  const gains=r.lines.filter(l=>l.kind==="GAIN"&&l.gain);
  gains.forEach(rowLine);
  doc.moveTo(28,y).lineTo(567,y).strokeColor("#ccc").stroke(); y+=2;
  doc.font("Helvetica-Bold").fontSize(7.5); L(X.des,"Total Brut"); doc.text(F(t.brutTotal),X.gain,y,{width:62,align:"right"}); doc.font("Helvetica"); y+=12;
  const cot=r.lines.filter(l=>l.kind==="COTIS"||l.kind==="IMPOT"||l.kind==="RETENUE");
  cot.forEach(rowLine);
  doc.moveTo(28,y).lineTo(567,y).strokeColor("#999").stroke(); y+=2;
  const cotisPatSlip=(t.cnpsPatronal||0)+(t.cfcPatronal||0);
  doc.font("Helvetica-Bold").fontSize(7.5); L(X.des,"Total Cotisations");
  doc.text(F(t.totalRetenues-(t.autresRetenues||0)),X.ret,y,{width:56,align:"right"});
  doc.text(F(cotisPatSlip),X.retp,y,{width:43,align:"right"}); doc.font("Helvetica"); y+=16;

  // ---- Summary band ----
  const bandCols=[["Cumuls",28,60],["Salaire brut",92,70],["Salaire taxable",165,70],["Charges\nsalariales",240,55],["Charges\npatronales",298,55],["Avantages\nnature",356,50],["Heures\nsupp.",408,42],["Jours",452,34],["NET A PAYER",488,79]];
  doc.rect(28,y,539,46).strokeColor("#999").stroke();
  doc.fontSize(6.5).fillColor("#555");
  bandCols.forEach(([lbl,x,w])=>doc.text(lbl.replace("\\n"," "),x,y+2,{width:w,align:x===28?"left":"right"}));
  const bandRow=(name,yy,vals)=>{ doc.fillColor("#000").fontSize(7.5);
    doc.text(name,28,yy,{width:60}); const xs=[92,165,240,298,356,408,452,488],ws=[70,70,55,55,50,42,34,79];
    vals.forEach((v,i)=>doc.text(v,xs[i],yy,{width:ws[i],align:"right"})); };
  bandRow("Période",y+16,[F(t.brutTotal),F(t.netImposable),F(t.totalRetenues),F(t.chargesPatronales),"0","0","30",F(t.netAPayer)]);
  if(cum) bandRow("Année",y+30,[F(cum.brut),"—",F(cum.cnps+cum.irpp),"—","0","0","—",F(cum.net)]);
  y+=54;
  // NET emphasis
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000");
  L(360,`NET À PAYER : ${F(t.netAPayer)} XAF`,{width:207,align:"right"}); doc.font("Helvetica");
  y+=22;
  // ---- Footer: congés + signature + legal ----
  doc.fontSize(7).fillColor("#000");
  doc.rect(28,y,539,30).strokeColor("#ccc").stroke();
  L(34,`Congés : acquis ${(r.meta&&r.meta.leaveAccrued)||2.5} j/mois`,{width:250}); L(360,"Signature",{width:200,align:"right"});
  y+=36;
  doc.fontSize(6.5).fillColor("#666");
  L(28,"Pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée. Tout paiement indu doit être immédiatement signalé.",{width:539,align:"center"});
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
