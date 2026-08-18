/**
 * SGRHP — Comptabilité (Module Comptabilité, OHADA/SYSCOHADA).
 * Phase C1 : référentiels (plan comptable, journaux, taxes, tiers, exercices)
 * + saisie des écritures avec contrôle d'équilibre (Débit = Crédit) + balance.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

for (const k of ["acctAccounts", "acctJournals", "acctTaxes", "acctThirdParties", "acctEntries", "acctExercises"]) if (!db[k]) db[k] = [];

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

module.exports = router;
module.exports.seedAccounting = seedAccounting;
