/**
 * Fiche de Prix — simulateur de coût de mise à disposition (staffing) -> prix client.
 * Chaîne : éléments de salaire -> brut -> provisions (congés=1/12, fin contrat=brut*35%/12)
 * -> sous-total 1 -> charges patronales (16,2%) -> frais fixes -> total 2 (contributions)
 * -> marge admin (15%) -> HT -> TVA (19,25%) -> TTC. Tous les taux sont configurables.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
if (!db.fichesPrix) db.fichesPrix = [];

const DEFAULT_PARAMS = {
  chargesPatronalesPct: 16.2, margePct: 15, tvaPct: 19.25,
  provisionCongesDiv: 12, provisionFinContratPct: 35,
  fraisFixes: [
    { label: "Frais d'assurance", amount: 10000 },
    { label: "Frais de communication mensuel", amount: 20000 },
    { label: "Indemnité de déplacement", amount: 0 },
    { label: "Visite médicale", amount: 8000 },
  ],
};
const DEFAULT_ELEMENTS = ["Salaire de base", "Sursalaire", "Prime d'ancienneté",
  "Indemnité de logement", "Indemnité de transport", "Prime de risque",
  "Prime de documentation", "Prime de salissure"];

const N = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
function compute(f) {
  const els = f.elements || [];
  const brut = els.reduce((s, e) => s + N(e.amount), 0);
  const p = Object.assign({}, DEFAULT_PARAMS, f.params || {});
  const provConges = p.provisionCongesDiv ? brut / N(p.provisionCongesDiv) : 0;
  const provFin = brut * (N(p.provisionFinContratPct) / 100) / 12;
  const sousTotal1 = brut + provConges + provFin;
  const chargesPatronales = sousTotal1 * (N(p.chargesPatronalesPct) / 100);
  const fraisFixes = (p.fraisFixes || []).reduce((s, x) => s + N(x.amount), 0);
  const total2 = sousTotal1 + chargesPatronales + fraisFixes;
  const marge = total2 * (N(p.margePct) / 100);
  const ht = total2 + marge;
  const tva = ht * (N(p.tvaPct) / 100);
  const ttc = ht + tva;
  const r = (x) => Math.round(x * 100) / 100;
  return { brut: r(brut), provConges: r(provConges), provFin: r(provFin), sousTotal1: r(sousTotal1),
    chargesPatronales: r(chargesPatronales), fraisFixes: r(fraisFixes), total2: r(total2),
    marge: r(marge), ht: r(ht), tva: r(tva), ttc: r(ttc) };
}

/* Nombre entier -> lettres (français), pour la ligne "montant en toutes lettres". */
function frWords(n) {
  n = Math.round(Math.abs(Number(n) || 0));
  if (n === 0) return "zéro";
  const u = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
    "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const t = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "", "quatre-vingt", ""];
  function b100(x) {
    if (x < 20) return u[x];
    const d = Math.floor(x / 10), r = x % 10;
    if (d === 7 || d === 9) { const base = d === 7 ? "soixante" : "quatre-vingt"; return base + "-" + u[10 + r]; }
    let w = t[d];
    if (r === 0) { if (d === 8) w += "s"; }
    else if (r === 1 && d >= 2 && d <= 6) w += " et un";
    else w += "-" + u[r];
    return w;
  }
  function b1000(x) {
    const c = Math.floor(x / 100), r = x % 100; let w = "";
    if (c > 0) { w += (c > 1 ? u[c] + " " : "") + "cent"; if (c > 1 && r === 0) w += "s"; }
    if (r > 0) w += (w ? " " : "") + b100(r);
    return w;
  }
  const groups = []; let x = n;
  while (x > 0) { groups.push(x % 1000); x = Math.floor(x / 1000); }
  const out = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; if (g === 0) continue;
    if (i === 1) out.push((g === 1 ? "" : b1000(g) + " ") + "mille");
    else if (i === 0) out.push(b1000(g));
    else { const name = i === 2 ? "million" : "milliard"; out.push(b1000(g) + " " + name + (g > 1 ? "s" : "")); }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

router.get("/defaults", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json({ params: DEFAULT_PARAMS, elements: DEFAULT_ELEMENTS }));

router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) =>
  res.json(mine(db.fichesPrix, req).map(f => ({ ...f, computed: compute(f) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))));

router.get("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const c = compute(f);
  res.json({ ...f, computed: c, ttcWords: (frWords(Math.round(c.ttc)) + " francs CFA").replace(/^./, s => s.toUpperCase()) });
});

router.post("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const b = req.body || {};
  const f = stamp({
    id: id("fp"), ref: "FP-" + Date.now().toString(36).toUpperCase(),
    title: b.title || "Simulation", client: b.client || "", employeeName: b.employeeName || "",
    hiringDate: b.hiringDate || "", conventionId: b.conventionId || "", conventionName: b.conventionName || "",
    category: b.category || "", elements: Array.isArray(b.elements) ? b.elements : [],
    params: b.params || JSON.parse(JSON.stringify(DEFAULT_PARAMS)),
    createdAt: new Date().toISOString(), createdBy: req.user.id,
  }, req);
  db.fichesPrix.push(f); save();
  audit(req.user, "CREATED", "FichePrix", f.id, { title: f.title });
  res.status(201).json({ ...f, computed: compute(f) });
});

router.put("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  ["title", "client", "employeeName", "hiringDate", "conventionId", "conventionName", "category"].forEach(k => { if (b[k] !== undefined) f[k] = b[k]; });
  if (Array.isArray(b.elements)) f.elements = b.elements;
  if (b.params) f.params = b.params;
  f.updatedAt = new Date().toISOString(); save();
  audit(req.user, "UPDATED", "FichePrix", f.id, {});
  res.json({ ...f, computed: compute(f) });
});

router.delete("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  db.fichesPrix = db.fichesPrix.filter(x => x.id !== f.id); save();
  audit(req.user, "DELETED", "FichePrix", f.id, {});
  res.json({ ok: true });
});

function dataUrlToBuffer(d) {
  if (!d || typeof d !== "string") return null;
  const m = d.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return null;
  try { return { buf: Buffer.from(m[2], "base64"), ext: m[1].toLowerCase().startsWith("jp") ? "jpeg" : "png" }; }
  catch (e) { return null; }
}
function brandCtx(req) {
  let b = {}; try { b = require("./settings").settings().branding || {}; } catch (e) {}
  const t = (db.tenants || []).find(x => x.id === (req.user.tenantId || "t1")) || {};
  const co = b.company || {};
  return {
    name: co.name || b.tagline || t.name || b.appName || "SGRHP",
    address: [co.address, co.city].filter(Boolean).join(", ") || [t.hqAddress, t.hqCity].filter(Boolean).join(", "),
    niu: co.niu || t.niu || "",
    contact: [t.phone, t.email].filter(Boolean).join(" \u00b7 "),
    logo: dataUrlToBuffer(b.logo || t.logo),
  };
}
function buildRows(f, c, p) {
  const rows = [];
  (f.elements || []).forEach(e => rows.push([e.label || "", N(e.amount), false]));
  rows.push(["SALAIRE BRUT", c.brut, true]);
  rows.push(["Provision cong\u00e9s (1/12)", c.provConges, false]);
  rows.push(["Provision fin de contrat", c.provFin, false]);
  rows.push(["SOUS-TOTAL 1", c.sousTotal1, true]);
  rows.push(["Charges patronales (" + p.chargesPatronalesPct + "%)", c.chargesPatronales, false]);
  (p.fraisFixes || []).forEach(x => rows.push([x.label || "Frais", N(x.amount), false]));
  rows.push(["TOTAL 2 (contributions employeur)", c.total2, true]);
  rows.push(["Charges administratives + marge (" + p.margePct + "%)", c.marge, false]);
  rows.push(["MONTANT HT", c.ht, true]);
  rows.push(["TVA (" + p.tvaPct + "%)", c.tva, false]);
  rows.push(["MONTANT TTC", c.ttc, true]);
  return rows;
}
const ttcWords = (c) => (frWords(Math.round(c.ttc)) + " francs CFA").replace(/^./, s => s.toUpperCase());

router.get("/:id/export", allow("GPF", "CD", "RJ", "ADM"), async (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const c = compute(f); const p = Object.assign({}, DEFAULT_PARAMS, f.params || {});
  const rows = buildRows(f, c, p); const brand = brandCtx(req); const words = ttcWords(c);
  const fname = 'attachment; filename="fiche_prix.xlsx"';
  const ctype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  // Prefer ExcelJS (embeds the company logo); fall back to xlsx (branded text header).
  try {
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Fiche de prix");
    ws.columns = [{ width: 46 }, { width: 20 }];
    let r = 1;
    if (brand.logo) { try { const imgId = wb.addImage({ buffer: brand.logo.buf, extension: brand.logo.ext }); ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 120, height: 50 } }); r = 4; } catch (e) {} }
    ws.getCell("B1").value = brand.name; ws.getCell("B1").font = { bold: true, size: 12 };
    ws.getCell("B2").value = brand.address; ws.getCell("B3").value = brand.contact;
    r = Math.max(r, 4);
    ws.getCell("A" + r).value = "FICHE DE PRIX"; ws.getCell("A" + r).font = { bold: true, size: 14 }; r += 2;
    [["Titre", f.title], ["Client", f.client], ["Salari\u00e9 / candidat", f.employeeName], ["Convention", f.conventionName], ["Cat\u00e9gorie", f.category], ["Date d'embauche", f.hiringDate]]
      .forEach(m => { ws.getCell("A" + r).value = m[0]; ws.getCell("A" + r).font = { bold: true }; ws.getCell("B" + r).value = m[1] || ""; r++; });
    r++;
    ws.getCell("A" + r).value = "\u00c9L\u00c9MENTS / RUBRIQUES"; ws.getCell("B" + r).value = "Montant (XAF)"; ws.getRow(r).font = { bold: true }; r++;
    rows.forEach(row => { ws.getCell("A" + r).value = row[0]; const cell = ws.getCell("B" + r); cell.value = row[1]; cell.numFmt = "#,##0"; if (row[2]) ws.getRow(r).font = { bold: true }; r++; });
    r++; ws.getCell("A" + r).value = "Arr\u00eat\u00e9 \u00e0 la somme de"; ws.getCell("A" + r).font = { bold: true }; ws.getCell("B" + r).value = words;
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Disposition", fname); res.setHeader("Content-Type", ctype);
    return res.send(Buffer.from(buf));
  } catch (e) {
    let XLSX; try { XLSX = require("xlsx"); } catch (e2) { return res.status(500).json({ error: "Module Excel indisponible" }); }
    const aoa = [[brand.name], [brand.address], [brand.contact], [], ["FICHE DE PRIX"],
      ["Titre", f.title || ""], ["Client", f.client || ""], ["Salari\u00e9 / candidat", f.employeeName || ""],
      ["Convention", f.conventionName || ""], ["Cat\u00e9gorie", f.category || ""], ["Date d'embauche", f.hiringDate || ""],
      [], ["\u00c9L\u00c9MENTS / RUBRIQUES", "Montant (XAF)"]];
    rows.forEach(rw => aoa.push([rw[0], rw[1]])); aoa.push([]); aoa.push(["Arr\u00eat\u00e9 \u00e0 la somme de", words]);
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 46 }, { wch: 20 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Fiche de prix");
    res.setHeader("Content-Disposition", fname); res.setHeader("Content-Type", ctype);
    return res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  }
});

router.get("/:id/pdf", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  let PDFDocument; try { PDFDocument = require("pdfkit"); } catch (e) { return res.status(500).json({ error: "PDF indisponible" }); }
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const c = compute(f); const p = Object.assign({}, DEFAULT_PARAMS, f.params || {});
  const rows = buildRows(f, c, p); const brand = brandCtx(req); const words = ttcWords(c);
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="fiche_prix.pdf"');
  doc.pipe(res);
  let y = 40;
  if (brand.logo) { try { doc.image(brand.logo.buf, 40, y, { fit: [120, 54] }); } catch (e) {} }
  doc.fontSize(14).font("Helvetica-Bold").fillColor("#111111").text(brand.name, 170, y, { width: 385 });
  doc.fontSize(9).font("Helvetica").fillColor("#555555").text([brand.address, brand.contact, brand.niu ? ("NIU: " + brand.niu) : ""].filter(Boolean).join("\n"), 170, y + 18, { width: 385 });
  doc.fillColor("#111111"); y += 74;
  doc.moveTo(40, y).lineTo(555, y).strokeColor("#cccccc").stroke(); y += 12;
  doc.fontSize(16).font("Helvetica-Bold").text("FICHE DE PRIX", 40, y); y += 20;
  doc.fontSize(9).font("Helvetica").fillColor("#666666").text("R\u00e9f. " + (f.ref || "") + "   \u00b7   " + new Date().toLocaleDateString("fr-FR"), 40, y); doc.fillColor("#111111"); y += 22;
  const info = (l, v) => { doc.fontSize(10).font("Helvetica-Bold").fillColor("#111111").text(l + " :", 40, y, { width: 150 }); doc.font("Helvetica").text(v || "-", 160, y, { width: 395 }); y += 15; };
  info("Titre", f.title); info("Client", f.client); info("Salari\u00e9 / candidat", f.employeeName); info("Convention", f.conventionName); info("Cat\u00e9gorie", f.category); info("Date d'embauche", f.hiringDate);
  y += 8;
  const money = x => Math.round(Number(x) || 0).toLocaleString("fr-FR") + " FCFA";
  doc.rect(40, y, 515, 18).fill("#f0f0f0"); doc.fillColor("#111111").fontSize(10).font("Helvetica-Bold");
  doc.text("\u00c9l\u00e9ment / rubrique", 46, y + 4); doc.text("Montant", 405, y + 4, { width: 144, align: "right" }); y += 22;
  rows.forEach(row => {
    if (y > 770) { doc.addPage(); y = 40; }
    doc.fontSize(10).font(row[2] ? "Helvetica-Bold" : "Helvetica").fillColor("#111111");
    doc.text(row[0], 46, y, { width: 350 }); doc.text(money(row[1]), 405, y, { width: 144, align: "right" }); y += 15;
    if (row[2]) { doc.moveTo(40, y - 2).lineTo(555, y - 2).strokeColor("#e5e5e5").stroke(); }
  });
  y += 10; doc.fontSize(10).font("Helvetica-Oblique").fillColor("#333333").text("Arr\u00eat\u00e9 \u00e0 la somme de : " + words, 40, y, { width: 515 });
  doc.fontSize(8).fillColor("#999999").font("Helvetica").text(brand.name + " \u2014 g\u00e9n\u00e9r\u00e9 par SGRHP le " + new Date().toLocaleDateString("fr-FR"), 40, 805, { width: 515, align: "center" });
  doc.end();
});

module.exports = router;