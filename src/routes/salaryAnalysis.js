/**
 * Analyse salariale (module RH) - phase 1 : audit de conformité de la rémunération.
 * Simulation à partir des éléments de salaire de la fiche (aucun bulletin requis). Ne modifie
 * jamais le salarié, ses éléments, les rubriques ni les bulletins ; chaque analyse est
 * historisée (payAnalyses) et journalisée. Fonctionne sans le module Paie.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const { NATURES } = require("../payroll/legalNature");
const { auditCompliance } = require("../payroll/compliance");

if (!db.payAnalyses) db.payAnalyses = [];
const RULES_VERSION = "2026-11-01";
const ROLES = allow("RP", "ADM", "CD", "RJ", "GPF");
const H = () => require("./payroll").salaryHelpers;

const thisPeriod = () => new Date().toISOString().slice(0, 7);
const empName = (e) => [e.lastName, e.firstName].filter(Boolean).join(" ") || e.matricule || e.id;
function canSee(req, emp) {
  if (req.user.role !== "GPF") return true;
  const u = db.users.find(x => x.id === req.user.id);
  return ((u && u.portfolioIds) || []).includes(emp.portfolioId);
}

function analyseEmployee(emp, req) {
  const h = H();
  const period = thisPeriod();
  const { input } = h.computeFor(emp, period, req, { structureOnly: true });
  const cfg = Object.assign({}, h.configOf(req));
  cfg.avantagesNatureList = mine(db.payAvantagesNature, req).filter(a => a.active !== false);
  cfg.codeMap = h.codeMapOf(req);
  const rubs = mine(db.payRubriques, req);
  const rubOf = (code) => rubs.find(r => String(r.code) === String(code)) || null;
  const categoryMin = h.categorielBaseA(emp, req);
  const res = auditCompliance(input, cfg, { rubOf, categoryMin, categoryLabel: (emp.contract && emp.contract.category) || "" });
  return Object.assign(res, {
    employee: { id: emp.id, name: empName(emp), matricule: emp.matricule || "", category: (emp.contract && emp.contract.category) || "",
      portfolioId: emp.portfolioId || null, baseSalary: input.baseSalary },
    period, rulesVersion: RULES_VERSION,
  });
}
function record(req, scope, refId, summary) {
  const a = stamp({ id: id("pana"), mode: "AUDIT", scope, refId, rulesVersion: RULES_VERSION, summary,
    createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: new Date().toISOString() }, req);
  db.payAnalyses.push(a);
  // Historique borné par société (les 500 dernières analyses).
  const mineA = mine(db.payAnalyses, req);
  if (mineA.length > 500) { const old = new Set(mineA.slice(0, mineA.length - 500).map(x => x.id)); db.payAnalyses = db.payAnalyses.filter(x => !old.has(x.id)); }
  save();
  audit(req.user, "SALARY_ANALYSIS", "Employee", refId, { scope, mode: "AUDIT", findings: summary.findings });
  return a;
}

router.get("/natures", ROLES, (req, res) =>
  res.json(Object.entries(NATURES).map(([key, n]) => ({ key, label: n.label, impo: n.impo, capRate: n.capRate || null, cnps: n.cnps, justify: !!n.justify, ref: n.ref }))));

router.post("/employee/:id", ROLES, (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.id);
  if (!emp || !canSee(req, emp)) return res.status(404).json({ error: "Salarié introuvable" });
  let out;
  try { out = analyseEmployee(emp, req); } catch (e) { return res.status(400).json({ error: "Analyse impossible : " + e.message }); }
  if (!(out.employee.baseSalary > 0)) return res.status(400).json({ error: "Aucun salaire de base sur la fiche du salarié : renseignez ses éléments de salaire." });
  record(req, "EMPLOYEE", emp.id, out.summary);
  res.json(out);
});

router.post("/portfolio/:id", ROLES, (req, res) => {
  const pid = req.params.id;
  const pf = pid === "_all" ? { id: "_all", name: "Toute l'entreprise" } : mine(db.portfolios, req).find(p => p.id === pid);
  if (!pf) return res.status(404).json({ error: "Portefeuille introuvable" });
  if (pid === "_all" && req.user.role === "GPF") return res.status(403).json({ error: "Analyse limitée à vos portefeuilles" });
  const emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED" && (pid === "_all" || e.portfolioId === pid) && canSee(req, e));
  const rows = [], recurring = {}; let skipped = 0;
  const tot = { gainNetMensuel: 0, gainNetJustifiable: 0, economieEmployeurMensuelle: 0, expositionMensuelle: 0 };
  for (const emp of emps) {
    let r; try { r = analyseEmployee(emp, req); } catch (e) { skipped++; continue; }
    if (!(r.employee.baseSalary > 0)) { skipped++; continue; }
    rows.push({ employee: r.employee, status: r.status, summary: r.summary,
      top: r.findings.slice(0, 3).map(f => ({ title: f.title, type: f.type, level: f.level, net: f.impact.net })) });
    for (const k of Object.keys(tot)) tot[k] += r.summary[k] || 0;
    for (const f of r.findings) { const k = f.type + "|" + f.title; (recurring[k] = recurring[k] || { title: f.title, type: f.type, level: f.level, count: 0, net: 0, ref: f.ref }); recurring[k].count++; recurring[k].net += f.impact.net; }
  }
  rows.sort((a, b) => (b.summary.gainNetMensuel + b.summary.expositionMensuelle) - (a.summary.gainNetMensuel + a.summary.expositionMensuelle));
  const count = (s) => rows.filter(r => r.status === s).length;
  const summary = { analysed: rows.length, skipped, conformes: count("CONFORME"), aOptimiser: count("A_OPTIMISER"), aJustifier: count("A_JUSTIFIER"), enRisque: count("EN_RISQUE"),
    findings: rows.reduce((s, r) => s + r.summary.findings, 0), ...tot, annual: { gainNet: tot.gainNetMensuel * 12, exposition: tot.expositionMensuelle * 12 } };
  record(req, pid === "_all" ? "COMPANY" : "PORTFOLIO", pf.id, summary);
  res.json({ portfolio: { id: pf.id, name: pf.name }, summary, employees: rows,
    recurring: Object.values(recurring).sort((a, b) => b.count - a.count).slice(0, 10), period: thisPeriod(), rulesVersion: RULES_VERSION });
});

router.get("/history", ROLES, (req, res) => res.json(mine(db.payAnalyses, req).slice(-50).reverse()));

module.exports = router;
