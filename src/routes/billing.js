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
const { computeAnnexe } = require("../billing/annexe");
const PDFDocument = require("pdfkit");

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
  const isRate = contract.isEnabled ? Number(contract.isRate || (contract.rates || {}).is || 0) : 0;
  const t = computed.totals;
  t.IS = Math.round((t.HT || 0) * isRate);       // retenue à la source
  t.netAPerc = (t.HT || 0) - t.IS;               // net à percevoir (HT - IS)
  t.totalDu = (t.HT || 0) + (t.TVA || 0) - t.IS; // montant dû = HT + TVA - IS
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
    numberFormat: b.numberFormat || "CLIENT/AAAA/MM/####", invoiceStyle: b.invoiceStyle || "lines",
    isEnabled: !!b.isEnabled, isRate: b.isRate != null ? Number(b.isRate) : 0.022, invoiceSeqPrefix: b.invoiceSeqPrefix || "029",
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
  for (const k of ["clientCode", "clientName", "billingType", "numberFormat", "invoiceStyle", "prorate", "anciennete", "tvaExonere", "clientBlock", "bankBlock", "components", "columnMapping", "isEnabled", "isRate", "invoiceSeqPrefix"])
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
    status: "draft", stage: "devis", lines: Array.isArray(b.lines) ? b.lines : [], createdAt: new Date().toISOString() }, req);
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

/* ==================== ANNEXE & FACTURE (PDF / Excel) ==================== */
const _NF = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
function _company() { const b = (db.settings && db.settings.branding) || {}; return Object.assign({ name: b.appName || "CIBLE RH EMPLOI" }, b.company || {}); }
function _proformaLines(s, computed, contract) {
  const L = computed.lines; const sum = (k) => L.reduce((a, l) => a + (l.raw[k] || 0), 0);
  const out = [["SALAIRES BRUTS", Math.round(sum("brut"))], ["PROVISION CONGÉS", Math.round(sum("conges"))]];
  if (sum("fin") > 0) out.push(["PROVISION FIN DE CONTRAT", Math.round(sum("fin"))]);
  out.push(["CHARGES PATRONALES", Math.round(sum("charges"))]);
  for (const c of (contract.components || []).filter(c => c.stage === "HORS_CHARGE" && c.active)) {
    let t = 0; for (const ln of s.lines) t += Number(((ln.components || {})[c.code] || {}).montant || 0);
    if (t) out.push([String(c.label).toUpperCase(), Math.round(t)]);
  }
  out.push(["FRAIS DE GESTION", Math.round(sum("fraisGestion"))]);
  return out;
}
function _drawHeader(doc, co, client, title) {
  doc.font("Helvetica-Bold").fontSize(15).text(title, 24, 22);
  doc.font("Helvetica").fontSize(8);
  doc.font("Helvetica-Bold").fontSize(11).text(co.name || "CIBLE RH EMPLOI", 24, 46);
  doc.font("Helvetica").fontSize(8);
  if (co.address) doc.text(co.address, 24, 62);
  if (co.city) doc.text(co.city, 24, 73);
  if (co.rccm || co.niu) doc.text(`RCCM : ${co.rccm || ""}   ·   NIU : ${co.niu || ""}`, 24, 84);
  // client block (right)
  const cb = client || {};
  doc.font("Helvetica-Bold").fontSize(9).text("ADRESSÉE À :", 360, 46);
  doc.font("Helvetica").fontSize(9);
  if (cb.name) doc.text(cb.name, 360, 60); if (cb.adresse) doc.text(cb.adresse, 360, 72);
  if (cb.rccm) doc.text("RCCM : " + cb.rccm, 360, 84); if (cb.niu) doc.text("NIU : " + cb.niu, 360, 95);
}

router.get("/sheets/:id/annexe/pdf", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const D = withCompute(s, req); const co = _company();
  const doc = new PDFDocument({ margin: 20, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Annexe_${(D.contract.clientName||"").replace(/[^\w]/g,"_")}_${s.period}.pdf"`);
  doc.pipe(res);
  _drawHeader(doc, co, D.contract.clientBlock, `ANNEXE — ${D.contract.clientName} · ${s.period}`);
  const cols = [["N°", 26], ["Salarié", 150], ["Poste", 110], ["Base", 70], ["Brut", 72], ["Congés", 62], ["Charges", 66], ["Frais gest.", 66], ["HT", 76], ["TVA", 66], ["TTC", 80]];
  const x0 = 20; let x = x0; const xs = cols.map(c => { const cx = x; x += c[1]; return cx; }); const W = x - x0;
  let y = 118; const T = (cx, yy, v, w, al, b, sz) => doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(sz || 7.5).text(v == null ? "" : String(v), cx + 2, yy, { width: w - 4, align: al || "left", lineBreak: false });
  doc.rect(x0, y, W, 15).fillAndStroke("#e6efe9", "#000"); doc.fillColor("#000");
  cols.forEach((c, i) => T(xs[i], y + 3.5, c[0], c[1], i < 3 ? "left" : "right", true, 7)); y += 15;
  let n = 0;
  for (const poste of Object.keys(D.computed.groups).sort()) {
    doc.rect(x0, y, W, 12).fill("#ecfdf5"); doc.fillColor("#000"); T(xs[1], y + 2.5, poste, 300, "left", true, 7.5); y += 12;
    for (const l of D.computed.groups[poste]) {
      n++; const vals = [n, l.name, l.poste, l.basePorata, l.brut, l.conges, l.charges, l.fraisGestion, l.HT, l.TVA, l.TTC];
      vals.forEach((v, i) => T(xs[i], y + 2, i >= 3 ? _NF(v) : v, cols[i][1], i < 3 ? "left" : "right", false, 7));
      doc.lineWidth(0.3).strokeColor("#ddd").moveTo(x0, y + 11).lineTo(x0 + W, y + 11).stroke(); y += 11.5;
      if (y > 560) { doc.addPage({ margin: 20, size: "A4", layout: "landscape" }); y = 40; }
    }
  }
  const t = D.computed.totals; y += 2; doc.lineWidth(0.7).strokeColor("#000").moveTo(x0, y).lineTo(x0 + W, y).stroke(); y += 3;
  T(xs[1], y, `TOTAL GÉNÉRAL (${t.count})`, 300, "left", true); [["HT", 8], ["TVA", 9], ["TTC", 10]].forEach(([k, i]) => T(xs[i], y, _NF(t[k]), cols[i][1], "right", true));
  audit(req.user, "EXPORTED", "BillingSheet", s.id, { doc: "annexe", format: "pdf" }); doc.end();
});

router.get("/sheets/:id/annexe/excel", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const D = withCompute(s, req); const XLSX = require("xlsx");
  const aoa = [["N°", "Salarié", "Poste", "Base", "Brut", "Congés", "Charges", "Frais gestion", "HT", "TVA", "TTC"]]; let n = 0;
  for (const poste of Object.keys(D.computed.groups).sort()) { aoa.push([poste]); for (const l of D.computed.groups[poste]) aoa.push([++n, l.name, l.poste, l.basePorata, l.brut, l.conges, l.charges, l.fraisGestion, l.HT, l.TVA, l.TTC]); }
  const t = D.computed.totals; aoa.push([]); aoa.push(["", "TOTAL GÉNÉRAL", "", "", "", "", "", "", t.HT, t.TVA, t.TTC]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Annexe");
  audit(req.user, "EXPORTED", "BillingSheet", s.id, { doc: "annexe", format: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Annexe_${s.period}.xlsx"`); res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

router.get("/sheets/:id/invoice/pdf", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const D = withCompute(s, req); const co = _company(); const c = D.contract; const t = D.computed.totals; const style = c.invoiceStyle || "lines";
  const doc = new PDFDocument({ margin: 28, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Facture_${(c.clientName||"").replace(/[^\w]/g,"_")}_${s.period}.pdf"`);
  doc.pipe(res);
  _drawHeader(doc, co, c.clientBlock, "FACTURE / PROFORMA");
  doc.font("Helvetica-Bold").fontSize(9).text("N° " + (s.number || ""), 360, 118); doc.font("Helvetica").fontSize(9).text("Date : " + s.period, 360, 130);
  doc.font("Helvetica-Bold").fontSize(9).text(`Objet : Mise à disposition — ${s.period}`, 28, 118);
  let y = 150; const x0 = 28, W = 539;
  const T = (cx, yy, v, w, al, b) => doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(v == null ? "" : String(v), cx + 3, yy, { width: w - 6, align: al || "left", lineBreak: false });
  if (style === "proforma") {
    const rows = _proformaLines(s, D.computed, c);
    doc.rect(x0, y, W, 16).fillAndStroke("#e6efe9", "#000"); doc.fillColor("#000");
    T(x0, y + 4, "DESCRIPTION", 380, "left", true); T(x0 + 380, y + 4, "MONTANT HT", W - 380, "right", true); y += 16;
    for (const [lbl, amt] of rows) { T(x0, y + 3, lbl, 380, "left"); T(x0 + 380, y + 3, _NF(amt), W - 380, "right"); doc.lineWidth(0.3).strokeColor("#ddd").moveTo(x0, y + 14).lineTo(x0 + W, y + 14).stroke(); y += 15; }
  } else {
    const cols = [["#", 26], ["Désignation", 300], ["Qté", 40], ["Montant HT", 173]];
    const xs = []; let x = x0; cols.forEach(cc => { xs.push(x); x += cc[1]; });
    doc.rect(x0, y, W, 16).fillAndStroke("#e6efe9", "#000"); doc.fillColor("#000");
    cols.forEach((cc, i) => T(xs[i], y + 4, cc[0], cc[1], i === 3 ? "right" : "left", true)); y += 16;
    let n = 0; for (const l of D.computed.lines) { n++; T(xs[0], y + 3, n, 26); T(xs[1], y + 3, `${l.name}${l.poste ? " — " + l.poste : ""}`, 300); T(xs[2], y + 3, 1, 40, "center"); T(xs[3], y + 3, _NF(l.HT), 173, "right"); doc.lineWidth(0.3).strokeColor("#ddd").moveTo(x0, y + 14).lineTo(x0 + W, y + 14).stroke(); y += 15; if (y > 720) { doc.addPage(); y = 40; } }
  }
  y += 6; doc.lineWidth(0.6).strokeColor("#000").moveTo(x0, y).lineTo(x0 + W, y).stroke(); y += 5;
  const tot = (lbl, v, b) => { T(x0 + 300, y, lbl, 120, "right", b); T(x0 + 420, y, _NF(v) + " FCFA", W - 420, "right", b); y += 15; };
  tot("Total HT", t.HT, true); tot(c.tvaExonere ? "TVA (exonérée)" : "TVA", t.TVA);
  if (t.IS) tot("IS (retenue)", -t.IS);
  tot(t.IS ? "TOTAL À PAYER" : "TOTAL TTC", t.IS ? t.totalDu : t.TTC, true);
  y += 8; doc.font("Helvetica-Oblique").fontSize(9).text("Arrêtée la présente facture à la somme de : " + enLettres(t.TTC) + " francs CFA.", x0, y, { width: W });
  y = doc.y + 14; const bk = c.bankBlock || {}; if (bk.banque) { doc.font("Helvetica-Bold").fontSize(9).text("Coordonnées bancaires", x0, y); doc.font("Helvetica").fontSize(9).text(`${bk.banque}   ${bk.compte || ""}`, x0, y + 12); }
  audit(req.user, "EXPORTED", "BillingSheet", s.id, { doc: "facture", format: "pdf", style }); doc.end();
});

router.get("/sheets/:id/invoice/excel", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const D = withCompute(s, req); const c = D.contract; const t = D.computed.totals; const XLSX = require("xlsx"); const style = c.invoiceStyle || "lines";
  const aoa = [[_company().name], [c.clientName], ["Facture N°", s.number, "Période", s.period], []];
  if (style === "proforma") { aoa.push(["Description", "Montant HT"]); for (const [lbl, amt] of _proformaLines(s, D.computed, c)) aoa.push([lbl, amt]); }
  else { aoa.push(["#", "Désignation", "Qté", "Montant HT"]); let n = 0; for (const l of D.computed.lines) aoa.push([++n, `${l.name}${l.poste ? " — " + l.poste : ""}`, 1, l.HT]); }
  aoa.push([]); aoa.push(["", "", "Total HT", t.HT]); aoa.push(["", "", c.tvaExonere ? "TVA (exonérée)" : "TVA", t.TVA]);
  if (t.IS) aoa.push(["", "", "IS (retenue)", -t.IS]);
  aoa.push(["", "", t.IS ? "TOTAL À PAYER" : "TOTAL TTC", t.IS ? t.totalDu : t.TTC]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Facture");
  audit(req.user, "EXPORTED", "BillingSheet", s.id, { doc: "facture", format: "xlsx", style });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Facture_${s.period}.xlsx"`); res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

/* ==================== ANNEXE TEMPLATES (configurable) ==================== */
const tplOf = (req, id) => mine(db.billingAnnexeTemplates, req).find(t => t.id === id);
router.get("/annexe-templates", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) =>
  res.json(mine(db.billingAnnexeTemplates, req).slice().sort((a, b) => (a.title || "").localeCompare(b.title || ""))));
router.get("/annexe-templates/:id", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const t = tplOf(req, req.params.id); if (!t) return res.status(404).json({ error: "Modèle introuvable" }); res.json(t);
});
router.post("/annexe-templates", allow("ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: "Titre obligatoire" });
  const t = stamp({ id: id("batpl"), code: b.code || b.title.slice(0, 16).toUpperCase().replace(/[^A-Z0-9]/g, "_"),
    title: b.title, contractId: b.contractId || null, groupBy: b.groupBy || null,
    taxes: b.taxes || { tva: 0.1925, is: 0 }, signatures: b.signatures || [], etabliPar: b.etabliPar || "",
    columns: Array.isArray(b.columns) ? b.columns : [], createdAt: new Date().toISOString() }, req);
  db.billingAnnexeTemplates.push(t); save();
  audit(req.user, "CREATED", "BillingAnnexeTemplate", t.id, { title: t.title }); res.status(201).json(t);
});
router.put("/annexe-templates/:id", allow("ADM"), (req, res) => {
  const t = tplOf(req, req.params.id); if (!t) return res.status(404).json({ error: "Modèle introuvable" });
  for (const k of ["title", "code", "contractId", "groupBy", "taxes", "signatures", "etabliPar", "columns"])
    if (req.body[k] !== undefined) t[k] = req.body[k];
  save(); audit(req.user, "UPDATED", "BillingAnnexeTemplate", t.id, {}); res.json(t);
});
router.delete("/annexe-templates/:id", allow("ADM"), (req, res) => {
  const t = tplOf(req, req.params.id); if (!t) return res.status(404).json({ error: "Modèle introuvable" });
  db.billingAnnexeTemplates.splice(db.billingAnnexeTemplates.indexOf(t), 1); save(); res.json({ ok: true });
});
router.post("/annexe-templates/:id/duplicate", allow("ADM"), (req, res) => {
  const t = tplOf(req, req.params.id); if (!t) return res.status(404).json({ error: "Modèle introuvable" });
  const copy = stamp(Object.assign(JSON.parse(JSON.stringify(t)), { id: id("batpl"), code: (t.code || "TPL") + "_COPY",
    title: t.title + " (copie)", system: false, createdAt: new Date().toISOString() }), req);
  db.billingAnnexeTemplates.push(copy); save(); res.status(201).json(copy);
});

// Compute a sheet's annexe through a template (JSON)
router.get("/sheets/:id/annexe-render", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const t = tplOf(req, req.query.templateId); if (!t) return res.status(400).json({ error: "Modèle d'annexe requis" });
  const contract = contractOf(req, s.contractId) || { billingType: "MAD", rates: {} };
  res.json(computeAnnexe(t, s.lines || [], contract));
});

// Template-driven annexe PDF (configurable columns, grouping, signatures)
router.get("/sheets/:id/annexe-template/pdf", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const t = tplOf(req, req.query.templateId); if (!t) return res.status(400).json({ error: "Modèle d'annexe requis" });
  const contract = contractOf(req, s.contractId) || { billingType: "MAD", rates: {} };
  const A = computeAnnexe(t, s.lines || [], contract); const co = _company();
  const doc = new PDFDocument({ margin: 16, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Annexe_${(contract.clientName||"").replace(/[^\w]/g,"_")}_${s.period}.pdf"`);
  doc.pipe(res);
  _drawHeader(doc, co, contract.clientBlock, t.title || "ANNEXE DE FACTURATION");
  doc.font("Helvetica").fontSize(8).text(`Client : ${contract.clientName || ""}   ·   Période : ${s.period}`, 24, 104);
  const cols = t.columns || [];
  let total = 0; cols.forEach(c => total += (c.w || 60));
  const avail = 810; const scale = total > avail ? avail / total : 1;
  const x0 = 16; const xs = []; let x = x0; cols.forEach(c => { xs.push(x); x += (c.w || 60) * scale; }); const W = x - x0;
  let y = 120;
  const T = (cx, yy, v, w, al, b, sz) => doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(sz || 6.5).fillColor("#000").text(v == null ? "" : String(v), cx + 1, yy, { width: w - 2, align: al || "right", lineBreak: false });
  const headRow = () => { doc.rect(x0, y, W, 14).fillAndStroke("#7a1420", "#000"); cols.forEach((c, i) => doc.font("Helvetica-Bold").fontSize(6).fillColor("#fff").text(c.label || c.key, xs[i] + 1, y + 3.5, { width: (c.w || 60) * scale - 2, align: c.align === "left" ? "left" : "right", lineBreak: false })); doc.fillColor("#000"); y += 14; };
  headRow();
  const drawRow = (row, bold, bg) => { if (bg) { doc.rect(x0, y, W, 10).fill(bg); doc.fillColor("#000"); }
    cols.forEach((c, i) => { const v = c.source === "field" ? row.cells[c.key] : _NF(row.cells[c.key]); T(xs[i], y + 1.5, v, (c.w || 60) * scale, c.align === "left" ? "left" : "right", bold || c.bold); });
    doc.lineWidth(0.3).strokeColor("#ddd").moveTo(x0, y + 10).lineTo(x0 + W, y + 10).stroke(); y += 10.5;
    if (y > 555) { doc.addPage({ margin: 16, size: "A4", layout: "landscape" }); y = 30; headRow(); } };
  const totalRow = (cells, label) => { doc.lineWidth(0.6).strokeColor("#000").moveTo(x0, y).lineTo(x0 + W, y).stroke(); y += 1.5;
    cols.forEach((c, i) => { let v = ""; if (i === 0) v = label; else if (c.source !== "field" && cells[c.key] != null) v = _NF(cells[c.key]); T(xs[i], y + 1.5, v, (c.w || 60) * scale, i === 0 ? "left" : "right", true); }); y += 12; };
  if (A.groups) { for (const g of Object.keys(A.groups).sort()) { for (const r of A.groups[g]) drawRow(r); totalRow(A.groupTotals[g], "TOTAL " + g.toUpperCase()); } }
  else { for (const r of A.rows) drawRow(r); }
  totalRow(A.total, "TOTAL GÉNÉRAL (" + A.count + ")");
  if ((t.signatures || []).length) { y = Math.min(y + 24, 560); const sw = W / t.signatures.length; t.signatures.forEach((sig, i) => doc.font("Helvetica-Bold").fontSize(8).text(sig, x0 + i * sw, y, { width: sw, align: "center" })); }
  audit(req.user, "EXPORTED", "BillingSheet", s.id, { doc: "annexe-template", format: "pdf" }); doc.end();
});

/* ==================== CYCLE DE VIE + DUPLICATION ==================== */
router.post("/sheets/:id/stage", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  if (s.posted && (req.body || {}).to !== "unpost") return res.status(409).json({ error: "Facture comptabilisée — verrouillée" });
  const order = ["devis", "commande", "facture"]; s.stage = s.stage || "devis";
  const to = (req.body || {}).to;
  if (to === "back") { const i = order.indexOf(s.stage); if (i > 0) s.stage = order[i - 1]; s.posted = false; }
  else if (order.includes(to)) {
    s.stage = to;
    if (to === "facture" && !s.invoiceNumber) {
      const contract = contractOf(req, s.contractId) || {}; const [yy, mm] = s.period.split("-");
      const seq = mine(db.billingSheets, req).filter(x => x.invoiceNumber && x.period.slice(0, 4) === yy).length + 1;
      s.invoiceNumber = `${contract.invoiceSeqPrefix || "029"}/${yy}/${mm}/${String(seq).padStart(5, "0")}`;
    }
  } else if (to === "post") { if (s.stage === "facture") s.posted = true; }
  else if (to === "unpost") { s.posted = false; }
  save(); audit(req.user, "STAGE", "BillingSheet", s.id, { stage: s.stage, posted: !!s.posted });
  res.json({ ok: true, stage: s.stage, posted: !!s.posted, invoiceNumber: s.invoiceNumber || null });
});

router.post("/sheets/:id/duplicate", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const period = (req.body || {}).period;
  if (!/^\d{4}-\d{2}$/.test(period || "")) return res.status(400).json({ error: "Période AAAA-MM requise" });
  const contract = contractOf(req, s.contractId) || {};
  if (mine(db.billingSheets, req).some(x => x.contractId === s.contractId && x.period === period))
    return res.status(409).json({ error: "Une fiche existe déjà pour ce client et cette période" });
  const [yy, mm] = period.split("-");
  const seq = mine(db.billingSheets, req).filter(x => x.period === period).length + 1;
  const number = (contract.numberFormat || "CLIENT/AAAA/MM/####")
    .replace("CLIENT", contract.clientCode || "CLI").replace("AAAA", yy).replace("MM", mm).replace(/#+/, String(seq).padStart(4, "0"));
  const copy = stamp({ id: id("bsht"), contractId: s.contractId, period, number, status: "draft", stage: "devis",
    lines: (s.lines || []).map(l => Object.assign({}, l, { id: id("bln") })), createdAt: new Date().toISOString() }, req);
  db.billingSheets.push(copy); save();
  audit(req.user, "DUPLICATED", "BillingSheet", copy.id, { from: s.id, period });
  res.status(201).json(withCompute(copy, req));
});

/* Template-driven annexe — Excel */
router.get("/sheets/:id/annexe-template/excel", allow("ADM", "CD", "RJ", "GPF", "UI"), (req, res) => {
  const s = mine(db.billingSheets, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Fiche introuvable" });
  const t = tplOf(req, req.query.templateId); if (!t) return res.status(400).json({ error: "Modèle d'annexe requis" });
  const contract = contractOf(req, s.contractId) || { billingType: "MAD", rates: {} };
  const A = computeAnnexe(t, s.lines || [], contract); const XLSX = require("xlsx"); const cols = t.columns || [];
  const rowVals = (r) => cols.map(c => r.cells[c.key]);
  const aoa = [cols.map(c => c.label || c.key)];
  if (A.groups) { for (const g of Object.keys(A.groups).sort()) { aoa.push([g]); for (const r of A.groups[g]) aoa.push(rowVals(r)); aoa.push(cols.map((c, i) => i === 0 ? ("TOTAL " + g) : (c.source !== "field" ? A.groupTotals[g][c.key] : ""))); } }
  else { for (const r of A.rows) aoa.push(rowVals(r)); }
  aoa.push(cols.map((c, i) => i === 0 ? "TOTAL GÉNÉRAL" : (c.source !== "field" ? A.total[c.key] : "")));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Annexe");
  audit(req.user, "EXPORTED", "BillingSheet", s.id, { doc: "annexe-template", format: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Annexe_${s.period}.xlsx"`); res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

module.exports = router;
module.exports.enLettres = enLettres;
