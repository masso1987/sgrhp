/**
 * SGRHP — Comptabilité (Module Comptabilité, OHADA/SYSCOHADA).
 * Phase C1 : référentiels (plan comptable, journaux, taxes, tiers, exercices)
 * + saisie des écritures avec contrôle d'équilibre (Débit = Crédit) + balance.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

for (const k of ["acctAccounts", "acctJournals", "acctTaxes", "acctThirdParties", "acctEntries", "acctExercises", "acctBudgets", "acctBankLines", "acctBankMatches"]) if (!db[k]) db[k] = [];

const R2 = (n) => Math.round(Number(n) || 0);

/* ============================ SEED (OHADA + CIBLE RH) ============================ */
const SEED_ACCOUNTS = [
  // Classe 1 — Capitaux
  ["101300", "Capital versé non amorti", "capitaux"], ["106150", "Écart réévaluation immob. amorties", "capitaux"],
  ["111000", "Réserve légale", "capitaux"], ["118100", "Réserve facultative", "capitaux"],
  ["121000", "Report à nouveau créditeur", "capitaux"], ["129100", "Report à nouveau débiteur", "capitaux"],
  ["130100", "Résultat en instance (bénéfice)", "capitaux"], ["130900", "Résultat exercice (perte)", "capitaux"],
  ["162100", "Emprunts ets de crédit", "capitaux"], ["164100", "Compte courant associé", "capitaux"],
  ["191000", "Provisions - litiges", "capitaux"], ["198100", "Provisions amendes/pénalités", "capitaux"],
  // Classe 2 — Immobilisations
  ["213000", "Logiciel (serveur)", "immobilisations"], ["213100", "Logiciel (tests)", "immobilisations"],
  ["213200", "Logiciel (paie)", "immobilisations"], ["213201", "Logiciel (comptabilité)", "immobilisations"],
  ["213210", "Site internet - plateforme", "immobilisations"], ["222100", "Terrain à bâtir", "immobilisations"],
  // Classe 4 — Tiers
  ["401110", "Fournisseurs", "tiers"], ["411100", "Clients", "tiers"],
  ["443100", "TVA collectée (19,25 %)", "tiers"], ["445400", "TVA déductible", "tiers"],
  ["447110", "État, IS retenue à la source", "tiers"], ["447130", "État, autres impôts et taxes", "tiers"],
  ["421000", "Personnel, rémunérations dues", "tiers"], ["431000", "CNPS", "tiers"],
  // Classe 5 — Trésorerie
  ["521000", "Banque (CBC)", "financiers"], ["571000", "Caisse", "financiers"],
  // Classe 6 — Charges
  ["605200", "Achats (autres)", "charges"], ["605810", "Achats divers", "charges"],
  ["624210", "Transports sur ventes", "charges"], ["632710", "Frais de mise à disposition (MAD)", "charges"],
  ["661000", "Rémunérations du personnel", "charges"], ["664000", "Charges sociales", "charges"],
  // Classe 7 — Produits
  ["701100", "Ventes de marchandises/prestations dans la région", "produits"], ["706000", "Services vendus", "produits"],
];
const SEED_JOURNALS = [
  ["ACH", "Journal des achats", "achat"], ["VTE", "Journal des ventes", "vente"],
  ["BQ", "Journal de banque (CBC)", "banque"], ["CA", "Journal de caisse", "caisse"],
  ["OD", "Opérations diverses", "od"], ["PAIE", "Journal de paie", "od"],
  ["AN", "Journal des à-nouveaux", "anouveaux"], ["CLO", "Journal de clôture", "cloture"],
];
const SEED_TAXES = [
  ["TVA1925", "TVA 19,25 %", 0.1925, "443100"], ["EXO", "Exonéré", 0, ""], ["IS22", "IS / retenue 2,2 %", 0.022, "447110"],
];
function seedAccounting(tid) {
  const has = (col) => mine ? (db[col] || []).some(x => (x.tenantId || "t1") === tid) : false;
  const put = (col, rec) => db[col].push(Object.assign({ id: id("acc"), tenantId: tid, createdAt: new Date().toISOString() }, rec));
  if (!(db.acctAccounts || []).some(a => (a.tenantId || "t1") === tid))
    for (const [number, label, nature] of SEED_ACCOUNTS) put("acctAccounts", { number, label, type: "detail", nature, active: true });
  if (!(db.acctJournals || []).some(j => (j.tenantId || "t1") === tid))
    for (const [code, label, type] of SEED_JOURNALS) put("acctJournals", { code, label, type, contraAccount: type === "banque" ? "521000" : type === "caisse" ? "571000" : "" });
  if (!(db.acctTaxes || []).some(t => (t.tenantId || "t1") === tid))
    for (const [code, label, rate, account] of SEED_TAXES) put("acctTaxes", { code, label, rate, account });
  if (!(db.acctExercises || []).some(e => (e.tenantId || "t1") === tid)) {
    const y = new Date().getFullYear();
    put("acctExercises", { year: y, start: y + "-01-01", end: y + "-12-31", status: "open", current: true });
  }
  save();
}

/* ============================ RÉFÉRENTIELS (CRUD) ============================ */
function crud(path, col, fields, keyField) {
  router.get("/" + path, allow("ADM", "CD", "RJ"), (req, res) => { seedAccounting(req.user.tenantId || "t1"); res.json(mine(db[col], req).slice().sort((a, b) => String(a[keyField] || "").localeCompare(String(b[keyField] || "")))); });
  router.get("/" + path + "/:id", allow("ADM", "CD", "RJ"), (req, res) => { const x = mine(db[col], req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" }); res.json(x); });
  router.post("/" + path, allow("ADM", "CD"), (req, res) => {
    const b = req.body || {}; if (!b[keyField]) return res.status(400).json({ error: keyField + " obligatoire" });
    if (mine(db[col], req).some(r => String(r[keyField]) === String(b[keyField]))) return res.status(409).json({ error: "Existe déjà : " + b[keyField] });
    const rec = { id: id("acc"), createdAt: new Date().toISOString() };
    for (const f of fields) if (b[f] !== undefined) rec[f] = b[f];
    db[col].push(stamp(rec, req)); save(); audit(req.user, "CREATED", col, rec.id, {}); res.status(201).json(rec);
  });
  router.put("/" + path + "/:id", allow("ADM", "CD"), (req, res) => {
    const x = mine(db[col], req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
    for (const f of fields) if (f !== keyField && req.body[f] !== undefined) x[f] = req.body[f];
    save(); res.json(x);
  });
  router.delete("/" + path + "/:id", allow("ADM"), (req, res) => {
    const x = mine(db[col], req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
    db[col].splice(db[col].indexOf(x), 1); save(); res.json({ ok: true });
  });
}
crud("accounts", "acctAccounts", ["number", "label", "type", "nature", "reportANouveau", "taxCode", "reportingAccount", "active"], "number");
crud("journals", "acctJournals", ["code", "label", "type", "contraAccount"], "code");
crud("taxes", "acctTaxes", ["code", "label", "rate", "account"], "code");
crud("third-parties", "acctThirdParties", ["code", "name", "kind", "collectiveAccount", "terms", "niu", "rccm"], "code");

/* ============================ EXERCICES ============================ */
router.get("/exercises", allow("ADM", "CD", "RJ"), (req, res) => { seedAccounting(req.user.tenantId || "t1"); res.json(mine(db.acctExercises, req).slice().sort((a, b) => b.year - a.year)); });
router.post("/exercises", allow("ADM"), (req, res) => {
  const b = req.body || {}; const year = Number(b.year); if (!year) return res.status(400).json({ error: "Année obligatoire" });
  if (mine(db.acctExercises, req).some(e => e.year === year)) return res.status(409).json({ error: "Exercice déjà ouvert" });
  const e = stamp({ id: id("acc"), year, start: year + "-01-01", end: year + "-12-31", status: "open", current: !!b.current, createdAt: new Date().toISOString() }, req);
  if (b.current) mine(db.acctExercises, req).forEach(x => x.current = false);
  db.acctExercises.push(e); save(); res.status(201).json(e);
});

/* ============================ ÉCRITURES ============================ */
const jrOf = (req, code) => mine(db.acctJournals, req).find(j => j.code === code);
function entryTotals(e) {
  const d = (e.lines || []).reduce((a, l) => a + R2(l.debit), 0);
  const c = (e.lines || []).reduce((a, l) => a + R2(l.credit), 0);
  return { debit: d, credit: c, balanced: d === c && d > 0 };
}
const withTotals = (e) => Object.assign({}, e, entryTotals(e));

router.get("/entries", allow("ADM", "CD", "RJ"), (req, res) => {
  let list = mine(db.acctEntries, req);
  if (req.query.journal) list = list.filter(e => e.journalCode === req.query.journal);
  if (req.query.period) list = list.filter(e => (e.period || "") === req.query.period);
  res.json(list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(withTotals));
});
router.get("/entries/:id", allow("ADM", "CD", "RJ"), (req, res) => {
  const e = mine(db.acctEntries, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Écriture introuvable" }); res.json(withTotals(e));
});
router.post("/entries", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {};
  if (!b.journalCode || !jrOf(req, b.journalCode)) return res.status(400).json({ error: "Journal obligatoire" });
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && l.account && (R2(l.debit) || R2(l.credit)))
    .map(l => ({ id: l.id || id("aln"), account: String(l.account), thirdParty: l.thirdParty || "", label: l.label || "", dueDate: l.dueDate || "", debit: R2(l.debit), credit: R2(l.credit), analytic: l.analytic || "" }));
  if (!lines.length) return res.status(400).json({ error: "Au moins une ligne mouvementée" });
  const period = b.period || (b.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const yy = period.slice(0, 4);
  const seq = mine(db.acctEntries, req).filter(e => e.journalCode === b.journalCode && (e.period || "").slice(0, 4) === yy).length + 1;
  const pieceNo = b.pieceNo || (b.journalCode + String(seq).padStart(3, "0"));
  const e = stamp({ id: id("aent"), journalCode: b.journalCode, period, pieceNo, date: b.date || new Date().toISOString().slice(0, 10),
    label: b.label || "", lines, status: "draft", source: b.source || "manual", sourceRef: b.sourceRef || "", createdAt: new Date().toISOString() }, req);
  db.acctEntries.push(e); save(); audit(req.user, "CREATED", "AcctEntry", e.id, { journal: b.journalCode, piece: pieceNo }); res.status(201).json(withTotals(e));
});
router.put("/entries/:id", allow("ADM", "CD"), (req, res) => {
  const e = mine(db.acctEntries, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Écriture introuvable" });
  if (e.status === "locked") return res.status(409).json({ error: "Écriture clôturée — verrouillée" });
  for (const k of ["date", "label", "pieceNo", "period"]) if (req.body[k] !== undefined) e[k] = req.body[k];
  if (Array.isArray(req.body.lines)) e.lines = req.body.lines.filter(l => l && l.account && (R2(l.debit) || R2(l.credit)))
    .map(l => ({ id: l.id || id("aln"), account: String(l.account), thirdParty: l.thirdParty || "", label: l.label || "", dueDate: l.dueDate || "", debit: R2(l.debit), credit: R2(l.credit), analytic: l.analytic || "" }));
  save(); res.json(withTotals(e));
});
router.post("/entries/:id/validate", allow("ADM", "CD"), (req, res) => {
  const e = mine(db.acctEntries, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Écriture introuvable" });
  if (e.status === "locked") return res.status(409).json({ error: "Écriture verrouillée" });
  const t = entryTotals(e);
  if (e.status !== "validated" && !t.balanced) return res.status(400).json({ error: `Écriture non équilibrée : Débit ${t.debit} ≠ Crédit ${t.credit}` });
  e.status = e.status === "validated" ? "draft" : "validated"; save();
  audit(req.user, "VALIDATED", "AcctEntry", e.id, { status: e.status }); res.json(withTotals(e));
});
router.delete("/entries/:id", allow("ADM", "CD"), (req, res) => {
  const e = mine(db.acctEntries, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Écriture introuvable" });
  if (e.status === "locked") return res.status(409).json({ error: "Écriture verrouillée" });
  db.acctEntries.splice(db.acctEntries.indexOf(e), 1); save(); res.json({ ok: true });
});

/* ============================ BALANCE ============================ */
router.get("/balance", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const onlyValidated = req.query.all !== "1";
  const accs = {}; for (const a of mine(db.acctAccounts, req)) accs[a.number] = a.label;
  const agg = {};
  for (const e of mine(db.acctEntries, req)) {
    if (onlyValidated && e.status === "draft") continue;
    if (req.query.period && (e.period || "") !== req.query.period) continue;
    for (const l of (e.lines || [])) {
      const a = (agg[l.account] = agg[l.account] || { account: l.account, label: accs[l.account] || "", debit: 0, credit: 0 });
      a.debit += R2(l.debit); a.credit += R2(l.credit);
    }
  }
  const rows = Object.values(agg).sort((x, y) => x.account.localeCompare(y.account)).map(a => Object.assign(a, { solde: a.debit - a.credit }));
  const totalD = rows.reduce((s, r) => s + r.debit, 0), totalC = rows.reduce((s, r) => s + r.credit, 0);
  res.json({ rows, totalDebit: totalD, totalCredit: totalC, balanced: totalD === totalC });
});

/* ==================== C2 — GÉNÉRATION AUTO (Facturation & Paie) ==================== */
function postEntry(req, e) {
  const tid = req.user.tenantId || "t1"; seedAccounting(tid);
  const period = e.period || (e.date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const yy = period.slice(0, 4);
  const seq = mine(db.acctEntries, req).filter(x => x.journalCode === e.journalCode && (x.period || "").slice(0, 4) === yy).length + 1;
  const rec = stamp(Object.assign({ id: id("aent"), period, pieceNo: e.pieceNo || (e.journalCode + String(seq).padStart(3, "0")), status: "validated" }, e, { createdAt: new Date().toISOString() }), req);
  db.acctEntries.push(rec); save(); return rec;
}
function invTotalsQ(inv) {
  const HT = (inv.lines || []).filter(l => l.type === "product").reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.pu) || 0), 0);
  const tva = inv.tvaExonere ? 0 : HT * (inv.tvaRate != null ? inv.tvaRate : 0.1925);
  const is = inv.isRate ? HT * inv.isRate : 0;
  return { HT: R2(HT), TVA: R2(tva), IS: R2(is) };
}
function generateInvoiceEntry(req, invId) {
  const inv = mine(db.billingInvoices, req).find(x => x.id === invId); if (!inv) return null;
  if (inv.acctEntryId) { const ex = mine(db.acctEntries, req).find(x => x.id === inv.acctEntryId); if (ex) return ex; }
  const contract = mine(db.billingContracts, req).find(c => c.id === inv.contractId) || {};
  const t = invTotalsQ(inv); if (!t.HT && !t.TVA) return null;
  const prodAcc = contract.defaultAccount || "701100", cc = contract.clientCode || "";
  const lines = [{ account: "411100", thirdParty: cc, label: "Facture " + inv.number, debit: R2(t.HT + t.TVA - t.IS), credit: 0 }];
  if (t.IS) lines.push({ account: "447110", thirdParty: "", label: "IS retenue", debit: t.IS, credit: 0 });
  lines.push({ account: prodAcc, thirdParty: "", label: "Prestation " + inv.number, debit: 0, credit: t.HT });
  if (t.TVA) lines.push({ account: "443100", thirdParty: "", label: "TVA collectée", debit: 0, credit: t.TVA });
  const e = postEntry(req, { journalCode: "VTE", date: inv.date || new Date().toISOString().slice(0, 10), period: inv.period, label: "Facture " + inv.number + " — " + (inv.client || ""), lines, source: "facturation", sourceRef: inv.id });
  inv.acctEntryId = e.id; save(); audit(req.user, "POSTED", "AcctEntry", e.id, { from: "invoice", invoice: inv.number }); return e;
}
function generatePayrollEntry(req, runId) {
  const run = mine(db.payRuns, req).find(r => r.id === runId); if (!run) return null;
  if (run.acctEntryId) { const ex = mine(db.acctEntries, req).find(x => x.id === run.acctEntryId); if (ex) return ex; }
  const slips = mine(db.payslips, req).filter(s => s.runId === runId);
  let brut = 0, chp = 0, net = 0, ret = 0, imp = 0;
  for (const s of slips) { const t = (s.result && s.result.totals) || {}; brut += t.brutTotal || 0; chp += t.chargesPatronales || 0; net += t.netAPayer || 0; ret += t.totalRetenues || 0; imp += t.totalImpots || 0; }
  brut = R2(brut); chp = R2(chp); net = R2(net); ret = R2(ret); imp = R2(imp); if (!brut) return null;
  const social = R2((ret - imp) + chp);
  const lines = [{ account: "661000", thirdParty: "", label: "Rémunérations " + run.period, debit: brut, credit: 0 }];
  if (chp) lines.push({ account: "664000", thirdParty: "", label: "Charges sociales patronales", debit: chp, credit: 0 });
  lines.push({ account: "421000", thirdParty: "", label: "Net à payer", debit: 0, credit: net });
  if (imp) lines.push({ account: "447130", thirdParty: "", label: "État, impôts sur salaires", debit: 0, credit: imp });
  if (social) lines.push({ account: "431000", thirdParty: "", label: "Organismes sociaux", debit: 0, credit: social });
  const e = postEntry(req, { journalCode: "PAIE", date: (run.period || "") + "-28", period: run.period, label: "Paie " + run.period, lines, source: "paie", sourceRef: run.id });
  run.acctEntryId = e.id; save(); audit(req.user, "POSTED", "AcctEntry", e.id, { from: "payroll", period: run.period }); return e;
}
router.post("/generate/invoice/:id", allow("ADM", "CD"), (req, res) => { const e = generateInvoiceEntry(req, req.params.id); if (!e) return res.status(400).json({ error: "Facture introuvable ou sans montant" }); res.json(withTotals(e)); });
router.post("/generate/payroll/:runId", allow("ADM", "CD"), (req, res) => { const e = generatePayrollEntry(req, req.params.runId); if (!e) return res.status(400).json({ error: "Run introuvable ou vide" }); res.json(withTotals(e)); });


/* ==================== C3 — ÉTATS (grand-livre, journal, balance âgée) ==================== */
function _accLabel(req) { const m = {}; for (const a of mine(db.acctAccounts, req)) m[a.number] = a.label; return m; }
router.get("/ledger", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const acc = req.query.account; if (!acc) return res.status(400).json({ error: "Compte requis" });
  const onlyVal = req.query.all !== "1"; const labels = _accLabel(req);
  const rows = [];
  for (const e of mine(db.acctEntries, req)) { if (onlyVal && e.status === "draft") continue; if (req.query.period && (e.period || "") !== req.query.period) continue;
    for (const l of (e.lines || [])) if (l.account === acc) rows.push({ date: e.date, journal: e.journalCode, piece: e.pieceNo, thirdParty: l.thirdParty || "", label: l.label || e.label || "", debit: R2(l.debit), credit: R2(l.credit) }); }
  rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let solde = 0, td = 0, tc = 0; for (const r of rows) { solde += r.debit - r.credit; r.solde = solde; td += r.debit; tc += r.credit; }
  res.json({ account: acc, label: labels[acc] || "", rows, totalDebit: td, totalCredit: tc, solde });
});
router.get("/journal-report", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const onlyVal = req.query.all !== "1"; const rows = [];
  for (const e of mine(db.acctEntries, req)) { if (onlyVal && e.status === "draft") continue;
    if (req.query.journal && e.journalCode !== req.query.journal) continue; if (req.query.period && (e.period || "") !== req.query.period) continue;
    for (const l of (e.lines || [])) rows.push({ date: e.date, journal: e.journalCode, piece: e.pieceNo, account: l.account, thirdParty: l.thirdParty || "", label: l.label || e.label || "", debit: R2(l.debit), credit: R2(l.credit) }); }
  rows.sort((a, b) => (a.journal + a.piece).localeCompare(b.journal + b.piece));
  const td = rows.reduce((s, r) => s + r.debit, 0), tc = rows.reduce((s, r) => s + r.credit, 0);
  res.json({ rows, totalDebit: td, totalCredit: tc });
});
router.get("/aged", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const prefix = req.query.kind === "fournisseur" ? "401" : "411";
  const now = new Date(); const by = {};
  for (const e of mine(db.acctEntries, req)) { if (e.status === "draft") continue;
    for (const l of (e.lines || [])) { if (!String(l.account).startsWith(prefix)) continue;
      const key = (l.thirdParty || l.account); const g = (by[key] = by[key] || { tp: key, b0: 0, b30: 0, b60: 0, b90: 0, total: 0 });
      const mv = R2(l.debit) - R2(l.credit); g.total += mv;
      const due = l.dueDate ? new Date(l.dueDate) : (e.date ? new Date(e.date) : now);
      const days = Math.floor((now - due) / 86400000);
      if (days <= 30) g.b0 += mv; else if (days <= 60) g.b30 += mv; else if (days <= 90) g.b60 += mv; else g.b90 += mv; } }
  const rows = Object.values(by).filter(r => Math.abs(r.total) > 0).sort((a, b) => String(a.tp).localeCompare(String(b.tp)));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  res.json({ rows, totals: { b0: sum("b0"), b30: sum("b30"), b60: sum("b60"), b90: sum("b90"), total: sum("total") } });
});


/* ==================== C4 — TVA & états légaux (OHADA) ==================== */
function aggByAccount(req, period) {
  const agg = {};
  for (const e of mine(db.acctEntries, req)) { if (e.status === "draft") continue; if (period && (e.period || "") !== period) continue;
    for (const l of (e.lines || [])) { const a = (agg[l.account] = agg[l.account] || { debit: 0, credit: 0 }); a.debit += R2(l.debit); a.credit += R2(l.credit); } }
  return agg;
}
router.get("/vat", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1"); const agg = aggByAccount(req, req.query.period);
  let collectee = 0, deductible = 0;
  for (const [acc, v] of Object.entries(agg)) { if (acc.startsWith("443")) collectee += (v.credit - v.debit); if (acc.startsWith("445")) deductible += (v.debit - v.credit); }
  collectee = R2(collectee); deductible = R2(deductible); const net = collectee - deductible;
  res.json({ period: req.query.period || "toutes", collectee, deductible, aPayer: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
});
router.get("/income-statement", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1"); const agg = aggByAccount(req, req.query.period); const labels = _accLabel(req);
  const charges = [], produits = []; let tc = 0, tp = 0;
  for (const [acc, v] of Object.entries(agg)) {
    if (acc[0] === "6") { const m = v.debit - v.credit; if (m) { charges.push({ account: acc, label: labels[acc] || "", amount: R2(m) }); tc += m; } }
    if (acc[0] === "7") { const m = v.credit - v.debit; if (m) { produits.push({ account: acc, label: labels[acc] || "", amount: R2(m) }); tp += m; } }
  }
  charges.sort((a, b) => a.account.localeCompare(b.account)); produits.sort((a, b) => a.account.localeCompare(b.account));
  res.json({ period: req.query.period || "toutes", produits, charges, totalProduits: R2(tp), totalCharges: R2(tc), resultat: R2(tp - tc) });
});
router.get("/balance-sheet", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1"); const agg = aggByAccount(req, req.query.period);
  let immobA = 0, circA = 0, tresoA = 0, capP = 0, dettesP = 0, tresoP = 0, prod = 0, charge = 0;
  for (const [acc, v] of Object.entries(agg)) { const solde = v.debit - v.credit; const cl = acc[0];
    if (cl === "7") prod += -solde; else if (cl === "6") charge += solde;
    else if (cl === "2") immobA += solde;
    else if (cl === "3") circA += solde;
    else if (cl === "4") { if (solde >= 0) circA += solde; else dettesP += -solde; }
    else if (cl === "5") { if (solde >= 0) tresoA += solde; else tresoP += -solde; }
    else if (cl === "1") { if (solde <= 0) capP += -solde; else dettesP += solde; }
  }
  const resultat = R2(prod - charge); capP += resultat;
  const actif = R2(immobA) + R2(circA) + R2(tresoA);
  const passif = R2(capP) + R2(dettesP) + R2(tresoP);
  res.json({ period: req.query.period || "toutes",
    actif: { immobilise: R2(immobA), circulant: R2(circA), tresorerie: R2(tresoA), total: actif },
    passif: { capitauxPropres: R2(capP), dettes: R2(dettesP), tresorerie: R2(tresoP), total: passif },
    resultat, equilibre: actif === passif });
});


/* ==================== C5 — Clôture & fiscal (lettrage, clôture, FEC) ==================== */
router.post("/entries/:id/lock", allow("ADM"), (req, res) => {
  const e = mine(db.acctEntries, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Introuvable" });
  if (e.status !== "validated") return res.status(400).json({ error: "Validez d'abord l'écriture" });
  e.status = "locked"; save(); res.json(withTotals(e));
});
router.post("/journals/:code/close", allow("ADM"), (req, res) => {
  const period = (req.body || {}).period; let n = 0;
  for (const e of mine(db.acctEntries, req)) { if (e.journalCode !== req.params.code) continue; if (period && (e.period || "") !== period) continue; if (e.status === "validated") { e.status = "locked"; n++; } }
  save(); audit(req.user, "CLOSED", "AcctJournal", req.params.code, { period, locked: n }); res.json({ ok: true, locked: n });
});
router.post("/lettrage", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {}; const acc = b.account; const refs = Array.isArray(b.lines) ? b.lines : [];
  if (!acc || refs.length < 2) return res.status(400).json({ error: "Compte + au moins 2 lignes" });
  let sum = 0; const targets = [];
  for (const r of refs) { const e = mine(db.acctEntries, req).find(x => x.id === r.entryId); if (!e) continue; const l = (e.lines || []).find(x => x.id === r.lineId && x.account === acc); if (l) { targets.push(l); sum += R2(l.debit) - R2(l.credit); } }
  if (R2(sum) !== 0) return res.status(400).json({ error: "Lignes non soldées (somme ≠ 0)" });
  const used = new Set(); for (const e of mine(db.acctEntries, req)) for (const l of (e.lines || [])) if (l.account === acc && l.lettre) used.add(l.lettre);
  let code = "A"; while (used.has(code)) code = String.fromCharCode(code.charCodeAt(0) + 1);
  targets.forEach(l => l.lettre = code); save(); res.json({ ok: true, lettre: code });
});
function closeExercise(req, exId) {
  const ex = mine(db.acctExercises, req).find(e => e.id === exId); if (!ex) return { error: "Exercice introuvable" };
  if (ex.status === "closed") return { error: "Exercice déjà clôturé" };
  const yy = String(ex.year);
  const entries = mine(db.acctEntries, req).filter(e => (e.period || "").slice(0, 4) === yy);
  entries.forEach(e => { if (e.status === "validated") e.status = "locked"; });
  const agg = {}; for (const e of entries) { if (e.status === "draft") continue; for (const l of (e.lines || [])) { const a = (agg[l.account] = agg[l.account] || { d: 0, c: 0 }); a.d += R2(l.debit); a.c += R2(l.credit); } }
  // Solde de gestion : classes 6 & 7 -> 130100 (résultat)
  const cloLines = [];
  for (const [acc, v] of Object.entries(agg)) { const solde = v.d - v.c; const cl = acc[0];
    if (cl === "6" && solde) cloLines.push({ account: acc, label: "Solde de clôture", debit: 0, credit: R2(solde) });
    if (cl === "7" && solde) cloLines.push({ account: acc, label: "Solde de clôture", debit: R2(-solde), credit: 0 }); }
  let resultat = 0;
  if (cloLines.length) { const d = cloLines.reduce((s, l) => s + l.debit, 0), c = cloLines.reduce((s, l) => s + l.credit, 0); const diff = c - d; resultat = R2(diff);
    cloLines.push(diff >= 0 ? { account: "130100", label: "Résultat de l'exercice", debit: R2(diff), credit: 0 } : { account: "130100", label: "Résultat de l'exercice", debit: 0, credit: R2(-diff) });
    postEntry(req, { journalCode: "CLO", date: yy + "-12-31", period: yy + "-12", label: "Clôture — soldes de gestion " + yy, lines: cloLines, source: "cloture", sourceRef: ex.id, status: "locked" }); }
  // Report à nouveau : classes 1-5 -> exercice suivant (journal AN)
  let next = mine(db.acctExercises, req).find(e => e.year === ex.year + 1);
  if (!next) { next = stamp({ id: id("acc"), year: ex.year + 1, start: (ex.year + 1) + "-01-01", end: (ex.year + 1) + "-12-31", status: "open", current: false, createdAt: new Date().toISOString() }, req); db.acctExercises.push(next); }
  const anLines = [];
  for (const [acc, v] of Object.entries(agg)) { const cl = acc[0]; if (cl === "6" || cl === "7") continue; const solde = v.d - v.c; if (!solde) continue; anLines.push(solde > 0 ? { account: acc, label: "À-nouveau", debit: R2(solde), credit: 0 } : { account: acc, label: "À-nouveau", debit: 0, credit: R2(-solde) }); }
  if (anLines.length) { const d = anLines.reduce((s, l) => s + l.debit, 0), c = anLines.reduce((s, l) => s + l.credit, 0); const diff = d - c;
    if (diff) anLines.push(diff > 0 ? { account: "130100", label: "Résultat reporté", debit: 0, credit: R2(diff) } : { account: "130100", label: "Résultat reporté", debit: R2(-diff), credit: 0 });
    postEntry(req, { journalCode: "AN", date: (ex.year + 1) + "-01-01", period: (ex.year + 1) + "-01", label: "À-nouveaux " + (ex.year + 1), lines: anLines, source: "cloture", sourceRef: ex.id, status: "validated" }); }
  ex.status = "closed"; ex.current = false; next.current = true; save();
  audit(req.user, "CLOSED_EXERCISE", "AcctExercise", ex.id, { year: ex.year, resultat }); return { ok: true, resultat, exercise: ex, next };
}
router.post("/exercises/:id/close", allow("ADM"), (req, res) => { const r = closeExercise(req, req.params.id); if (r.error) return res.status(400).json(r); res.json(r); });
router.get("/fec", allow("ADM", "CD"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1"); const labels = _accLabel(req); const jr = {}; for (const j of mine(db.acctJournals, req)) jr[j.code] = j.label;
  const yy = req.query.year || String(new Date().getFullYear()); const fd = d => String(d || "").replace(/-/g, "");
  const head = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise"];
  const rows = [head];
  for (const e of mine(db.acctEntries, req)) { if (e.status === "draft") continue; if ((e.period || "").slice(0, 4) !== yy) continue;
    for (const l of (e.lines || [])) rows.push([e.journalCode, jr[e.journalCode] || "", e.pieceNo, fd(e.date), l.account, labels[l.account] || "", l.thirdParty || "", "", e.pieceNo, fd(e.date), String(l.label || e.label || "").replace(/[\t\r\n]/g, " "), String(R2(l.debit)), String(R2(l.credit)), l.lettre || "", "", fd(e.date), "0", ""]); }
  res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="FEC_${yy}.txt"`);
  res.send(rows.map(r => r.join("\t")).join("\r\n"));
});


/* ==================== C6 — Analytique & budget ==================== */
router.get("/analytic-balance", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1"); const by = {};
  for (const e of mine(db.acctEntries, req)) { if (e.status === "draft") continue; if (req.query.period && (e.period || "") !== req.query.period) continue;
    for (const l of (e.lines || [])) { const code = l.analytic || "(non ventilé)"; const g = (by[code] = by[code] || { code, debit: 0, credit: 0 }); g.debit += R2(l.debit); g.credit += R2(l.credit); } }
  const rows = Object.values(by).map(r => Object.assign(r, { solde: r.debit - r.credit })).sort((a, b) => a.code.localeCompare(b.code));
  res.json({ rows });
});
router.get("/budgets", allow("ADM", "CD", "RJ"), (req, res) => res.json(mine(db.acctBudgets, req)));
router.post("/budgets", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {}; if (!b.account || !b.year) return res.status(400).json({ error: "Compte + année obligatoires" });
  let x = mine(db.acctBudgets, req).find(r => r.account === b.account && Number(r.year) === Number(b.year));
  if (x) { x.amount = R2(b.amount); } else { x = stamp({ id: id("abud"), account: b.account, year: Number(b.year), amount: R2(b.amount), createdAt: new Date().toISOString() }, req); db.acctBudgets.push(x); }
  save(); res.json(x);
});
router.get("/budget-actual", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1"); const yy = String(req.query.year || new Date().getFullYear());
  const labels = _accLabel(req); const actual = {};
  for (const e of mine(db.acctEntries, req)) { if (e.status === "draft") continue; if ((e.period || "").slice(0, 4) !== yy) continue;
    for (const l of (e.lines || [])) { const a = l.account; if (a[0] !== "6" && a[0] !== "7") continue; const s = (actual[a] = actual[a] || 0); actual[a] = s + (a[0] === "6" ? (R2(l.debit) - R2(l.credit)) : (R2(l.credit) - R2(l.debit))); } }
  const budgets = mine(db.acctBudgets, req).filter(b => Number(b.year) === Number(yy));
  const keys = new Set([...Object.keys(actual), ...budgets.map(b => b.account)]);
  const rows = [...keys].sort().map(acc => { const bud = R2((budgets.find(b => b.account === acc) || {}).amount || 0); const act = R2(actual[acc] || 0); return { account: acc, label: labels[acc] || "", budget: bud, actual: act, ecart: act - bud }; });
  res.json({ year: yy, rows });
});

/* ==================== Comptes tiers (soldes en direct) ==================== */
router.get("/third-parties-usage", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const defined = {}; for (const t of mine(db.acctThirdParties, req)) defined[t.code] = t;
  const agg = {};
  for (const e of mine(db.acctEntries, req)) {
    if (e.status === "draft") continue;
    for (const l of (e.lines || [])) {
      const tp = l.thirdParty; if (!tp) continue;
      const acc = String(l.account);
      const kind = acc.startsWith("401") ? "fournisseur" : acc.startsWith("411") ? "client" : "autre";
      const g = (agg[tp] = agg[tp] || { code: tp, kind, debit: 0, credit: 0, count: 0 });
      g.debit += R2(l.debit); g.credit += R2(l.credit); g.count++;
    }
  }
  const rows = Object.values(agg).map(g => { const d = defined[g.code] || {}; return Object.assign({ name: d.name || "", collectiveAccount: d.collectiveAccount || "", terms: d.terms || "", defined: !!defined[g.code], solde: g.debit - g.credit }, g); });
  for (const t of mine(db.acctThirdParties, req)) if (!agg[t.code]) rows.push({ code: t.code, name: t.name || "", kind: t.kind || "", collectiveAccount: t.collectiveAccount || "", terms: t.terms || "", defined: true, debit: 0, credit: 0, count: 0, solde: 0 });
  rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  res.json(rows);
});

/* ==================== Relevé / grand-livre par tiers (États tiers) ==================== */
router.get("/tiers-ledger", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const tp = (req.query.tp || "").toString(); if (!tp) return res.status(400).json({ error: "Tiers requis" });
  const onlyVal = req.query.all !== "1"; const labels = _accLabel(req); const rows = [];
  for (const e of mine(db.acctEntries, req)) {
    if (onlyVal && e.status === "draft") continue;
    for (const l of (e.lines || [])) if ((l.thirdParty || "") === tp) rows.push({ date: e.date, journal: e.journalCode, piece: e.pieceNo, account: l.account, accLabel: labels[l.account] || "", label: l.label || e.label || "", dueDate: l.dueDate || "", debit: R2(l.debit), credit: R2(l.credit), lettre: l.lettre || "" });
  }
  rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let solde = 0, td = 0, tc = 0; for (const r of rows) { solde += r.debit - r.credit; r.solde = solde; td += r.debit; tc += r.credit; }
  const t = mine(db.acctThirdParties, req).find(x => x.code === tp) || {};
  res.json({ tp, name: t.name || "", rows, totalDebit: td, totalCredit: tc, solde });
});

/* ==================== Recherche d'écritures (multi-critères) ==================== */
router.get("/entries-search", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const q = req.query || {};
  const onlyVal = q.all !== "1";
  const txt = (q.q || "").toString().trim().toLowerCase();
  const acc = (q.account || "").toString().trim();
  const tp = (q.thirdParty || "").toString().trim().toLowerCase();
  const jr = (q.journal || "").toString().trim();
  const df = (q.dateFrom || "").toString(); const dt = (q.dateTo || "").toString();
  const mn = (q.min !== undefined && q.min !== "") ? Number(q.min) : null;
  const mx = (q.max !== undefined && q.max !== "") ? Number(q.max) : null;
  const rows = [];
  for (const e of mine(db.acctEntries, req)) {
    if (onlyVal && e.status === "draft") continue;
    if (jr && e.journalCode !== jr) continue;
    if (df && (e.date || "") < df) continue;
    if (dt && (e.date || "") > dt) continue;
    for (const l of (e.lines || [])) {
      if (acc && !String(l.account).startsWith(acc)) continue;
      if (tp && !String(l.thirdParty || "").toLowerCase().includes(tp)) continue;
      const amt = Math.max(R2(l.debit), R2(l.credit));
      if (mn !== null && amt < mn) continue;
      if (mx !== null && amt > mx) continue;
      if (txt) { const hay = ((l.label || "") + " " + (e.label || "") + " " + (e.pieceNo || "") + " " + (l.thirdParty || "") + " " + (l.account || "")).toLowerCase(); if (!hay.includes(txt)) continue; }
      rows.push({ entryId: e.id, date: e.date, journal: e.journalCode, piece: e.pieceNo, status: e.status, account: String(l.account), thirdParty: l.thirdParty || "", label: l.label || e.label || "", debit: R2(l.debit), credit: R2(l.credit) });
    }
  }
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (a.journal + a.piece).localeCompare(b.journal + b.piece));
  const cap = rows.slice(0, 1000);
  res.json({ rows: cap, count: rows.length, capped: rows.length > 1000, totalDebit: cap.reduce((s, r) => s + r.debit, 0), totalCredit: cap.reduce((s, r) => s + r.credit, 0) });
});

/* ==================== C5b — Rapprochement bancaire ==================== */
// Book-side movements on a bank/cash account (validated entries only)
function bankBookLines(req, account) {
  const rows = [];
  const matches = mine(db.acctBankMatches, req).filter(m => m.account === account);
  const pointedLine = new Set(matches.map(m => m.lineId));
  for (const e of mine(db.acctEntries, req)) {
    if (e.status === "draft") continue;
    for (const l of (e.lines || [])) if (String(l.account) === String(account))
      rows.push({ entryId: e.id, lineId: l.id, date: e.date, journal: e.journalCode, piece: e.pieceNo, label: l.label || e.label || "", thirdParty: l.thirdParty || "", net: R2(l.debit) - R2(l.credit), pointed: pointedLine.has(l.id) });
  }
  rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return rows;
}
router.get("/bank/lines", allow("ADM", "CD", "RJ"), (req, res) => {
  const account = req.query.account; if (!account) return res.status(400).json({ error: "Compte requis" });
  const matched = new Set(mine(db.acctBankMatches, req).filter(m => m.account === account).map(m => m.bankLineId));
  const rows = mine(db.acctBankLines, req).filter(b => b.account === account)
    .map(b => Object.assign({}, b, { matched: matched.has(b.id) }))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  res.json(rows);
});
router.get("/bank/book", allow("ADM", "CD", "RJ"), (req, res) => {
  const account = req.query.account; if (!account) return res.status(400).json({ error: "Compte requis" });
  res.json(bankBookLines(req, account));
});
router.post("/bank/import", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {}; const account = b.account; if (!account) return res.status(400).json({ error: "Compte requis" });
  const statementId = id("bstm");
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && (l.date || l.label) && (R2(l.amount) !== 0 || l.amount === 0 && (l.label || "")));
  let n = 0;
  for (const l of lines) {
    if (R2(l.amount) === 0 && !l.label) continue;
    db.acctBankLines.push(stamp({ id: id("bln"), account, statementId, date: (l.date || "").slice(0, 10), label: String(l.label || "").slice(0, 200), ref: String(l.ref || "").slice(0, 60), amount: R2(l.amount), createdAt: new Date().toISOString() }, req));
    n++;
  }
  if (b.closingBalance !== undefined && b.closingBalance !== "") { const ex = mine(db.acctBankLines, req); /* store closing on nothing */ }
  save(); audit(req.user, "IMPORTED", "BankStatement", statementId, { account, count: n });
  res.status(201).json({ ok: true, count: n, statementId });
});
router.delete("/bank/lines/:id", allow("ADM", "CD"), (req, res) => {
  const x = mine(db.acctBankLines, req).find(b => b.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
  db.acctBankLines.splice(db.acctBankLines.indexOf(x), 1);
  for (const m of mine(db.acctBankMatches, req).filter(m => m.bankLineId === x.id)) db.acctBankMatches.splice(db.acctBankMatches.indexOf(m), 1);
  save(); res.json({ ok: true });
});
router.post("/bank/clear", allow("ADM", "CD"), (req, res) => {
  const account = req.query.account || (req.body || {}).account; if (!account) return res.status(400).json({ error: "Compte requis" });
  db.acctBankLines = db.acctBankLines.filter(b => !((b.tenantId || "t1") === (req.user.tenantId || "t1") && b.account === account));
  db.acctBankMatches = db.acctBankMatches.filter(m => !((m.tenantId || "t1") === (req.user.tenantId || "t1") && m.account === account));
  save(); res.json({ ok: true });
});
router.post("/bank/match", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {}; if (!b.account || !b.bankLineId || !b.lineId) return res.status(400).json({ error: "account, bankLineId, lineId requis" });
  if (mine(db.acctBankMatches, req).some(m => m.bankLineId === b.bankLineId || m.lineId === b.lineId)) return res.status(409).json({ error: "Déjà pointé" });
  db.acctBankMatches.push(stamp({ id: id("bmt"), account: b.account, bankLineId: b.bankLineId, entryId: b.entryId || "", lineId: b.lineId, date: new Date().toISOString() }, req));
  save(); res.json({ ok: true });
});
router.post("/bank/unmatch", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {}; const list = mine(db.acctBankMatches, req).filter(m => (b.bankLineId && m.bankLineId === b.bankLineId) || (b.lineId && m.lineId === b.lineId));
  if (!list.length) return res.status(404).json({ error: "Aucun pointage" });
  for (const m of list) db.acctBankMatches.splice(db.acctBankMatches.indexOf(m), 1);
  save(); res.json({ ok: true, removed: list.length });
});
router.post("/bank/auto", allow("ADM", "CD"), (req, res) => {
  const b = req.body || {}; const account = b.account; if (!account) return res.status(400).json({ error: "Compte requis" });
  const tol = Number(b.tolDays != null ? b.tolDays : 5);
  const book = bankBookLines(req, account).filter(l => !l.pointed);
  const matchedBank = new Set(mine(db.acctBankMatches, req).filter(m => m.account === account).map(m => m.bankLineId));
  const bank = mine(db.acctBankLines, req).filter(l => l.account === account && !matchedBank.has(l.id));
  const usedBook = new Set(); let n = 0;
  for (const bl of bank) {
    let best = null, bestDiff = Infinity;
    for (const bk of book) {
      if (usedBook.has(bk.lineId)) continue;
      if (bk.net !== bl.amount) continue;
      const dd = Math.abs((new Date(bl.date) - new Date(bk.date)) / 86400000);
      if (dd <= tol && dd < bestDiff) { best = bk; bestDiff = dd; }
    }
    if (best) { db.acctBankMatches.push(stamp({ id: id("bmt"), account, bankLineId: bl.id, entryId: best.entryId, lineId: best.lineId, date: new Date().toISOString() }, req)); usedBook.add(best.lineId); n++; }
  }
  save(); res.json({ ok: true, matched: n });
});
router.get("/bank/reconcile", allow("ADM", "CD", "RJ"), (req, res) => {
  const account = req.query.account; if (!account) return res.status(400).json({ error: "Compte requis" });
  const closing = req.query.closingBalance !== undefined && req.query.closingBalance !== "" ? R2(req.query.closingBalance) : null;
  const book = bankBookLines(req, account);
  const bankMatched = new Set(mine(db.acctBankMatches, req).filter(m => m.account === account).map(m => m.bankLineId));
  const bank = mine(db.acctBankLines, req).filter(b => b.account === account);
  const soldeComptable = book.reduce((s, l) => s + l.net, 0);
  const unpointedBook = book.filter(l => !l.pointed).reduce((s, l) => s + l.net, 0);
  const unpointedBank = bank.filter(b => !bankMatched.has(b.id)).reduce((s, b) => s + b.amount, 0);
  const soldeReleveTheorique = soldeComptable - unpointedBook + unpointedBank;
  const ecart = closing === null ? null : R2(soldeReleveTheorique - closing);
  res.json({
    account, soldeComptable: R2(soldeComptable), unpointedBook: R2(unpointedBook), unpointedBank: R2(unpointedBank),
    soldeReleveTheorique: R2(soldeReleveTheorique), closingBalance: closing, ecart,
    bookCount: book.length, bookPointed: book.filter(l => l.pointed).length,
    bankCount: bank.length, bankPointed: bank.filter(b => bankMatched.has(b.id)).length
  });
});

/* ==================== États tiers — grand-livre consolidé ==================== */
router.get("/tiers-ledger-all", allow("ADM", "CD", "RJ"), (req, res) => {
  seedAccounting(req.user.tenantId || "t1");
  const kind = req.query.kind || "all"; const onlyVal = req.query.all !== "1";
  const ref = {}; for (const t of mine(db.acctThirdParties, req)) ref[t.code] = t;
  const groups = {};
  for (const e of mine(db.acctEntries, req)) {
    if (onlyVal && e.status === "draft") continue;
    for (const l of (e.lines || [])) {
      const tp = l.thirdParty; if (!tp) continue;
      const acc = String(l.account);
      const k = acc.startsWith("401") ? "fournisseur" : acc.startsWith("411") ? "client" : "autre";
      if (kind !== "all" && k !== kind) continue;
      const g = (groups[tp] = groups[tp] || { code: tp, name: (ref[tp] || {}).name || "", kind: k, rows: [], debit: 0, credit: 0 });
      g.rows.push({ date: e.date, journal: e.journalCode, piece: e.pieceNo, account: l.account, label: l.label || e.label || "", dueDate: l.dueDate || "", lettre: l.lettre || "", debit: R2(l.debit), credit: R2(l.credit) });
      g.debit += R2(l.debit); g.credit += R2(l.credit);
    }
  }
  const out = Object.values(groups).map(g => { g.rows.sort((a, b) => (a.date || "").localeCompare(b.date || "")); let sd = 0; for (const r of g.rows) { sd += r.debit - r.credit; r.solde = sd; } g.solde = g.debit - g.credit; return g; })
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const totals = { debit: out.reduce((s, g) => s + g.debit, 0), credit: out.reduce((s, g) => s + g.credit, 0) };
  res.json({ groups: out, totals: Object.assign(totals, { solde: totals.debit - totals.credit }), count: out.length });
});

module.exports = router;
module.exports.seedAccounting = seedAccounting;
module.exports.generateInvoiceEntry = generateInvoiceEntry;
module.exports.generatePayrollEntry = generatePayrollEntry;
