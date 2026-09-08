/** Complete employee file export as PDF — all information in one document. */
const router = require("express").Router();
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");
const { db } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");

router.get("/:id/export", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: "Not found" });
  const pf = mine(db.portfolios, req).find(p => p.id === emp.portfolioId);
  const files = mine(db.files, req).filter(f => f.employeeId === emp.id);
  const docs = mine(db.documents, req).filter(d => d.refId === emp.id);
  const decisions = mine(db.decisions, req).filter(d => d.employeeId === emp.id);
  const fr = d => d ? new Date(d).toLocaleDateString("fr-FR") : "—";

  audit(req.user, "EXPORTED", "Employee", emp.id, { name: `${emp.firstName} ${emp.lastName}` });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Dossier_${emp.lastName}_${emp.firstName}.pdf"`);

  const doc = new PDFDocument({ margin: 46, size: "A4" });
  doc.pipe(res);
  const H = (t) => { doc.moveDown(.6).fontSize(12).fillColor("#1e3a5f").font("Helvetica-Bold").text(t); 
    doc.moveTo(doc.x, doc.y + 1).lineTo(549, doc.y + 1).strokeColor("#e8833a").lineWidth(1.5).stroke(); doc.moveDown(.3); };
  const KV = (k, v) => { doc.fontSize(9.5).font("Helvetica-Bold").fillColor("#444").text(k + " : ", { continued: true })
    .font("Helvetica").fillColor("#000").text(String(v ?? "—")); };

  // Photo d'identité 4x4 (type III) en haut à gauche du dossier.
  const PW = 113, PH = 113, PX = 46, PY = 46;   // 4 cm ≈ 113 pt
  const photo = files.find(f => f.docType === "III" && /image\/(png|jpe?g)/i.test(f.contentType || ""));
  let photoDrawn = false;
  if (photo) {
    try {
      const fp = path.join(__dirname, "..", "..", "uploads", photo.storedAs);
      if (fs.existsSync(fp)) { doc.image(fp, PX, PY, { fit: [PW, PH], align: "center", valign: "center" }); photoDrawn = true; }
    } catch (e) { photoDrawn = false; }
  }
  if (photoDrawn) doc.rect(PX, PY, PW, PH).strokeColor("#1e3a5f").lineWidth(1).stroke();

  // Bloc titre : décalé à droite de la photo pour éviter le chevauchement.
  const tx = photoDrawn ? PX + PW + 14 : PX;
  const tw = 549 - tx;
  doc.fontSize(16).fillColor("#1e3a5f").font("Helvetica-Bold").text("CIBLE RH EMPLOI S.A.", tx, PY + 6, { width: tw, align: "center" });
  doc.fontSize(13).text(`DOSSIER EMPLOYÉ — ${emp.firstName} ${emp.lastName}`, tx, doc.y, { width: tw, align: "center" });
  doc.fontSize(8).fillColor("#777").font("Helvetica")
    .text(`Généré le ${new Date().toLocaleString("fr-FR")} par ${req.user.fullName || req.user.id} — Confidentiel`, tx, doc.y, { width: tw, align: "center" });
  // Reprendre sous la photo/titre, pleine largeur.
  doc.x = 46; doc.y = Math.max(doc.y, PY + PH + 8);

  H("1. Informations personnelles");
  KV("Nom & Prénoms", `${emp.firstName} ${emp.lastName}`);
  KV("Né(e) le", `${fr(emp.birthDate)} à ${emp.birthPlace || "—"}`);
  KV("Situation matrimoniale", emp.maritalStatus);
  KV("Adresse", emp.address); KV("Téléphone", emp.phone); KV("Email", emp.email);
  KV("Contact d'urgence", emp.emergencyContact);
  KV("CNI", `${emp.cniNumber} (expire ${fr(emp.cniExpiry)})`);
  KV("N° CNPS", emp.cnpsNumber);

  H("2. Contrat");
  KV("Portefeuille", pf?.name);
  KV("Date d'embauche", fr(emp.hireDate));
  KV("Type de contrat", emp.contract?.type);
  KV("Catégorie / Échelon", `${emp.contract?.category || "—"} / ${emp.contract?.step || "—"}`);
  KV("Début", fr(emp.contract?.startDate));
  KV("Fin", emp.contract?.type === "CDI" ? "Durée indéterminée" : fr(emp.contract?.endDate));
  KV("Mode de paiement", emp.contract?.paymentMethod);
  if (emp.salary && Object.keys(emp.salary).length) {
    doc.moveDown(.2).fontSize(9.5).font("Helvetica-Bold").fillColor("#444").text("Éléments de salaire :");
    let tot = 0;
    for (const [k, v] of Object.entries(emp.salary)) { tot += Number(v) || 0;
      KV("   " + k, Number(v).toLocaleString("fr-FR") + " F CFA"); }
    KV("   TOTAL BRUT", tot.toLocaleString("fr-FR") + " F CFA");
  }

  H("3. Pièces du dossier (" + files.length + ")");
  files.forEach(f => KV(f.docType, `${f.fileName} — déposé le ${fr(f.uploadedAt)}${f.expiryDate ? ", expire " + fr(f.expiryDate) : ""}`));
  if (!files.length) doc.fontSize(9.5).font("Helvetica").text("Aucune pièce.");

  const am = docs.filter(d => d.type === "AMENDMENT");
  H("4. Avenants (" + am.length + ")");
  am.forEach(a => KV(`Avenant n°${a.version}${a.data.avenantType ? " — " + a.data.avenantType : ""}`,
    `${Object.entries(a.data.changes).map(([k, v]) => `${k}→${v ?? "—"}`).join(", ")} [${a.status}]`));
  if (!am.length) doc.fontSize(9.5).font("Helvetica").text("Aucun avenant.");

  H("5. Décisions & sanctions (" + decisions.length + ")");
  decisions.forEach(d => KV(d.date, `${d.type}${d.detail ? " — " + d.detail : ""}${d.fileName ? " (PJ: " + d.fileName + ")" : ""}`));
  if (!decisions.length) doc.fontSize(9.5).font("Helvetica").text("Aucune décision.");

  const lv = docs.filter(d => d.type === "LEAVE");
  H("6. Congés & permissions (" + lv.length + ")");
  lv.forEach(l => KV(l.data.leaveType, `${fr(l.data.startDate)} → ${fr(l.data.endDate)} (${l.data.days || "—"} j) [${l.status}]`));
  if (!lv.length) doc.fontSize(9.5).font("Helvetica").text("Aucune demande.");

  const wf = docs.filter(d => ["EMPLOYEE_FILE", "TEMPLATE_DOC"].includes(d.type));
  H("7. Documents générés & workflow (" + wf.length + ")");
  wf.forEach(d => KV(d.title, `cycle ${d.cycle} — ${d.status}`));

  doc.end();
});
module.exports = router;
