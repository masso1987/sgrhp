/** Real-time HR dashboard (§7.2) - role-aware KPIs, SLA timers, expiry alerts. */
const router = require("express").Router();
const { db } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const wf = require("../workflow");

router.get("/", allow("GPF", "CD", "RJ", "UI", "ADM"), (req, res) => {
  wf.slaScan();
  const now = new Date();
  const inDays = d => Math.ceil((new Date(d) - now) / 86400e3);

  const docs = mine(db.documents, req).map(wf.withTimer);
  const pending = docs.filter(d => ["SUBMITTED", "CD_APPROVED"].includes(d.status));

  const emps = mine(db.employees, req);
  const todayStr = now.toISOString().slice(0, 10);

  // ---- Présence du jour : employés ayant pointé une arrivée aujourd'hui, et actuellement présents.
  const attToday = mine(db.attendance || [], req).filter(a => String(a.serverTs || "").slice(0, 10) === todayStr);
  const byEmp = {};
  for (const a of attToday.slice().sort((x, y) => String(x.serverTs).localeCompare(String(y.serverTs)))) {
    (byEmp[a.employeeId] = byEmp[a.employeeId] || []).push(a);
  }
  let presentNow = 0, checkedInToday = 0, attExceptions = 0;
  for (const list of Object.values(byEmp)) {
    const lastIn = [...list].reverse().find(a => a.type === "IN");
    const lastOut = [...list].reverse().find(a => a.type === "OUT");
    if (lastIn) { checkedInToday++; if (!lastOut || lastIn.serverTs > lastOut.serverTs) presentNow++; }
    attExceptions += list.filter(a => a.status === "EXCEPTION").length;
  }

  // ---- Soldes de congés : agrégat sur l'effectif (jours restants, employés en solde négatif).
  let leaveTotalRemaining = 0, leaveNegative = 0;
  try {
    const { leaveBalance } = require("./hr");
    for (const e of emps) {
      try { const b = leaveBalance(e); leaveTotalRemaining += b.remaining || 0; if ((b.remaining || 0) < 0) leaveNegative++; } catch (_) {}
    }
  } catch (_) {}

  // ---- État de la paie : dernière période, ouverte/clôturée.
  const runs = mine(db.payRuns || [], req).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const latestRun = runs[runs.length - 1] || null;
  const payroll = latestRun
    ? { period: latestRun.period, status: latestRun.status, open: latestRun.status !== "CLOSED",
        payslips: (typeof latestRun.count === "number" ? latestRun.count : mine(db.payslips || [], req).filter(s => s.runId === latestRun.id).length) }
    : { period: null, status: "AUCUNE", open: false, payslips: null };

  // ---- Consommation assurance : cumul de l'année en cours (montant & nb de relevés).
  const yr = String(now.getFullYear());
  const consAll = mine(db.insuranceConsumption || [], req);
  const consYear = consAll.filter(c => String(c.period || c.date || c.createdAt || "").slice(0, 4) === yr);
  const insurance = {
    statementsYear: consYear.length,
    amountYear: Math.round(consYear.reduce((s, c) => s + (Number(c.amount) || 0), 0)),
    coveredYear: Math.round(consYear.reduce((s, c) => s + (Number(c.covered) || 0), 0)),
    pendingDependents: mine(db.dependents || [], req).filter(d => d.status === "PENDING").length,
  };
  const cniExpiring = db.employees
    .filter(e => e.cniExpiry && inDays(e.cniExpiry) <= 60)
    .map(e => ({ name: `${e.firstName} ${e.lastName}`, date: e.cniExpiry, days: inDays(e.cniExpiry) }));
  const cddEnding = db.employees
    .filter(e => e.contract?.type === "CDD" && e.contract?.endDate && inDays(e.contract.endDate) <= 30)
    .map(e => ({ name: `${e.firstName} ${e.lastName}`, date: e.contract.endDate, days: inDays(e.contract.endDate) }));

  res.json({
    headcount: mine(db.employees, req).length,
    portfolios: mine(db.portfolios, req).map(p => ({
      name: p.name, count: mine(db.employees, req).filter(e => e.portfolioId === p.id).length })),
    pendingCD: pending.filter(d => d.currentStage === "CD").length,
    pendingRJ: pending.filter(d => d.currentStage === "RJ").length,
    warnings: pending.filter(d => d.slaState === "WARNING").length,
    breaches: pending.filter(d => d.slaState === "BREACH").length,
    generated: mine(db.documents, req).filter(d => d.status === "GENERATED").length,
    myQueue: ["CD", "RJ"].includes(req.user.role)
      ? pending.filter(d => d.currentStage === req.user.role).length : null,
    myRejected: req.user.role === "GPF"
      ? docs.filter(d => d.createdById === req.user.id && d.status === "DRAFT" &&
          d.steps?.some(s => s.decision === "REJECTED")).length : null,
    timers: pending.slice(0, 10).map(d => ({
      title: d.title, stage: d.currentStage, elapsedH: d.elapsedH, slaState: d.slaState, cycle: d.cycle })),
    cniExpiring, cddEnding,
    // Bloc RH : présence du jour, congés, paie, assurance.
    hr: {
      presence: { presentNow, checkedInToday, headcount: emps.length, exceptions: attExceptions },
      leave: { totalRemaining: Math.round(leaveTotalRemaining * 10) / 10, negativeBalances: leaveNegative },
      payroll,
      insurance,
    },
  });
});
module.exports = router;
