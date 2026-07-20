/**
 * M6 — Analytics & Reporting (§7.2, §7.3).
 * KPIs, user-evaluation indicators derived from the audit/workflow logs,
 * CNPS & labour-law compliance report, all exportable to PDF and Excel.
 */
const router = require("express").Router();
const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");
const { db } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");
const { elapsedBusinessHours } = require("../businessHours");

const days = (d) => Math.ceil((new Date(d) - Date.now()) / 86400e3);
const fr = (d) => d ? new Date(d).toLocaleDateString("fr-FR") : "—";
const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (30.44 * 86400e3);

/* ---------------- KPI computation ---------------- */
function kpis(req) {
  const emps = mine(db.employees, req);
  const headcount = emps.length;
  const now = new Date();
  const year = now.getFullYear();

  // payroll mass from salary elements (or convention grid fallback)
  let payroll = 0;
  for (const e of emps) {
    const own = Object.values(e.salary || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    if (own) { payroll += own; continue; }
    const pf = mine(db.portfolios, req).find(p => p.id === e.portfolioId);
    const cnv = mine(db.conventions, req).find(c => c.id === pf?.conventionId);
    const row = (cnv?.grid || []).find(g => g.category === e.contract?.category);
    payroll += row?.baseSalary || 0;
  }

  // turnover: employees whose fixed-term contract ended this year / average headcount
  const ended = emps.filter(e => e.contract?.endDate && new Date(e.contract.endDate) < now &&
    new Date(e.contract.endDate).getFullYear() === year).length;
  const turnover = headcount ? Math.round(ended / headcount * 1000) / 10 : 0;

  // absenteeism: approved leave days this year / (headcount * 220 working days)
  const leaveDays = mine(db.documents, req).filter(d => d.type === "LEAVE" && d.status === "GENERATED")
    .reduce((s, d) => s + (d.data.days || 0), 0);
  const absenteeism = headcount ? Math.round(leaveDays / (headcount * 220) * 1000) / 10 : 0;

  // age pyramid
  const buckets = { "<25": 0, "25-34": 0, "35-44": 0, "45-54": 0, "55+": 0 };
  for (const e of emps) {
    const age = monthsBetween(e.birthDate, now) / 12;
    if (age < 25) buckets["<25"]++; else if (age < 35) buckets["25-34"]++;
    else if (age < 45) buckets["35-44"]++; else if (age < 55) buckets["45-54"]++; else buckets["55+"]++;
  }

  const byPortfolio = mine(db.portfolios, req).map(p => ({ name: p.name,
    count: emps.filter(e => e.portfolioId === p.id).length }));
  const byContract = {};
  for (const e of emps) { const t = e.contract?.type || "—"; byContract[t] = (byContract[t] || 0) + 1; }
  const byCategory = {};
  for (const e of emps) { const c = e.contract?.category || "—"; byCategory[c] = (byCategory[c] || 0) + 1; }

  return { headcount, payroll, turnover, absenteeism, leaveDays, buckets, byPortfolio, byContract, byCategory,
    generatedDocs: mine(db.documents, req).filter(d => d.status === "GENERATED").length };
}

/* -------- User evaluation indicators from logs (§4.3) -------- */
function evaluation(req) {
  const rows = [];
  for (const u of mine(db.users, req)) {
    if (u.role === "GPF") {
      const myDocs = mine(db.documents, req).filter(d => d.createdById === u.id);
      const submitted = myDocs.length;
      const rejectedDocs = myDocs.filter(d => d.steps?.some(s => s.decision === "REJECTED"));
      const reasons = {};
      for (const d of rejectedDocs)
        for (const s of d.steps.filter(x => x.decision === "REJECTED")) {
          const key = (s.rejectReason || "").slice(0, 60);
          reasons[key] = (reasons[key] || 0) + 1;
        }
      const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
      rows.push({ user: u.fullName, role: "GPF", submitted,
        rejected: rejectedDocs.length,
        rejectionRate: submitted ? Math.round(rejectedDocs.length / submitted * 1000) / 10 : 0,
        resubmissions: myDocs.reduce((s, d) => s + Math.max(0, (d.cycle || 1) - 1), 0),
        topRejectReason: top ? `${top[0]} (${top[1]}×)` : "—",
        avgDelayH: null, breaches: null });
    }
    if (["CD", "RJ"].includes(u.role)) {
      const steps = db.documents.flatMap(d => (d.steps || []).filter(s => s.stage === u.role));
      const decided = steps.filter(s => s.decidedAt);
      const durations = decided.map(s => s.elapsedH ?? elapsedBusinessHours(s.assignedAt, new Date(s.decidedAt)));
      const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
      rows.push({ user: u.fullName, role: u.role, submitted: null, rejected: decided.filter(s => s.decision === "REJECTED").length,
        rejectionRate: decided.length ? Math.round(decided.filter(s => s.decision === "REJECTED").length / decided.length * 1000) / 10 : 0,
        resubmissions: null, topRejectReason: "—",
        decided: decided.length, avgDelayH: avg, breaches: steps.filter(s => s.breachedAt).length });
    }
  }
  return rows;
}

/* -------- CNPS & labour-law compliance (§7.3) -------- */
function compliance(req) {
  const issues = [];
  for (const e of mine(db.employees, req)) {
    const name = `${e.firstName} ${e.lastName}`;
    if (!e.cnpsNumber) issues.push({ employee: name, severity: "HIGH", issue: "Numéro CNPS manquant — affiliation à régulariser" });
    if (!e.cniExpiry || days(e.cniExpiry) < 0) issues.push({ employee: name, severity: "HIGH", issue: `CNI expirée (${fr(e.cniExpiry)})` });
    else if (days(e.cniExpiry) <= 60) issues.push({ employee: name, severity: "MEDIUM", issue: `CNI expire dans ${days(e.cniExpiry)} jours` });
    const pf = mine(db.portfolios, req).find(p => p.id === e.portfolioId);
    const uploaded = new Set(mine(db.files, req).filter(f => f.employeeId === e.id).map(f => f.docType));
    const missing = (pf?.required || []).filter(c => !uploaded.has(c));
    if (missing.length) issues.push({ employee: name, severity: "MEDIUM", issue: `Pièces obligatoires manquantes: ${missing.join(", ")}` });
    const med = mine(db.files, req).find(f => f.employeeId === e.id && f.docType === "XVI");
    if (!med) issues.push({ employee: name, severity: "LOW", issue: "Aucune visite médicale enregistrée" });
    if (e.contract?.type && e.contract.endDate && days(e.contract.endDate) <= 30 && days(e.contract.endDate) >= 0)
      issues.push({ employee: name, severity: "MEDIUM", issue: `Contrat à durée déterminée expirant le ${fr(e.contract.endDate)} — décision de renouvellement requise` });
    if (!e.contract?.category) issues.push({ employee: name, severity: "LOW", issue: "Catégorie conventionnelle non renseignée" });
  }
  const score = mine(db.employees, req).length
    ? Math.max(0, Math.round(100 - issues.filter(i => i.severity === "HIGH").length * 10
        - issues.filter(i => i.severity === "MEDIUM").length * 4 - issues.filter(i => i.severity === "LOW").length * 1))
    : 100;
  return { score, issues,
    counts: { HIGH: issues.filter(i => i.severity === "HIGH").length,
      MEDIUM: issues.filter(i => i.severity === "MEDIUM").length,
      LOW: issues.filter(i => i.severity === "LOW").length } };
}

/* -------- SLA report -------- */
function slaReport(req) {
  const rows = [];
  for (const d of mine(db.documents, req))
    for (const s of d.steps || []) {
      const el = s.elapsedH ?? elapsedBusinessHours(s.assignedAt, s.decidedAt ? new Date(s.decidedAt) : new Date());
      rows.push({ document: d.title, stage: s.stage, cycle: d.cycle,
        assigned: fr(s.assignedAt), decision: s.decision || "PENDING",
        elapsedH: el, breach: !!s.breachedAt, reason: s.rejectReason || "" });
    }
  return rows;
}

const REPORTS = {
  kpis: { label: "Tableau de bord RH (KPIs)", build: kpis },
  evaluation: { label: "Évaluation des utilisateurs (logs)", build: evaluation },
  compliance: { label: "Conformité CNPS & droit du travail", build: compliance },
  sla: { label: "Délais de validation (SLA)", build: slaReport },
  headcount: { label: "Effectifs par portefeuille & catégorie", build: (req) => {
    const k = kpis();
    return mine(db.employees, req).map(e => {
      const pf = mine(db.portfolios, req).find(p => p.id === e.portfolioId);
      const cnv = mine(db.conventions, req).find(c => c.id === pf?.conventionId);
      return { nom: `${e.firstName} ${e.lastName}`, portefeuille: pf?.name || "—",
        convention: cnv?.name || "—", contrat: e.contract?.type || "—",
        categorie: e.contract?.category || "—", embauche: fr(e.hireDate),
        cnps: e.cnpsNumber || "—", cni: e.cniNumber };
    });
  } },
};

router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) =>
  res.json(Object.entries(REPORTS).map(([key, r]) => ({ key, label: r.label }))));

router.get("/:key", allow("CD", "RJ", "ADM"), (req, res) => {
  const r = REPORTS[req.params.key];
  if (!r) return res.status(404).json({ error: "Unknown report" });
  res.json({ key: req.params.key, label: r.label, data: r.build(req) });
});

/* ---------------- Exports ---------------- */
router.get("/:key/export", allow("CD", "RJ", "ADM"), (req, res) => {
  const r = REPORTS[req.params.key];
  if (!r) return res.status(404).json({ error: "Unknown report" });
  const format = (req.query.format || "pdf").toLowerCase();
  if (!["pdf", "xlsx"].includes(format)) return res.status(400).json({ error: "format must be pdf or xlsx" });
  const data = r.build(req);
  audit(req.user, "EXPORTED", "Report", req.params.key, { format });

  if (format === "xlsx") {
    const wb = XLSX.utils.book_new();
    const sheets = toSheets(req.params.key, data);
    for (const [name, rows] of Object.entries(sheets))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.key}_${Date.now()}.xlsx"`);
    return res.send(buf);
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.key}.pdf"`);
  const doc = new PDFDocument({ margin: 42, size: "A4", layout: "landscape" });
  doc.pipe(res);
  doc.fontSize(15).fillColor("#1e3a5f").font("Helvetica-Bold").text("CIBLE RH EMPLOI S.A.", { align: "center" });
  doc.fontSize(12).text(r.label, { align: "center" });
  doc.fontSize(8).fillColor("#777").font("Helvetica")
    .text(`Édité le ${new Date().toLocaleString("fr-FR")} par ${req.user.fullName || req.user.id}`, { align: "center" });
  doc.moveDown();
  const L = 42, R = 800; // landscape A4 usable width
  for (const [title, rows] of Object.entries(toSheets(req.params.key, data))) {
    if (doc.y > 470) doc.addPage({ layout: "landscape" });
    doc.moveDown(.5);
    doc.fontSize(11).fillColor("#1e3a5f").font("Helvetica-Bold").text(title, L, doc.y, { width: R - L });
    doc.moveTo(L, doc.y + 2).lineTo(R, doc.y + 2).strokeColor("#e8833a").lineWidth(1).stroke();
    doc.moveDown(.4);
    if (!rows.length) { doc.fontSize(9).font("Helvetica").fillColor("#000").text("Aucune donnée.", L, doc.y); continue; }
    const cols = Object.keys(rows[0]);
    // proportional widths: wider for long text columns
    const weight = cols.map(c => rows.slice(0, 30).reduce((m, x) => Math.max(m, String(x[c] ?? "").length), c.length));
    const total = weight.reduce((a, b) => a + b, 0);
    const widths = weight.map(w => Math.max(52, (R - L) * w / total));
    const scale = (R - L) / widths.reduce((a, b) => a + b, 0);
    const W = widths.map(w => w * scale);
    const X = W.reduce((acc, w, i) => (acc.push(i ? acc[i - 1] + W[i - 1] : L), acc), []);

    const header = () => {
      const y = doc.y;
      doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#444");
      cols.forEach((c, i) => doc.text(String(c), X[i], y, { width: W[i] - 4 }));
      doc.y = y + 13;
      doc.moveTo(L, doc.y - 3).lineTo(R, doc.y - 3).strokeColor("#dddddd").lineWidth(.5).stroke();
    };
    header();
    doc.font("Helvetica").fillColor("#000").fontSize(7.5);
    for (const row of rows) {
      if (doc.y > 520) { doc.addPage({ layout: "landscape" }); header(); doc.font("Helvetica").fillColor("#000").fontSize(7.5); }
      const y = doc.y;
      let maxH = 0;
      cols.forEach((c, i) => {
        const txt = String(row[c] ?? "");
        doc.text(txt, X[i], y, { width: W[i] - 4 });
        maxH = Math.max(maxH, doc.y - y);
        doc.y = y;
      });
      doc.y = y + Math.max(11, maxH + 2);
    }
    doc.moveDown(.3);
  }
  doc.end();
});

/** Normalize each report into named tabular sheets for PDF/Excel. */
function toSheets(key, d) {
  if (key === "kpis") return {
    "Indicateurs": [{ Effectif: d.headcount, "Masse salariale (FCFA)": d.payroll, "Turnover %": d.turnover,
      "Absentéisme %": d.absenteeism, "Jours de congés": d.leaveDays, "Documents générés": d.generatedDocs }],
    "Par portefeuille": d.byPortfolio.map(p => ({ Portefeuille: p.name, Effectif: p.count })),
    "Par contrat": Object.entries(d.byContract).map(([k, v]) => ({ Contrat: k, Effectif: v })),
    "Par catégorie": Object.entries(d.byCategory).map(([k, v]) => ({ Catégorie: k, Effectif: v })),
    "Pyramide des âges": Object.entries(d.buckets).map(([k, v]) => ({ Tranche: k, Effectif: v })),
  };
  if (key === "compliance") return {
    "Synthèse": [{ "Score de conformité": d.score + "/100", Critiques: d.counts.HIGH, Moyens: d.counts.MEDIUM, Mineurs: d.counts.LOW }],
    "Anomalies": d.issues.map(i => ({ Employé: i.employee, Gravité: i.severity, Anomalie: i.issue })),
  };
  if (key === "evaluation") return { "Évaluation utilisateurs": d.map(r => ({
    Utilisateur: r.user, Rôle: r.role, Soumis: r.submitted ?? "—", Décidés: r.decided ?? "—",
    Rejets: r.rejected, "Taux rejet %": r.rejectionRate, Resoumissions: r.resubmissions ?? "—",
    "Délai moyen (h)": r.avgDelayH ?? "—", "Dépassements 48h": r.breaches ?? "—",
    "Motif récurrent": r.topRejectReason })) };
  if (key === "sla") return { "Délais de validation": d.map(r => ({
    Document: r.document, Étape: r.stage, Cycle: r.cycle, Assigné: r.assigned,
    Décision: r.decision, "Heures ouvrables": r.elapsedH, Dépassement: r.breach ? "OUI" : "non", Motif: r.reason })) };
  return { "Données": Array.isArray(d) ? d : [d] };
}

module.exports = router;
