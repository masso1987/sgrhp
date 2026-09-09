/* Gestion Avancée (GA) — moteur d'extraction de listes depuis la paie & le personnel.
   Un modèle GA = { code (LST000xx), intitule, titre, type ("fixed"|"table"), confidentialite,
                    fields:[{ n, label, source, taille, decimales, numeric, colonne }] } */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

const RO = ["ADM", "CD", "RJ", "GPF"];
const RW = ["ADM", "CD", "RJ"];

/* ---------------- Catalogue des sources ---------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const ddmmyyyy = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? `${m[3]}${m[2]}${m[1]}` : ""; };
const compOf = () => (db.settings && db.settings.branding && db.settings.branding.company) || {};

// Chaque source: fonction(ctx) -> valeur brute (nombre ou texte). ctx = {emp, slip, cfg, period, seq, tenant, comp, pf}
const SOURCES = {
  // Personnel
  matricule:      { label: "Matricule", fn: c => c.emp.matricule || "" },
  nom:            { label: "Nom", fn: c => c.emp.lastName || "" },
  prenom:         { label: "Prénom", fn: c => c.emp.firstName || "" },
  civilite:       { label: "Civilité", fn: c => c.emp.civility || "" },
  sexe:           { label: "Sexe", fn: c => /mme|mlle|f/i.test(c.emp.civility || c.emp.gender || "") ? "Feminin" : "Masculin" },
  dateNaissance:  { label: "Date de naissance", fn: c => ddmmyyyy(c.emp.birthDate) },
  categorie:      { label: "Catégorie", fn: c => (c.emp.contract && c.emp.contract.category) || "" },
  departement:    { label: "Département", fn: c => c.emp.department || "" },
  unite:          { label: "Unité / établissement", fn: c => (c.pf && c.pf.name) || "" },
  dateEmbauche:   { label: "Date d'embauche", fn: c => ddmmyyyy(c.emp.hireDate) },
  activite:       { label: "Activité", fn: c => c.emp.activity || "" },
  emploi:         { label: "Emploi occupé", fn: c => c.emp.position || "" },
  fonction:       { label: "Fonction (intitulé)", fn: c => c.emp.position || c.emp.qualification || "" },
  qualification:  { label: "Qualification", fn: c => c.emp.qualification || "" },
  modePaiement:   { label: "Mode de paiement", fn: c => (c.emp.contract && c.emp.contract.paymentMethod) || "" },
  banque:         { label: "Banque", fn: c => c.emp.bankName || "" },
  codeBanque:     { label: "Code banque", fn: c => c.emp.bankCode || "" },
  codeGuichet:    { label: "Code guichet", fn: c => c.emp.bankBranch || "" },
  numeroCompte:   { label: "Numéro de compte", fn: c => c.emp.bankAccount || "" },
  cleRib:         { label: "Clé RIB", fn: c => c.emp.bankKey || "" },
  natureContrat:  { label: "Nature du contrat", fn: c => (c.emp.contract && c.emp.contract.type) || "" },
  cnps:           { label: "N° CNPS / Sécurité sociale", fn: c => c.emp.cnpsNumber || "" },
  nationalite:    { label: "Nationalité", fn: c => c.emp.nationality || "" },
  statut:         { label: "Statut (Employé/Cadre)", fn: c => c.emp.statut || "" },
  csp:            { label: "Catégorie socio-professionnelle", fn: c => c.emp.csp || "" },
  ntt:            { label: "N° technique temporaire (NTT)", fn: c => c.emp.ntt || "" },
  niu:            { label: "NIU (Identifiant Unique)", fn: c => c.emp.niu || "" },
  etablissement:  { label: "Établissement", fn: c => c.emp.establishment || (c.pf && c.pf.name) || "" },
  ibanBanque:     { label: "IBAN", fn: c => (c.emp.bank && c.emp.bank.iban) || "" },
  libelleCompte:  { label: "Libellé du compte", fn: c => (c.emp.bank && c.emp.bank.label) || "" },
  cleSecu:        { label: "Clé n° Sécurité sociale", fn: c => c.emp.cnpsKey || "" },
  // Paie (bulletin de la période)
  nbJours:        { label: "Nombre de jours", numeric: true, fn: c => c.slip ? (c.slip.result.meta.workedDays != null ? c.slip.result.meta.workedDays : 30) : 0 },
  salBrut:        { label: "Salaire brut", numeric: true, fn: c => c.T("brutTotal") },
  salExcep:       { label: "Salaire exceptionnel", numeric: true, fn: c => 0 },
  salTaxable:     { label: "Salaire taxable (imposable)", numeric: true, fn: c => c.T("netImposable") },
  salCotisable:   { label: "Salaire cotisable", numeric: true, fn: c => c.T("netCotisable") },
  salCotPla:      { label: "Salaire cotisable plafonné", numeric: true, fn: c => c.slip ? (c.slip.result.meta.cnpsBase || 0) : 0 },
  irpp:           { label: "IRPP", numeric: true, fn: c => c.T("irpp") },
  taxeCommunale:  { label: "Taxe communale (TDL)", numeric: true, fn: c => c.T("tdl") },
  net:            { label: "Net à payer", numeric: true, fn: c => c.T("netAPayer") },
  cnpsSalarie:    { label: "CNPS part salariale", numeric: true, fn: c => c.T("cnpsSalarie") },
  chargesPatronales: { label: "Charges patronales", numeric: true, fn: c => c.T("chargesPatronales") },
  // DIPE (magnétique)
  numeroDipe:     { label: "Numéro DIPE", fn: c => c.comp.dipe || (c.tenant && c.tenant.dipe) || "" },
  cle:            { label: "Clé DIPE", fn: c => "" },
  mois:           { label: "Mois de paie", fn: c => (c.period || "").slice(5, 7) },
  anneePaie:      { label: "Année de paie", fn: c => (c.period || "").slice(0, 4) },
  numeroLigne:    { label: "Numéro de ligne", fn: c => String(c.seq || 1) },
};
function sourceValue(field, ctx) {
  const src = field.source || "";
  if (src.startsWith("rub:")) {
    const code = src.slice(4);
    if (!ctx.slip) return 0;
    return ctx.slip.result.lines.filter(l => String(l.code) === code)
      .reduce((a, l) => a + (Number(l.gain) || Number(l.retenue) || Number(l.employer) || 0), 0);
  }
  const def = SOURCES[src];
  return def ? def.fn(ctx) : "";
}
function sourceIsNumeric(field) {
  if (field.numeric != null) return !!field.numeric;
  if ((field.source || "").startsWith("rub:")) return true;
  const def = SOURCES[field.source];
  return !!(def && def.numeric);
}

/* ---------------- Formatage ---------------- */
function fmtFixed(field, raw) {
  const size = Number(field.taille) || 0;
  if (sourceIsNumeric(field)) {
    const dec = Number(field.decimales) || 0;
    let n = Math.round((Number(raw) || 0) * Math.pow(10, dec));
    const neg = n < 0; n = Math.abs(n);
    let str = String(n);
    if (str.length > size) str = str.slice(-size);
    str = str.padStart(size - (neg ? 1 : 0), "0");
    return (neg ? "-" : "") + str;
  }
  let str = String(raw == null ? "" : raw);
  if (str.length > size) str = str.slice(0, size);
  return str.padEnd(size, " ");
}
function readable(field, raw) {
  if (sourceIsNumeric(field)) { const dec = Number(field.decimales) || 0; return (Number(raw) || 0).toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  return String(raw == null ? "" : raw);
}
function withDebut(model) {
  let pos = 1; const fields = (model.fields || []).map((f, i) => { const d = pos; pos += Number(f.taille) || 0; return Object.assign({ n: i + 1, debut: d, numeric: sourceIsNumeric(f) }, f); });
  const largeur = pos - 1;
  return Object.assign({}, model, { fields, largeur });
}

/* ---------------- Population & exécution ---------------- */
function buildCtxList(req, period, portfolioId) {
  const cfg = (db.payrollConfig || []).find(c => (c.tenantId || "t1") === (req.user.tenantId || "t1")) || {};
  const tenant = (db.tenants || []).find(t => t.id === (req.user.tenantId || "t1")) || {};
  const comp = compOf();
  let emps = mine(db.employees, req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED");
  if (portfolioId) emps = emps.filter(e => e.portfolioId === portfolioId);
  emps.sort((a, b) => String(a.matricule || "").localeCompare(String(b.matricule || ""), "fr", { numeric: true }));
  const slips = mine(db.payslips, req).filter(s => !period || s.period === period);
  const pfs = mine(db.portfolios, req);
  return emps.map((emp, i) => {
    const slip = slips.filter(s => s.employeeId === emp.id).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
    const pf = pfs.find(p => p.id === emp.portfolioId) || null;
    return { emp, slip, cfg, period, tenant, comp, pf, seq: i + 1, T: (k) => slip ? (Number(slip.result.totals[k]) || 0) : 0 };
  });
}
function runModel(model, req, period, portfolioId) {
  const m = withDebut(model);
  const ctxs = buildCtxList(req, period, portfolioId);
  const rows = ctxs.map(ctx => m.fields.map(f => { const raw = sourceValue(f, ctx); return { raw, txt: readable(f, raw), fixed: fmtFixed(f, raw) }; }));
  return { model: m, rows, count: rows.length };
}
function latestPeriod(req) {
  const slips = mine(db.payslips, req).map(s => s.period).filter(Boolean).sort();
  if (slips.length) return slips[slips.length - 1];
  const runs = mine(db.payRuns, req).slice().sort((a, b) => String(b.period).localeCompare(String(a.period)));
  return runs.length ? runs[0].period : new Date().toISOString().slice(0, 7);
}
// Périodes disponibles (runs + bulletins), plus récentes d'abord.
function availablePeriods(req) {
  const set = new Set();
  mine(db.payRuns, req).forEach(r => r.period && set.add(r.period));
  mine(db.payslips, req).forEach(s => s.period && set.add(s.period));
  return [...set].sort().reverse();
}

/* ---------------- Routes CRUD ---------------- */
function nextCode(req) {
  const nums = mine(db.gaModels, req).map(m => parseInt(String(m.code || "").replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
  let n = (nums.length ? Math.max(...nums) : 0) + 1;
  return "LST" + String(n).padStart(5, "0");
}
router.get("/periods", allow(...RO), (req, res) => res.json(availablePeriods(req)));
router.get("/sources", allow(...RO), (req, res) => {
  const list = Object.keys(SOURCES).map(k => ({ key: k, label: SOURCES[k].label, numeric: !!SOURCES[k].numeric }));
  const rubs = mine(db.payRubriques, req).slice().sort((a, b) => String(a.code).localeCompare(String(b.code), "fr", { numeric: true })).map(r => ({ key: "rub:" + r.code, label: `Rubrique ${r.code} — ${r.label || ""}`, numeric: true }));
  res.json({ sources: list, rubriques: rubs });
});
router.get("/", allow(...RO), (req, res) => {
  seedGA(req);
  res.json(mine(db.gaModels, req).slice().sort((a, b) => String(a.code).localeCompare(String(b.code))).map(m => ({ id: m.id, code: m.code, intitule: m.intitule, type: m.type || "fixed", nbElements: (m.fields || []).length })));
});
router.get("/:id", allow(...RO), (req, res) => {
  const m = mine(db.gaModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Modèle introuvable" });
  res.json(withDebut(m));
});
const norm = (b) => ({
  code: b.code, intitule: b.intitule || "", titre: b.titre || b.intitule || "", type: b.type === "table" ? "table" : "fixed",
  confidentialite: Number(b.confidentialite) || 0,
  fields: (Array.isArray(b.fields) ? b.fields : []).map(f => ({ label: f.label || "", source: f.source || "", taille: Number(f.taille) || 0, decimales: Number(f.decimales) || 0, numeric: f.numeric != null ? !!f.numeric : undefined, colonne: f.colonne !== false })),
});
router.post("/", allow(...RW), (req, res) => {
  const b = req.body || {};
  if (!b.intitule) return res.status(400).json({ error: "Intitulé obligatoire" });
  const rec = stamp(Object.assign({ id: id("ga"), code: b.code && String(b.code).trim() ? String(b.code).trim() : nextCode(req), createdAt: new Date().toISOString() }, norm(b)), req);
  if (mine(db.gaModels, req).some(m => m.code === rec.code)) return res.status(409).json({ error: "Code déjà utilisé : " + rec.code });
  db.gaModels.push(rec); save(); audit(req.user, "CREATED", "GaModel", rec.id, { code: rec.code });
  res.status(201).json(withDebut(rec));
});
router.put("/:id", allow(...RW), (req, res) => {
  const m = mine(db.gaModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Modèle introuvable" });
  Object.assign(m, norm(Object.assign({}, m, req.body || {})), { id: m.id, tenantId: m.tenantId, code: m.code });
  m.updatedAt = new Date().toISOString(); save(); audit(req.user, "UPDATED", "GaModel", m.id, {});
  res.json(withDebut(m));
});
router.delete("/:id", allow("ADM", "CD"), (req, res) => {
  const m = mine(db.gaModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Modèle introuvable" });
  db.gaModels.splice(db.gaModels.indexOf(m), 1); save(); audit(req.user, "DELETED", "GaModel", m.id, {}); res.json({ ok: true });
});

/* ---------------- Exécution & export ---------------- */
router.get("/:id/run", allow(...RO), (req, res) => {
  const m = mine(db.gaModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Modèle introuvable" });
  const period = req.query.period || latestPeriod(req);
  const r = runModel(m, req, period, req.query.portfolioId || null);
  const withSlip = mine(db.payslips, req).filter(x => x.period === period).length;
  res.json({
    code: m.code, intitule: m.intitule, type: m.type || "fixed", period, count: r.count, largeur: r.model.largeur, computedCount: withSlip,
    columns: r.model.fields.filter(f => f.colonne !== false).map(f => ({ label: f.label, numeric: f.numeric })),
    rows: r.rows.map(row => r.model.fields.map((f, i) => f.colonne !== false ? row[i].txt : null).filter((_, i) => r.model.fields[i].colonne !== false)),
  });
});
router.get("/:id/export.txt", allow(...RO), (req, res) => {
  const m = mine(db.gaModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Modèle introuvable" });
  const period = req.query.period || latestPeriod(req);
  const r = runModel(m, req, period, req.query.portfolioId || null);
  const lines = r.rows.map(row => row.map(c => c.fixed).join(""));
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${m.code}_${period}.txt"`);
  res.send(lines.join("\r\n"));
});
router.get("/:id/export.xlsx", allow(...RO), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const m = mine(db.gaModels, req).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Modèle introuvable" });
  const period = req.query.period || latestPeriod(req);
  const r = runModel(m, req, period, req.query.portfolioId || null);
  const cols = r.model.fields.filter(f => f.colonne !== false);
  const head = cols.map(f => f.label);
  const aoa = [head];
  r.rows.forEach(row => aoa.push(r.model.fields.map((f, i) => f.colonne !== false ? (f.numeric ? (Number(row[i].raw) || 0) : row[i].raw) : null).filter((_, i) => r.model.fields[i].colonne !== false)));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), (m.code || "GA").slice(0, 28));
  res.setHeader("Content-Disposition", `attachment; filename="${m.code}_${period}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

/* ---------------- Seed des 3 modèles standard ---------------- */
const SEED = [
  { code: "LST00070", intitule: "DIPE MAGNETIQUE", titre: "DIPE MAGNETIQUE", type: "fixed", fields: [
    ["NUMERO DIPE", "numeroDipe", 26], ["CLE", "cle", 3], ["MOIS", "mois", 4], ["Année de paie", "anneePaie", 4],
    ["Numéro de Sécurité Sociale", "cnps", 13], ["Clé du numéro de Sécurité Sociale", "cleSecu", 2],
    ["NBRE JRS", "nbJours", 12], ["SAL BRUT", "salBrut", 12], ["SAL EXCEP", "salExcep", 12], ["SAL TAXABLE", "salTaxable", 12],
    ["SAL COTISABLE", "salCotisable", 12], ["SAL COT PLA", "salCotPla", 12], ["IRPP", "irpp", 12], ["TAXE COMMUNALE", "taxeCommunale", 12],
    ["NUMERO LIGNE", "numeroLigne", 2], ["Matricule", "matricule", 10] ] },
  { code: "LST00071", intitule: "ETAT DIPE", titre: "ETAT DIPE", type: "table", fields: [
    ["Matricule", "matricule", 10], ["Nom", "nom", 25], ["Prénom", "prenom", 20], ["N° CNPS", "cnps", 13],
    ["Nbre jours", "nbJours", 8], ["Sal brut", "salBrut", 12], ["Sal taxable", "salTaxable", 12], ["Sal cotisable", "salCotisable", 12],
    ["Sal cot. plafonné", "salCotPla", 12], ["IRPP", "irpp", 12], ["Taxe communale", "taxeCommunale", 12] ] },
  { code: "LST00001", intitule: "LISTING DU PERSONNEL", titre: "LISTING DU PERSONNEL", type: "fixed", fields: [
    ["Matricule", "matricule", 6], ["Sexe", "sexe", 8], ["Date de naissance", "dateNaissance", 8], ["Nom", "nom", 20], ["Prénom", "prenom", 10],
    ["Intitulé catégorie", "categorie", 4], ["Intitulé département", "departement", 15], ["Intitulé unité", "unite", 15], ["Date d'embauche société", "dateEmbauche", 8],
    ["Activité", "activite", 3], ["Emploi occupé", "emploi", 20], ["Mode de paiement", "modePaiement", 8], ["Code banque 1", "codeBanque", 5],
    ["Code guichet 1", "codeGuichet", 5], ["Numéro de compte 1", "numeroCompte", 11], ["Clé RIB 1", "cleRib", 2], ["Fonction intitulé", "fonction", 60],
    ["BRUT", "salBrut", 12], ["SAL TAX", "salTaxable", 12], ["Nature du contrat", "natureContrat", 10] ] },
];
function seedGA(req) {
  const tid = req.user.tenantId || "t1";
  for (const sd of SEED) {
    if ((db.gaModels || []).some(m => m.code === sd.code && (m.tenantId || "t1") === tid)) continue;
    const rec = stamp({ id: id("ga"), code: sd.code, intitule: sd.intitule, titre: sd.titre, type: sd.type, confidentialite: 0,
      fields: sd.fields.map(([label, source, taille]) => ({ label, source, taille, decimales: 0, colonne: true })), createdAt: new Date().toISOString() }, req);
    db.gaModels.push(rec);
  }
  save();
}

module.exports = router;
module.exports.seedGA = seedGA;
