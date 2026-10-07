/**
 * SGRHP — Health insurance (assurance maladie) module.
 * Coverage rules live at the PORTEFEUILLE level (one insurance company per portefeuille,
 * a coverage %, and who is eligible: employee / spouse / children + a free-children
 * allowance). Each employee has dependents (spouse/children) with supporting documents.
 * Employees request new dependents from the mobile app; GPF validates here. Extra
 * dependents beyond the free allowance are paid by the employee via salary — handled
 * MANUALLY by GPF (this module does not touch payroll).
 *
 * Also: réseau de soins (care network, Excel import) and consumption statements
 * (PEC/RMB, Excel import) that employees consult from the mobile app.
 */
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const XLSX = require("xlsx");
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

const now = () => new Date().toISOString();
const R2 = (n) => Math.round(Number(n) || 0);

/* lazy collections (same pattern as sites/empAccounts) */
function ensure() {
  db.insuranceCompanies = db.insuranceCompanies || [];
  db.insuranceNetwork = db.insuranceNetwork || [];
  db.insuranceConsumption = db.insuranceConsumption || [];
  db.dependents = db.dependents || [];
}

/* dependent document uploads */
const DEP_DIR = path.join(__dirname, "..", "..", "uploads", "dependents");
fs.mkdirSync(DEP_DIR, { recursive: true });
const depUpload = multer({
  storage: multer.diskStorage({
    destination: DEP_DIR,
    filename: (q, f, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${(f.originalname || "doc").replace(/[^\w.\-]/g, "_")}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* ============================ INSURANCE COMPANIES ============================ */
router.get("/companies", allow("GPF", "ADM", "CD", "RJ", "UI"), (req, res) => {
  ensure();
  res.json(mine(db.insuranceCompanies, req).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr")));
});
router.post("/companies", allow("ADM", "GPF"), (req, res) => {
  ensure();
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "Nom de la compagnie requis." });
  const c = stamp({ id: id("ins"), name: String(b.name).trim(), phone: String(b.phone || "").trim(), email: String(b.email || "").trim(), active: b.active !== false, createdAt: now() }, req);
  db.insuranceCompanies.push(c); save();
  audit(req.user, "CREATED", "InsuranceCompany", c.id, { name: c.name });
  res.status(201).json(c);
});
router.put("/companies/:id", allow("ADM", "GPF"), (req, res) => {
  ensure();
  const c = mine(db.insuranceCompanies, req).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Compagnie introuvable" });
  const b = req.body || {};
  if (b.name != null) c.name = String(b.name).trim();
  if (b.phone != null) c.phone = String(b.phone).trim();
  if (b.email != null) c.email = String(b.email).trim();
  if (b.active != null) c.active = !!b.active;
  save(); res.json(c);
});
router.delete("/companies/:id", allow("ADM"), (req, res) => {
  ensure();
  const c = mine(db.insuranceCompanies, req).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Introuvable" });
  const used = mine(db.portfolios, req).some(p => p.insurance && p.insurance.companyId === c.id);
  if (used) return res.status(409).json({ error: "Compagnie rattachée à un portefeuille. Détachez-la d'abord." });
  db.insuranceCompanies = db.insuranceCompanies.filter(x => x.id !== c.id); save();
  res.json({ ok: true });
});

/* ============================ PORTEFEUILLE COVERAGE ============================ */
// Returns every portfolio with its insurance config (company name resolved).
router.get("/coverage", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  ensure();
  const byId = {}; mine(db.insuranceCompanies, req).forEach(c => { byId[c.id] = c; });
  res.json(mine(db.portfolios, req).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr")).map(p => {
    const ins = p.insurance || null;
    return {
      portfolioId: p.id, portfolioName: p.name,
      companyId: ins ? ins.companyId || null : null,
      companyName: ins && byId[ins.companyId] ? byId[ins.companyId].name : null,
      coveragePct: ins ? (ins.coveragePct != null ? ins.coveragePct : null) : null,
      eligSpouse: ins ? !!ins.eligSpouse : false,
      eligChildren: ins ? !!ins.eligChildren : false,
      freeChildren: ins ? (ins.freeChildren != null ? ins.freeChildren : 0) : 0,
      enabled: !!ins,
    };
  }));
});
router.put("/coverage/:portfolioId", allow("ADM", "GPF"), (req, res) => {
  ensure();
  const p = mine(db.portfolios, req).find(x => x.id === req.params.portfolioId);
  if (!p) return res.status(404).json({ error: "Portefeuille introuvable" });
  const b = req.body || {};
  if (b.enabled === false) { delete p.insurance; save(); return res.json({ ok: true, enabled: false }); }
  const companyId = b.companyId || null;
  if (companyId && !mine(db.insuranceCompanies, req).some(c => c.id === companyId)) return res.status(400).json({ error: "Compagnie inconnue." });
  const pct = b.coveragePct != null ? Math.max(0, Math.min(100, Number(b.coveragePct))) : (p.insurance && p.insurance.coveragePct) || 0;
  p.insurance = {
    companyId,
    coveragePct: pct,
    eligSpouse: !!b.eligSpouse,
    eligChildren: !!b.eligChildren,
    freeChildren: Math.max(0, parseInt(b.freeChildren, 10) || 0),
  };
  save();
  audit(req.user, "CONFIG_CHANGED", "Portfolio", p.id, { insurance: p.insurance });
  res.json(Object.assign({ portfolioId: p.id, enabled: true }, p.insurance));
});

/* ============================ RÉSEAU DE SOINS ============================ */
function netHeaderMap(h) {
  const k = String(h || "").trim().toUpperCase().replace(/\s+/g, " ").replace(/[ÉÈÊ]/g, "E");
  if (/REGION/.test(k)) return "region";
  if (/VILLE/.test(k)) return "ville";
  if (/TYPE/.test(k)) return "type";
  if (/PRESTATAIRE|NOM/.test(k)) return "name";
  if (/CATEGORIE/.test(k)) return "category";
  if (/ADRESSE/.test(k)) return "address";
  if (/TEL|PHONE|CONTACT|NUMERO/.test(k)) return "phone";
  if (/^LAT/.test(k)) return "lat";
  if (/^(LNG|LON|LONG)/.test(k)) return "lng";
  return null;
}
router.get("/network", allow("GPF", "ADM", "CD", "RJ", "UI"), (req, res) => {
  ensure();
  const { companyId, region, ville, type, q } = req.query;
  let list = mine(db.insuranceNetwork, req);
  if (companyId) list = list.filter(n => n.companyId === companyId);
  if (region) list = list.filter(n => (n.region || "").toLowerCase() === String(region).toLowerCase());
  if (ville) list = list.filter(n => (n.ville || "").toLowerCase() === String(ville).toLowerCase());
  if (type) list = list.filter(n => (n.type || "").toLowerCase() === String(type).toLowerCase());
  if (q) { const s = String(q).toLowerCase(); list = list.filter(n => (n.name || "").toLowerCase().includes(s) || (n.address || "").toLowerCase().includes(s) || (n.ville || "").toLowerCase().includes(s)); }
  list = list.sort((a, b) => String(a.region || "").localeCompare(String(b.region || "")) || String(a.ville || "").localeCompare(String(b.ville || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  res.json(list.slice(0, 5000));
});
router.get("/network/template", allow("GPF", "ADM"), (req, res) => {
  const header = ["REGION", "VILLE", "TYPE D'ETS", "PRESTATAIRE", "CATEGORIE", "ADRESSE", "TELEPHONE", "LAT", "LNG"];
  const example = ["CENTRE", "YAOUNDE", "CENTRE DE SOINS", "CLINIQUE EXEMPLE", "PRIVE", "Bastos - carrefour", "+237 6 00 00 00 00", "", ""];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, example]), "Reseau");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="modele_reseau.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});
router.post("/network/import", allow("GPF", "ADM"), memUpload.single("file"), (req, res) => {
  ensure();
  const companyId = (req.body && req.body.companyId) || null;
  if (companyId && !mine(db.insuranceCompanies, req).some(c => c.id === companyId)) return res.status(400).json({ error: "Compagnie inconnue." });
  if (!req.file) return res.status(400).json({ error: "Fichier Excel requis." });
  const replace = req.body && (req.body.replace === "1" || req.body.replace === "true");
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false, header: 1 });
  } catch (e) { return res.status(400).json({ error: "Fichier illisible : " + e.message }); }
  if (!rows || rows.length < 2) return res.status(400).json({ error: "Aucune ligne à importer." });
  // find the header row (first row containing REGION + a name/address column)
  let hdrIdx = rows.findIndex(r => r.some(c => /REGION/i.test(String(c))) && r.some(c => /PRESTATAIRE|NOM|ADRESSE/i.test(String(c))));
  if (hdrIdx < 0) hdrIdx = 0;
  const cols = rows[hdrIdx].map(netHeaderMap);
  if (companyId && replace) db.insuranceNetwork = db.insuranceNetwork.filter(n => !((n.tenantId || "t1") === (req.user.tenantId || "t1") && n.companyId === companyId));
  let added = 0;
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const rec = { region: "", ville: "", type: "", name: "", category: "", address: "", phone: "", lat: null, lng: null };
    cols.forEach((k, ci) => { if (k && r[ci] != null && String(r[ci]).trim() !== "") rec[k] = String(r[ci]).trim(); });
    if (!rec.name && !rec.address) continue;
    const lat = parseFloat(String(rec.lat).replace(",", ".")); const lng = parseFloat(String(rec.lng).replace(",", "."));
    db.insuranceNetwork.push(stamp({
      id: id("net"), companyId, region: rec.region, ville: rec.ville, type: rec.type, name: rec.name,
      category: rec.category, address: rec.address, phone: rec.phone,
      lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null, createdAt: now(),
    }, req));
    added++;
  }
  save();
  audit(req.user, "IMPORTED", "InsuranceNetwork", companyId || "-", { added, replace: !!replace });
  res.json({ ok: true, added });
});
router.delete("/network/:id", allow("GPF", "ADM"), (req, res) => {
  ensure();
  db.insuranceNetwork = db.insuranceNetwork.filter(n => !((n.tenantId || "t1") === (req.user.tenantId || "t1") && n.id === req.params.id));
  save(); res.json({ ok: true });
});

/* ============================ CONSOMMATION (PEC / RMB) ============================ */
function consHeaderMap(h) {
  const k = String(h || "").trim().toUpperCase().replace(/\s+/g, " ").replace(/[ÉÈÊ]/g, "E").replace(/\./g, "");
  if (/MATRICULE/.test(k)) return "matricule";
  if (/BENEFICIAIRE/.test(k)) return "beneficiary";
  if (/ADHERENT/.test(k)) return "adherent";
  if (/FILIATION/.test(k)) return "filiation";
  if (/PRESTATAIRE/.test(k)) return "provider";
  if (/RUBRIQUE/.test(k)) return "rubrique";
  if (/MONTANT/.test(k) && !/REMB/.test(k)) return "amount";
  if (/^TAUX/.test(k)) return "rate";
  if (/^PEC$/.test(k) || /MONTANT REMB/.test(k) || /MONTANT PEC/.test(k)) return "covered";
  if (/TICKET/.test(k)) return "ticket";
  if (/^DATE/.test(k) || /DATE DE SOINS/.test(k)) return "date";
  if (/^MODE$|MOYEN/.test(k)) return "mode";
  return null;
}
router.get("/consumption/template", allow("GPF", "ADM"), (req, res) => {
  const header = ["MATRICULE", "DATE", "BENEFICIAIRE", "FILIATION", "PRESTATAIRE", "RUBRIQUE DE SOINS", "MONTANT", "TAUX", "PEC", "TICKET MODERATEUR"];
  const example = ["AMT1017", "2025-03-01", "NOM PRENOM", "Soi meme", "CLINIQUE X", "Consultation", "10000", "80%", "8000", "2000"];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, example]), "Consommation");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="modele_consommation.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});
router.post("/consumption/import", allow("GPF", "ADM"), memUpload.single("file"), (req, res) => {
  ensure();
  if (!req.file) return res.status(400).json({ error: "Fichier Excel requis." });
  const companyId = (req.body && req.body.companyId) || null;
  const period = (req.body && req.body.period) || "";
  const mode = (req.body && req.body.mode) || "PEC";
  const replace = req.body && (req.body.replace === "1" || req.body.replace === "true");
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false, header: 1 });
  } catch (e) { return res.status(400).json({ error: "Fichier illisible : " + e.message }); }
  if (!rows || rows.length < 2) return res.status(400).json({ error: "Aucune ligne." });
  let hdrIdx = rows.findIndex(r => r.some(c => /MATRICULE/i.test(String(c))));
  if (hdrIdx < 0) hdrIdx = 0;
  const cols = rows[hdrIdx].map(consHeaderMap);
  if (replace && period) db.insuranceConsumption = db.insuranceConsumption.filter(x => !((x.tenantId || "t1") === (req.user.tenantId || "t1") && x.period === period && x.mode === mode));
  let added = 0;
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const rec = {};
    cols.forEach((k, ci) => { if (k && r[ci] != null) rec[k] = String(r[ci]).trim(); });
    if (!rec.matricule) continue;
    const num = (v) => { const n = parseFloat(String(v || "").replace(/[^\d.,-]/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
    db.insuranceConsumption.push(stamp({
      id: id("cons"), companyId, period, mode,
      matricule: rec.matricule, date: rec.date || "", beneficiary: rec.beneficiary || rec.adherent || "",
      filiation: rec.filiation || "", provider: rec.provider || "", rubrique: rec.rubrique || "",
      amount: num(rec.amount), rate: rec.rate || "", covered: num(rec.covered), ticket: num(rec.ticket),
      createdAt: now(),
    }, req));
    added++;
  }
  save();
  audit(req.user, "IMPORTED", "InsuranceConsumption", period || "-", { added, mode });
  res.json({ ok: true, added });
});
router.get("/consumption", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  ensure();
  const { matricule, period } = req.query;
  let list = mine(db.insuranceConsumption, req);
  if (matricule) list = list.filter(x => (x.matricule || "").toLowerCase() === String(matricule).toLowerCase());
  if (period) list = list.filter(x => x.period === period);
  list = list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  res.json(list.slice(0, 2000));
});

/* ============================ DEPENDENTS (ayants droit) ============================ */
function depPublic(d) {
  return {
    id: d.id, employeeId: d.employeeId, relation: d.relation, firstName: d.firstName, lastName: d.lastName,
    birthDate: d.birthDate || "", birthPlace: d.birthPlace || "", status: d.status, extra: !!d.extra,
    source: d.source || "GPF", note: d.note || "", createdAt: d.createdAt,
    documents: (d.documents || []).map((x, i) => ({ index: i, type: x.type, fileName: x.fileName })),
  };
}
router.get("/employees/:eid/dependents", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  ensure();
  res.json(mine(db.dependents, req).filter(d => d.employeeId === req.params.eid).map(depPublic));
});
router.post("/employees/:eid/dependents", allow("GPF", "ADM"), depUpload.array("documents", 6), (req, res) => {
  ensure();
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });
  const b = req.body || {};
  if (!b.firstName || !b.lastName) return res.status(400).json({ error: "Nom et prénom requis." });
  const relation = b.relation === "SPOUSE" ? "SPOUSE" : "CHILD";
  const docs = (req.files || []).map(f => ({ type: b.docType || "AUTRE", fileName: f.originalname, storedAs: f.filename }));
  const d = stamp({
    id: id("dep"), employeeId: emp.id, relation, firstName: String(b.firstName).trim(), lastName: String(b.lastName).trim(),
    birthDate: b.birthDate || "", birthPlace: b.birthPlace || "", status: "ACTIVE", extra: b.extra === "true" || b.extra === true,
    source: "GPF", documents: docs, createdAt: now(),
  }, req);
  db.dependents.push(d); save();
  audit(req.user, "CREATED", "Dependent", d.id, { employee: emp.id, relation });
  res.status(201).json(depPublic(d));
});
router.put("/dependents/:id", allow("GPF", "ADM"), (req, res) => {
  ensure();
  const d = mine(db.dependents, req).find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  ["firstName", "lastName", "birthDate", "birthPlace"].forEach(k => { if (b[k] != null) d[k] = String(b[k]); });
  if (b.extra != null) d.extra = !!b.extra;
  if (b.status && ["ACTIVE", "PENDING", "REJECTED"].includes(b.status)) d.status = b.status;
  save(); res.json(depPublic(d));
});
router.delete("/dependents/:id", allow("GPF", "ADM"), (req, res) => {
  ensure();
  db.dependents = db.dependents.filter(x => !((x.tenantId || "t1") === (req.user.tenantId || "t1") && x.id === req.params.id));
  save(); res.json({ ok: true });
});
/* ---- Bulk import of dependents (seed existing families) ---- */
function depHeaderMap(h) {
  const k = String(h || "").trim().toUpperCase().replace(/\s+/g, " ").replace(/[ÉÈÊ]/g, "E").replace(/\./g, "");
  if (/MATRICULE/.test(k)) return "matricule";
  if (/LIEN|RELATION|FILIATION/.test(k)) return "relation";
  if (/PRENOM/.test(k)) return "firstName";
  if (/^NOM|NOM DE/.test(k)) return "lastName";
  if (/LIEU/.test(k)) return "birthPlace";
  if (/NAISSANCE|^DATE/.test(k)) return "birthDate";
  if (/STATUT|STATUS/.test(k)) return "status";
  return null;
}
router.get("/dependents/template", allow("GPF", "ADM"), (req, res) => {
  const header = ["MATRICULE", "LIEN", "PRENOM", "NOM", "DATE DE NAISSANCE", "LIEU DE NAISSANCE"];
  const ex1 = ["EMP001", "Conjoint", "Marie", "NGONO", "1990-05-12", "Yaoundé"];
  const ex2 = ["EMP001", "Enfant", "Jean", "NGONO", "2015-09-01", "Douala"];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ex1, ex2]), "Ayants droit");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="modele_ayants_droit.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});
router.post("/dependents/import", allow("GPF", "ADM"), memUpload.single("file"), (req, res) => {
  ensure();
  if (!req.file) return res.status(400).json({ error: "Fichier Excel requis." });
  let rows;
  try { const wb = XLSX.read(req.file.buffer, { type: "buffer" }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false, header: 1 }); }
  catch (e) { return res.status(400).json({ error: "Fichier illisible : " + e.message }); }
  if (!rows || rows.length < 2) return res.status(400).json({ error: "Aucune ligne." });
  let hdrIdx = rows.findIndex(r => r.some(c => /MATRICULE/i.test(String(c))));
  if (hdrIdx < 0) hdrIdx = 0;
  const cols = rows[hdrIdx].map(depHeaderMap);
  const empByMat = {}; mine(db.employees, req).forEach(e => { if (e.matricule) empByMat[String(e.matricule).toLowerCase()] = e; });
  const pfById = {}; mine(db.portfolios, req).forEach(p => { pfById[p.id] = p; });
  // seed child counters with existing ACTIVE children so extra-flagging continues correctly
  const childCount = {}; mine(db.dependents, req).forEach(d => { if (d.relation === "CHILD" && d.status === "ACTIVE") childCount[d.employeeId] = (childCount[d.employeeId] || 0) + 1; });
  let added = 0; const errors = [];
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const rec = {}; cols.forEach((k, ci) => { if (k && r[ci] != null) rec[k] = String(r[ci]).trim(); });
    if (!rec.matricule && !rec.firstName && !rec.lastName) continue;
    const e = empByMat[String(rec.matricule || "").toLowerCase()];
    if (!e) { errors.push(`Matricule introuvable : ${rec.matricule || "(vide)"}`); continue; }
    if (!rec.firstName || !rec.lastName) { errors.push(`Nom/prénom manquant pour ${rec.matricule}`); continue; }
    const relation = /CONJOINT|SPOUSE|EPOU|MARI|FEMME/i.test(rec.relation || "") ? "SPOUSE" : "CHILD";
    let extra = false;
    if (relation === "CHILD") {
      const pf = pfById[e.portfolioId]; const quota = (pf && pf.insurance && pf.insurance.freeChildren) || 0;
      const n = (childCount[e.id] || 0); extra = n >= quota; childCount[e.id] = n + 1;
    }
    db.dependents.push(stamp({ id: id("dep"), employeeId: e.id, relation, firstName: rec.firstName, lastName: rec.lastName,
      birthDate: rec.birthDate || "", birthPlace: rec.birthPlace || "", status: "ACTIVE", extra, source: "IMPORT", documents: [], createdAt: now() }, req));
    added++;
  }
  save();
  audit(req.user, "IMPORTED", "Dependent", "-", { added, errors: errors.length });
  res.json({ ok: true, added, errors: errors.slice(0, 20), errorCount: errors.length });
});
// All dependents for the tenant (with employee info), for the web management screen.
router.get("/dependents", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  ensure();
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  res.json(mine(db.dependents, req).map(d => {
    const e = empById[d.employeeId] || {};
    return Object.assign(depPublic(d), { employeeName: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "", portfolioId: e.portfolioId || null });
  }));
});
// GPF review queue (mobile-submitted requests)
router.get("/dependents/pending", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  ensure();
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  res.json(mine(db.dependents, req).filter(d => d.status === "PENDING").sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).map(d => {
    const e = empById[d.employeeId] || {};
    return Object.assign(depPublic(d), { employeeName: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "" });
  }));
});
router.post("/dependents/:id/approve", allow("GPF", "ADM"), (req, res) => {
  ensure();
  const d = mine(db.dependents, req).find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Introuvable" });
  d.status = "ACTIVE"; d.note = ""; save();
  audit(req.user, "VALIDATED", "Dependent", d.id, {});
  try { require("../push").send(db, req.user.tenantId, [d.employeeId], "Ayant droit approuvé", `${d.firstName} ${d.lastName} a été ajouté à votre couverture.`, { type: "dependent", id: d.id }).catch(() => {}); } catch (e) {}
  res.json(depPublic(d));
});
router.post("/dependents/:id/reject", allow("GPF", "ADM"), (req, res) => {
  ensure();
  const d = mine(db.dependents, req).find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Introuvable" });
  d.status = "REJECTED"; d.note = String((req.body && req.body.note) || "").slice(0, 300); save();
  audit(req.user, "REJECTED", "Dependent", d.id, {});
  try { require("../push").send(db, req.user.tenantId, [d.employeeId], "Demande d'ayant droit rejetée", `${d.firstName} ${d.lastName}${d.note ? " — " + d.note : ""}`, { type: "dependent", id: d.id }).catch(() => {}); } catch (e) {}
  res.json(depPublic(d));
});
// Download a dependent's attached document (staff).
router.get("/dependents/:id/document/:idx", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  ensure();
  const d = mine(db.dependents, req).find(x => x.id === req.params.id);
  const doc = d && (d.documents || [])[parseInt(req.params.idx, 10)];
  if (!doc) return res.status(404).json({ error: "Document introuvable" });
  res.download(path.join(DEP_DIR, doc.storedAs), doc.fileName);
});

module.exports = router;
module.exports.DEP_DIR = DEP_DIR;
module.exports.depUpload = depUpload;
module.exports.ensure = ensure;
module.exports.depPublic = depPublic;
