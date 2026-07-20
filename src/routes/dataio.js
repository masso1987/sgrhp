/**
 * Import / export of employee data (§8.4).
 * Export : Excel (multi-sheet) or PDF, with the full field set.
 * Import : upload Excel/CSV -> detect columns -> map to fields -> validate -> import.
 * Reuses the same rules as manual creation (unique CNI/CNPS, portfolio scope,
 * category referential, contract end-date), so imported data is never less valid.
 */
const router = require("express").Router();
const multer = require("multer");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const fr = (d) => d ? new Date(d).toLocaleDateString("fr-FR") : "";

/* Canonical importable/exportable fields (label shown in the mapping UI). */
const FIELDS = [
  { key: "lastName", label: "Nom", required: true },
  { key: "firstName", label: "Prénom(s)", required: true },
  { key: "portfolio", label: "Portefeuille (nom)", required: true },
  { key: "hireDate", label: "Date d'embauche", type: "date", required: true },
  { key: "birthDate", label: "Date de naissance", type: "date", required: true },
  { key: "birthPlace", label: "Lieu de naissance" },
  { key: "maritalStatus", label: "Situation matrimoniale" },
  { key: "address", label: "Adresse" },
  { key: "phone", label: "Téléphone" },
  { key: "email", label: "Email" },
  { key: "emergencyName", label: "Contact d'urgence (nom)" },
  { key: "emergencyPhone", label: "Contact d'urgence (téléphone)" },
  { key: "cniNumber", label: "Numéro CNI", required: true },
  { key: "cniExpiry", label: "Validité CNI", type: "date", required: true },
  { key: "cnpsNumber", label: "Numéro CNPS" },
  { key: "contractType", label: "Type de contrat" },
  { key: "category", label: "Catégorie" },
  { key: "step", label: "Échelon" },
  { key: "paymentMethod", label: "Mode de paiement" },
  { key: "contractEndDate", label: "Date de fin de contrat", type: "date" },
  { key: "salaryBase", label: "Salaire de base", type: "number" },
];

/* ---------------- Export ---------------- */
function exportRows(req) {
  return mine(db.employees, req).map(e => {
    const pf = mine(db.portfolios, req).find(p => p.id === e.portfolioId);
    const cnv = mine(db.conventions, req).find(c => c.id === pf?.conventionId);
    const c = e.contract || {};
    const gross = Object.values(e.salary || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return {
      "Nom": e.lastName, "Prénom(s)": e.firstName,
      "Portefeuille": pf?.name || "", "Convention": cnv?.name || "",
      "Date d'embauche": fr(e.hireDate), "Date de naissance": fr(e.birthDate),
      "Lieu de naissance": e.birthPlace || "", "Situation matrimoniale": e.maritalStatus || "",
      "Adresse": e.address || "", "Téléphone": e.phone || "", "Email": e.email || "",
      "Contact urgence (nom)": e.emergencyName || "", "Contact urgence (tél)": e.emergencyPhone || "",
      "N° CNI": e.cniNumber, "Validité CNI": fr(e.cniExpiry), "N° CNPS": e.cnpsNumber || "",
      "Type de contrat": c.type || "", "Catégorie": c.category || "", "Échelon": c.step || "",
      "Mode de paiement": c.paymentMethod || "",
      "Début contrat": fr(c.startDate), "Fin contrat": c.type === "CDI" ? "Indéterminée" : fr(c.endDate),
      "Salaire de base": (e.salary && e.salary["Salaire de base"]) || "",
      "Salaire brut total": gross || "",
      "Statut dossier": e.status || "",
    };
  });
}

router.get("/export", allow("CD", "RJ", "ADM"), (req, res) => {
  const fmt = (req.query.format || "xlsx").toLowerCase();
  const rows = exportRows(req);
  audit(req.user, "EXPORTED", "Employees", "all", { format: fmt, count: rows.length });

  if (fmt === "xlsx" || fmt === "csv") {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Employés");
    // reference sheets that make re-import easy
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
      mine(db.portfolios, req).map(p => ({ Portefeuille: p.name,
        Convention: (mine(db.conventions, req).find(c => c.id === p.conventionId) || {}).name || "" }))), "Portefeuilles");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
      (mine(db.referentials, req).find(r => r.key === "categories")?.values || []).map(v => ({ Catégorie: v }))), "Catégories");
    const type = fmt === "csv" ? "csv" : "xlsx";
    const buf = XLSX.write(wb, { type: "buffer", bookType: type });
    res.setHeader("Content-Type", fmt === "csv" ? "text/csv"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="employes_${Date.now()}.${type}"`);
    return res.send(buf);
  }

  if (fmt === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="employes_${Date.now()}.pdf"`);
    const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
    doc.pipe(res);
    doc.fontSize(14).fillColor("#1e3a5f").font("Helvetica-Bold").text("CIBLE RH EMPLOI S.A.", { align: "center" });
    doc.fontSize(11).text(`Liste du personnel — ${rows.length} employés`, { align: "center" });
    doc.fontSize(7.5).fillColor("#777").font("Helvetica")
      .text(`Édité le ${new Date().toLocaleString("fr-FR")} par ${req.user.fullName || req.user.id}`, { align: "center" });
    doc.moveDown(.6);
    const cols = ["Nom", "Prénom(s)", "Portefeuille", "Type de contrat", "Catégorie", "N° CNI", "Validité CNI", "N° CNPS", "Téléphone"];
    const L = 30, R = 812, W = (R - L) / cols.length;
    const header = () => { const y = doc.y; doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#444");
      cols.forEach((c, i) => doc.text(c, L + i * W, y, { width: W - 3 }));
      doc.y = y + 12; doc.moveTo(L, doc.y - 3).lineTo(R, doc.y - 3).strokeColor("#e8833a").lineWidth(1).stroke(); };
    header();
    doc.font("Helvetica").fillColor("#000").fontSize(7.5);
    for (const row of rows) {
      if (doc.y > 540) { doc.addPage({ layout: "landscape" }); header(); doc.font("Helvetica").fillColor("#000").fontSize(7.5); }
      const y = doc.y;
      cols.forEach((c, i) => doc.text(String(row[c] ?? ""), L + i * W, y, { width: W - 3 }));
      doc.y = y + 11;
    }
    return doc.end();
  }
  res.status(400).json({ error: "format doit être xlsx, csv ou pdf" });
});

/** Downloadable import template with the exact expected columns. */
router.get("/import/template", allow("GPF", "ADM"), (req, res) => {
  const wb = XLSX.utils.book_new();
  const header = {}; FIELDS.forEach(f => header[f.label] = "");
  const example = { "Nom": "OUATTARA", "Prénom(s)": "Karim", "Portefeuille": mine(db.portfolios, req)[0]?.name || "",
    "Date d'embauche": "2026-03-02", "Date de naissance": "1994-06-14", "Numéro CNI": "CI000001",
    "Validité CNI": "2030-01-01", "Type de contrat": "CDI", "Catégorie": "B2" };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([header, example]), "Modèle import");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="modele_import_employes.xlsx"');
  res.send(buf);
});

/* ---------------- Import ---------------- */
router.get("/import/fields", allow("GPF", "ADM"), (req, res) => res.json(FIELDS));

/** Step 1 — upload the file, return detected columns + a preview + an auto-mapping guess. */
router.post("/import/analyze", allow("GPF", "ADM"), upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier requis (Excel ou CSV)" });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  } catch (e) { return res.status(400).json({ error: "Fichier illisible : " + e.message }); }
  if (!rows.length) return res.status(400).json({ error: "Le fichier ne contient aucune ligne" });

  const columns = Object.keys(rows[0]);
  const norm = s => String(s).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
  const mapping = {}, used = new Set();
  // exact match first, then containment (so "Portefeuille" maps to "Portefeuille (nom)")
  for (const pass of ["exact", "loose"]) {
    for (const f of FIELDS) {
      if (mapping[f.key]) continue;
      const nf = norm(f.label), nk = norm(f.key);
      const hit = columns.find(c => { if (used.has(c)) return false; const nc = norm(c);
        return pass === "exact" ? (nc === nf || nc === nk)
          : (nc && nf && (nc.includes(nf) || nf.includes(nc)));
      });
      if (hit) { mapping[f.key] = hit; used.add(hit); }
    }
  }
  const token = id("imp");
  db._imports = db._imports || {};
  db._imports[token] = { rows, at: Date.now(), by: req.user.id };
  // keep only recent staging sets
  for (const [k, v] of Object.entries(db._imports)) if (Date.now() - v.at > 30 * 60000) delete db._imports[k];

  res.json({ token, columns, rowCount: rows.length,
    preview: rows.slice(0, 5), suggestedMapping: mapping, fields: FIELDS });
});

/** Step 2 — validate the mapping against real data without writing (dry run). */
function validateRows(rows, mapping, user, { commit } = {}) {
  const req = { user };   // for tenant-scoped mine()
  const cats = mine(db.referentials, req).find(r => r.key === "categories")?.values || [];
  const ctypes = mine(db.contractTypes, req).map(t => t.name);
  const scopedPf = user.role === "GPF"
    ? (db.users.find(u => u.id === user.id)?.portfolioIds || []) : null;
  const seenCni = new Set(mine(db.employees, req).map(e => e.cniNumber));
  const seenCnps = new Set(mine(db.employees, req).filter(e => e.cnpsNumber).map(e => e.cnpsNumber));
  const results = [];
  const created = [];

  const val = (row, key) => mapping[key] ? String(row[mapping[key]] ?? "").trim() : "";
  const toISO = (s) => {
    if (!s) return "";
    const m = String(s).match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // DD/MM/YYYY
    if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return String(s).slice(0, 10);
    const d = new Date(s); return isNaN(d) ? String(s) : d.toISOString().slice(0, 10);
  };

  rows.forEach((row, i) => {
    const errs = [];
    const get = k => val(row, k);
    for (const f of FIELDS) if (f.required && !get(f.key)) errs.push(`${f.label} manquant`);

    const pfName = get("portfolio");
    const pf = mine(db.portfolios, req).find(p => p.name.toLowerCase() === pfName.toLowerCase());
    if (pfName && !pf) errs.push(`Portefeuille inconnu : ${pfName}`);
    if (pf && scopedPf && !scopedPf.includes(pf.id)) errs.push("Portefeuille non rattaché à vous");

    const cni = get("cniNumber");
    if (cni && seenCni.has(cni)) errs.push(`CNI en doublon : ${cni}`);
    const cnps = get("cnpsNumber");
    if (cnps && seenCnps.has(cnps)) errs.push(`CNPS en doublon : ${cnps}`);

    const cat = get("category");
    if (cat && !cats.includes(cat)) errs.push(`Catégorie inconnue : ${cat}`);
    const ctype = get("contractType") || "CDI";
    if (get("contractType") && !ctypes.includes(ctype)) errs.push(`Type de contrat inconnu : ${ctype}`);
    const fixed = (mine(db.contractTypes, req).find(t => t.name === ctype) || {}).fixedTerm;
    if (fixed && !get("contractEndDate")) errs.push(`${ctype} exige une date de fin`);

    if (errs.length === 0 && !seenCni.has(cni)) { seenCni.add(cni); if (cnps) seenCnps.add(cnps); }
    results.push({ line: i + 2, name: `${get("lastName")} ${get("firstName")}`.trim(), errors: errs });

    if (commit && errs.length === 0) {
      const salary = {};
      if (get("salaryBase")) salary["Salaire de base"] = Number(String(get("salaryBase")).replace(/\s/g, ""));
      const emp = {
        id: id("emp"), status: "DRAFT", createdBy: user.id, createdAt: new Date().toISOString(),
        firstName: get("firstName"), lastName: get("lastName"), portfolioId: pf.id,
        hireDate: toISO(get("hireDate")), birthDate: toISO(get("birthDate")), birthPlace: get("birthPlace"),
        maritalStatus: get("maritalStatus"), address: get("address"), phone: get("phone"), email: get("email"),
        emergencyName: get("emergencyName"), emergencyPhone: get("emergencyPhone"),
        emergencyContact: [get("emergencyName"), get("emergencyPhone")].filter(Boolean).join(" — "),
        cniNumber: cni, cniExpiry: toISO(get("cniExpiry")), cnpsNumber: cnps,
        contract: { type: ctype, category: cat || undefined, step: get("step") || undefined,
          paymentMethod: get("paymentMethod") || undefined, startDate: toISO(get("hireDate")),
          endDate: fixed ? toISO(get("contractEndDate")) : null },
        salary,
      };
      emp.tenantId = user.tenantId || "t1"; db.employees.push(emp); created.push(emp.id);
    }
  });

  const valid = results.filter(r => r.errors.length === 0).length;
  return { total: rows.length, valid, invalid: rows.length - valid, results, created };
}

router.post("/import/validate", allow("GPF", "ADM"), (req, res) => {
  const { token, mapping } = req.body || {};
  const staged = (db._imports || {})[token];
  if (!staged) return res.status(400).json({ error: "Session d'import expirée — recommencez" });
  for (const f of FIELDS) if (f.required && !mapping?.[f.key])
    return res.status(400).json({ error: `Colonne obligatoire non mappée : ${f.label}` });
  res.json(validateRows(staged.rows, mapping, req.user, { commit: false }));
});

/** Step 3 — commit valid rows (invalid ones are skipped and reported). */
router.post("/import/commit", allow("GPF", "ADM"), (req, res) => {
  const { token, mapping } = req.body || {};
  const staged = (db._imports || {})[token];
  if (!staged) return res.status(400).json({ error: "Session d'import expirée — recommencez" });
  const out = validateRows(staged.rows, mapping, req.user, { commit: true });
  save();
  delete db._imports[token];
  audit(req.user, "IMPORTED", "Employees", "batch", { imported: out.created.length, skipped: out.invalid });
  res.json({ imported: out.created.length, skipped: out.invalid, results: out.results });
});

module.exports = router;
