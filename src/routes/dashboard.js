/** Real-time HR dashboard (§7.2) — role-aware KPIs, SLA timers, expiry alerts. */
const router = require("express").Router();
const { db } = require("../store");
const { allow } = require("../rbac");
const wf = require("../workflow");

router.get("/", allow("GPF", "CD", "RJ", "UI", "ADM"), (req, res) => {
  wf.slaScan();
  const now = new Date();
  const inDays = d => Math.ceil((new Date(d) - now) / 86400e3);

  const docs = db.documents.map(wf.withTimer);
  const pending = docs.filter(d => ["SUBMITTED", "CD_APPROVED"].includes(d.status));
  const cniExpiring = db.employees
    .filter(e => e.cniExpiry && inDays(e.cniExpiry) <= 60)
    .map(e => ({ name: `${e.firstName} ${e.lastName}`, date: e.cniExpiry, days: inDays(e.cniExpiry) }));
  const cddEnding = db.employees
    .filter(e => e.contract?.type === "CDD" && e.contract?.endDate && inDays(e.contract.endDate) <= 30)
    .map(e => ({ name: `${e.firstName} ${e.lastName}`, date: e.contract.endDate, days: inDays(e.contract.endDate) }));

  res.json({
    headcount: db.employees.length,
    portfolios: db.portfolios.map(p => ({
      name: p.name, count: db.employees.filter(e => e.portfolioId === p.id).length })),
    pendingCD: pending.filter(d => d.currentStage === "CD").length,
    pendingRJ: pending.filter(d => d.currentStage === "RJ").length,
    warnings: pending.filter(d => d.slaState === "WARNING").length,
    breaches: pending.filter(d => d.slaState === "BREACH").length,
    generated: db.documents.filter(d => d.status === "GENERATED").length,
    myQueue: ["CD", "RJ"].includes(req.user.role)
      ? pending.filter(d => d.currentStage === req.user.role).length : null,
    myRejected: req.user.role === "GPF"
      ? docs.filter(d => d.createdById === req.user.id && d.status === "DRAFT" &&
          d.steps?.some(s => s.decision === "REJECTED")).length : null,
    timers: pending.slice(0, 10).map(d => ({
      title: d.title, stage: d.currentStage, elapsedH: d.elapsedH, slaState: d.slaState, cycle: d.cycle })),
    cniExpiring, cddEnding,
  });
});
module.exports = router;
