/**
 * SGRHP — Facturation module routes (Module Facturation).
 * Contracts (per-client config) + components catalogue + monthly sheets (annexes)
 * with the parameterizable engine, and the consolidated monthly recap.
 * A client = configuration (no per-client code).
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const { computeSheet, DEFAULT_RATES } = require("../billing/engine");

for (const k of ["billingContracts", "billingComponents", "billingSheets"]) if (!db[k]) db[k] = [];

/* ---- montant en toutes lettres (français, francs CFA) ---- */
function enLettres(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return "zéro";
  const u = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const d = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];
  const deux = (x) => {
    if (x < 20) return u[x];
    const t = Math.floor(x / 10), r = x % 10; let s = "";
    if (t === 7 || t === 9) s = d[t] + "-" + u[10 + r];
    else { s = d[t]; if (r === 1 && t < 8) s += " et un"; else if (r > 0) s += "-" + u[r]; }
    if (t === 8 && r === 0) s += "s";
    return s;
  };
  const tri = (x) => {
    const c = Math.floor(x / 100), r = x % 100; let s = "";
    if (c > 0) s += (c > 1 ? u[c] + " " : "") + "cent" + (c > 1 && r === 0 ? "s" : "");
    if (r > 0) s += (s ? " " : "") + deux(r);
    return s;
  };
  const groups = []; let x = n; while (x > 0) { groups.push(x % 1000); x = Math.floor(x / 1000); }
  const out = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; if (g === 0) continue;
    if (i === 1) out.push(g === 1 ? "mille" : tri(g) + " mille");
    else if (i >= 2) out.push(tri(g) + " " + (i === 2 ? "million" : "milliard") + (g > 1 ? "s" : ""));
    else out.push(tri(g));
  }
  return out.join(" ");
}

const contractOf = (req, cid) => mine(db.billingContracts, req).find(c => c.id === cid);
function withCompute(sheet, req) {
  const contract = contractOf(req, sheet.contractId) || { billingType: "MAD", rates: {} };
  const computed = computeSheet(sheet, contract);
  return Object.assign({}, sheet, { computed, contract });
}

/* ============================ COMPONENTS ============================ */
router.get("/components", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => res.json(mine(db.billingComponents, req)));
router.post("/components", allow("ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.label) return res.status(400).json({ error: "Code et libellé obligatoires" });
  if (mine(db.billingComponents, req).some(c => c.code === b.code)) return res.status(409).json({ error: "Ce code existe déjà" });
  const c = stamp({ id: id("bcmp"), code: b.code, label: b.label, inputMode: b.inputMode || "montant",
    formula: b.formula || "FIXE", stage: b.stage || "PRIME", taux: b.taux != null ? Number(b.taux) : null,
    diviseur: b.diviseur != null ? Number(b.diviseur) : null, forfait: b.forfait != null ? Number(b.forfait) : null,
    order: b.order || 99, active: true, createdAt: new Date().toISOString() }, req);
  db.billingComponents.push(c); save();
  audit(req.user, "CREATED", "BillingComponent", c.id, { code: c.code });
  res.status(201).json(c);
});
router.put("/components/:id", allow("ADM"), (req, res) => {
  const c = mine(db.billingComponents, req).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Introuvable" });
  for (const k of ["label", "inputMode", "formula", "stage", "order", "active"]) if (req.body[k] !== undefined) c[k] = req.body[k];
  for (const k of ["taux", "diviseur", "forfait"]) if (req.body[k] !== undefined) c[k] = req.body[k] === null || req.body[k] === "" ? null : Number(req.body[k]);
  save(); audit(req.user, "UPDATED", "BillingComponent", c.id, {}); res.json(c);
});
router.delete("/components/:id", allow("ADM"), (req, res) => {
  const c = mine(db.billingComponents, req).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Introuvable" });
  db.billingComponents.splice(db.billingComponents.indexOf(c), 1); save(); res.json({ ok: true });
});

/* ============================ CONTRACTS ============================ */
router.get("/contracts", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) =>
  res.json(mine(db.billingContracts, req).slice().sort((a, b) => (a.clientName || "").localeCompare(b.clientName || ""))));
router.get("/contracts/:id", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const c = contractOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" }); res.json(c);
});
router.post("/contracts", allow("ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.clientName) return res.status(400).json({ error: "Nom du client obligatoire" });
  const c = stamp({ id: id("bctr"), clientCode: b.clientCode || b.clientName.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, ""),
    clientName: b.clientName, billingType: b.billingType || "MAD",
    clientBlock: b.clientBlock || {}, bankBlock: b.bankBlock || {},
    numberFormat: b.numberFormat || "CLIENT/AAAA/MM/####",
    prorate: b.prorate || "base", anciennete: b.anciennete !== false, tvaExonere: !!b.tvaExonere,
    rates: Object.assign({}, DEFAULT_RATES, b.rates || {}),
    components: Array.isArray(b.components) ? b.components : [],
    columnMapping: b.columnMapping || {}, createdAt: new Date().toISOString() }, req);
  db.billingContracts.push(c); save();
  audit(req.user, "CREATED", "BillingContract", c.id, { client: c.clientName });
  res.status(201).json(c);
});
router.put("/contracts/:id", allow("ADM"), (req, res) => {
  const c = contractOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  for (const k of ["clientCode", "clientName", "billingType", "numberFormat", "prorate", "anciennete", "tvaExonere", "clientBlock", "bankBlock", "components", "columnMapping"])
    if (b[k] !== undefined) c[k] = b[k];
  if (b.rates) c.rates = Object.assign({}, DEFAULT_RATES, c.rates || {}, b.rates);
  save(); audit(req.user, "UPDATED", "BillingContract", c.id, {}); res.json(c);
});
router.delete("/contracts/:id", allow("ADM"), (req, res) => {
  const c = contractOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" });
  if (mine(db.billingSheets, req).some(s => s.contractId === c.id)) return res.status(409).json({ error: "Des fiches existent pour ce client — supprimez-les d'abord" });
  db.billingContracts.splice(db.billingContracts.indexOf(c), 1); save(); res.json({ ok: true });
});

/* ============================ SHEETS (annexes) ============================ */
router.get("/sheets", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  let list = mine(db.billingSheets, req);
  if (req.query.period) list = list.filter(s => s.period === req.query.period);
  if (req.query.contractId) list = list.filter(s => s.contractId === req.query.contractId);
  const byId = {}; mine(db.billingContracts, req).forEach(c => byId[c.id] = c);
  res.json(list.map(s => { const t = withCompute(s, req).computed.totals;
    return { id: s.id, contractId: s.contractId, client: (byId[s.contractId] || {}).clientName || "", period: s.period,
      number: s.number, status: s.status, HT: t.HT, TVA: t.TVA, TTC: t.TTC, count: t.count }; })
    .sort((a, b) => (b.period || "").localeCompare(a.period) || (a.client || "").localeCompare(b.client)));
});
router.get("/sheets/:id", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  res.json(withCompute(s, req));
});
router.post("/sheets", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const b = req.body || {};
  const contract = contractOf(req, b.contractId);
  if (!contract) return res.status(400).json({ error: "Contrat client introuvable" });
  if (!/^\d{4}-\d{2}$/.test(b.period || "")) return res.status(400).json({ error: "Période AAAA-MM obligatoire" });
  if (mine(db.billingSheets, req).some(s => s.contractId === contract.id && s.period === b.period))
    return res.status(409).json({ error: "Une fiche existe déjà pour ce client et cette période" });
  const [yy, mm] = b.period.split("-");
  const seq = mine(db.billingSheets, req).filter(s => s.period === b.period).length + 1;
  const number = (contract.numberFormat || "CLIENT/AAAA/MM/####")
    .replace("CLIENT", contract.clientCode || "CLI").replace("AAAA", yy).replace("MM", mm).replace(/#+/, String(seq).padStart(4, "0"));
  const sheet = stamp({ id: id("bsht"), contractId: contract.id, period: b.period, number,
    status: "draft", lines: Array.isArray(b.lines) ? b.lines : [], createdAt: new Date().toISOString() }, req);
  db.billingSheets.push(sheet); save();
  audit(req.user, "CREATED", "BillingSheet", sheet.id, { client: contract.clientName, period: b.period });
  res.status(201).json(withCompute(sheet, req));
});
router.put("/sheets/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  if (s.status === "validated") return res.status(409).json({ error: "Fiche validée — lecture seule" });
  if (Array.isArray(req.body.lines)) s.lines = req.body.lines.map(l => Object.assign({ id: l.id || id("bln") }, l));
  save(); audit(req.user, "UPDATED", "BillingSheet", s.id, { lines: s.lines.length }); res.json(withCompute(s, req));
});
router.post("/sheets/:id/validate", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  s.status = s.status === "validated" ? "draft" : "validated"; save();
  audit(req.user, "VALIDATED", "BillingSheet", s.id, { status: s.status }); res.json({ ok: true, status: s.status });
});
router.delete("/sheets/:id", allow("ADM"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  db.billingSheets.splice(db.billingSheets.indexOf(s), 1); save(); res.json({ ok: true });
});

/* ---- Reprise du mois précédent (F3) : duplique les ressources ---- */
router.post("/sheets/:id/carry-forward", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const [yy, mm] = s.period.split("-").map(Number);
  const prevD = new Date(yy, mm - 2, 1); const prev = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, "0")}`;
  const src = mine(db.billingSheets, req).find(x => x.contractId === s.contractId && x.period === prev);
  if (!src) return res.status(404).json({ error: "Aucune fiche le mois précédent (" + prev + ")" });
  s.lines = (src.lines || []).map(l => Object.assign({}, l, { id: id("bln") }));
  save(); res.json(withCompute(s, req));
});

/* ---- Import depuis la Paie (lien RH) : pré-remplit les lignes MAD ---- */
router.post("/sheets/:id/import-payroll", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const pfId = (req.body || {}).portfolioId || null;
  const emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED" && (!pfId || e.portfolioId === pfId));
  const baseOf = (e) => { const sal = e.salary || {}; return Number(sal["Salaire de base"] || sal["SALAIRE DE BASE"] || e.baseSalary || 0); };
  const yearsOf = (e) => { if (!e.hireDate) return 0; const h = new Date(e.hireDate), d = new Date(s.period + "-01"); let m = (d.getFullYear() - h.getFullYear()) * 12 + (d.getMonth() - h.getMonth()); return m < 0 ? 0 : Math.floor(m / 12); };
  s.lines = emps.map(e => ({ id: id("bln"), employeeId: e.id, name: `${e.lastName || ""} ${e.firstName || ""}`.trim(),
    poste: (e.contract && e.contract.position) || e.position || "", salaireBase: baseOf(e), jours: 30, years: yearsOf(e), primes: 0, horsCharges: 0, components: {} }));
  save(); audit(req.user, "IMPORTED", "BillingSheet", s.id, { from: "payroll", lines: s.lines.length });
  res.json(withCompute(s, req));
});

/* ============================ RÉCAP MENSUEL (F12) ============================ */
router.get("/recap", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const period = req.query.period;
  const byId = {}; mine(db.billingContracts, req).forEach(c => byId[c.id] = c);
  const list = mine(db.billingSheets, req).filter(s => !period || s.period === period);
  const rows = list.map(s => { const t = withCompute(s, req).computed.totals; const c = byId[s.contractId] || {};
    return { source: c.clientName || "", number: s.number, date: s.period, HT: t.HT, TVA: t.TVA, TTC: t.TTC, status: s.status }; })
    .sort((a, b) => (a.source || "").localeCompare(b.source));
  const tot = rows.reduce((o, r) => { o.HT += r.HT; o.TVA += r.TVA; o.TTC += r.TTC; return o; }, { HT: 0, TVA: 0, TTC: 0 });
  res.json({ period: period || "toutes", rows, totals: { HT: tot.HT, TVA: tot.TVA, TTC: tot.TTC, count: rows.length } });
});

/* ---- defaults (rates + montant en lettres util) ---- */
router.get("/defaults", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => res.json({ rates: DEFAULT_RATES }));

/* ============================ IMPORT EXCEL (F1) ============================ */
function _wb(base64) { const XLSX = require("xlsx"); return XLSX.read(Buffer.from(base64, "base64"), { type: "buffer", cellDates: true }); }
function _matrix(wb, name) { const XLSX = require("xlsx"); const ws = wb.Sheets[name] || wb.Sheets[wb.SheetNames[0]]; return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" }); }
function _detectHeader(m) { let best = 0, bs = -1; for (let i = 0; i < Math.min(m.length, 20); i++) { const sc = (m[i] || []).filter(c => typeof c === "string" && c.trim().length > 1).length; if (sc > bs) { bs = sc; best = i; } } return best; }
const _n = (v) => typeof v === "number" ? v : Number(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")) || 0;

router.post("/import/parse", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  try {
    const { data, sheet } = req.body || {};
    if (!data) return res.status(400).json({ error: "Fichier manquant" });
    const wb = _wb(data); const name = sheet || wb.SheetNames[0];
    const m = _matrix(wb, name); const hr = _detectHeader(m);
    const headers = (m[hr] || []).map((h, i) => ({ index: i, label: String(h == null ? "" : h).trim() || ("Col " + (i + 1)) }));
    res.json({ sheets: wb.SheetNames, sheet: name, headerRow: hr, headers, sample: m.slice(hr + 1, hr + 4), rowCount: Math.max(0, m.length - hr - 1) });
  } catch (e) { res.status(400).json({ error: "Lecture du fichier Excel impossible : " + e.message }); }
});

router.post("/sheets/:id/import-excel", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  if (s.status === "validated") return res.status(409).json({ error: "Fiche validée — lecture seule" });
  const contract = contractOf(req, s.contractId) || {};
  try {
    const { data, sheet, headerRow, mapping, mode } = req.body || {};
    if (!data || !mapping) return res.status(400).json({ error: "Fichier ou mapping manquant" });
    const wb = _wb(data); const m = _matrix(wb, sheet || wb.SheetNames[0]); const hr = Number(headerRow) || 0;
    const at = (row, key) => { const c = mapping[key]; return (c === null || c === "" || c === undefined) ? undefined : row[Number(c)]; };
    const compMap = mapping.components || {};
    const out = [];
    for (let i = hr + 1; i < m.length; i++) {
      const row = m[i]; if (!row || row.every(c => c === "" || c == null)) continue;
      const name = String(at(row, "name") == null ? "" : at(row, "name")).trim();
      const sal = _n(at(row, "salaireBase"));
      if (!name && !sal) continue;
      const components = {};
      for (const [code, ci] of Object.entries(compMap)) { if (ci === "" || ci == null) continue; const val = _n(row[Number(ci)]); if (val) components[code] = { montant: val }; }
      let years = _n(at(row, "years"));
      const hv = at(row, "hireDate");
      if (hv) { const hd = hv instanceof Date ? hv : (/\d{4}/.test(String(hv)) ? new Date(hv) : null);
        if (hd && !isNaN(hd)) { const d = new Date(s.period + "-01"); let mo = (d.getFullYear() - hd.getFullYear()) * 12 + (d.getMonth() - hd.getMonth()); years = mo < 0 ? 0 : Math.floor(mo / 12); } }
      out.push({ id: id("bln"), name, poste: String(at(row, "poste") == null ? "" : at(row, "poste")).trim(),
        salaireBase: sal, jours: _n(at(row, "jours")) || 30, years, primes: _n(at(row, "primes")), horsCharges: _n(at(row, "horsCharges")),
        montantHT: _n(at(row, "montantHT")), quantite: _n(at(row, "quantite")), pu: _n(at(row, "pu")), components });
    }
    s.lines = (mode === "append") ? (s.lines || []).concat(out) : out;
    if (contract.id) { contract.columnMapping = { sheet, headerRow: hr, mapping }; }
    save();
    audit(req.user, "IMPORTED", "BillingSheet", s.id, { from: "excel", lines: out.length });
    res.json(withCompute(s, req));
  } catch (e) { res.status(400).json({ error: "Import Excel : " + e.message }); }
});

module.exports = router;
module.exports.enLettres = enLettres;
