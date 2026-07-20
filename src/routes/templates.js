const router = require("express").Router();
const path = require("path");
const multer = require("multer");
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");
const engine = require("../templateEngine");

const upload = multer({
  storage: multer.diskStorage({
    destination: engine.TPL_DIR,
    filename: (req, f, cb) => cb(null, `${Date.now()}-${f.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
  fileFilter: (req, f, cb) => cb(null, f.originalname.toLowerCase().endsWith(".docx")),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.templates, req)));

// ADM uploads a Word template; placeholders are scanned automatically
router.post("/", allow("ADM"), upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "A .docx file is required" });
    const tags = engine.scanTags(req.file.path);
    if (!tags.length) return res.status(400).json({
      error: "No {{placeholders}} found. Insert tags like {{employee_fullName}} in the Word document." });
    const t = { id: id("tpl"), name: req.body.name || req.file.originalname.replace(/\.docx$/i, ""),
      docType: req.body.docType || "CONTRACT", storedAs: req.file.filename,
      originalName: req.file.originalname, tags,
      uploadedBy: req.user.id, uploadedAt: new Date().toISOString() };
    t.tenantId = req.user.tenantId || "t1"; db.templates.push(t); save();
    audit(req.user, "CREATED", "Template", t.id, { name: t.name, tags: tags.length });
    res.status(201).json(t);
  } catch (e) { next(e); }
});

// Preview resolution for an employee: what auto-fills, what's missing
router.get("/:id/resolve/:employeeId", allow("GPF", "ADM"), (req, res, next) => {
  try {
    const { resolved, missing } = engine.resolve(req.params.id, req.params.employeeId);
    res.json({ resolved, missing });
  } catch (e) { next(e); }
});

module.exports = router;

/* ================= Template Studio (§3.3) =================
 * Turn a normal Word document (attestation, certificat...) into a template:
 * 1) POST /raw          — upload .docx, returns extracted text + rawId
 * 2) POST /raw/:id/tagify — {replacements:[{find,tag}], name, docType}
 *    replaces each 'find' text with {{tag}} (even across Word runs) and
 *    registers the result as a generation template.
 */
const fs = require("fs");
const PizZip = require("pizzip");

router.post("/raw", allow("ADM"), upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: ".docx file required" });
    const zip = new PizZip(fs.readFileSync(req.file.path));
    const xml = zip.file("word/document.xml").asText();
    const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(" ")
      .replace(/\s+/g, " ").trim();
    const raw = { id: id("raw"), storedAs: req.file.filename, originalName: req.file.originalname,
      uploadedBy: req.user.id, uploadedAt: new Date().toISOString() };
    raw.tenantId = req.user.tenantId || "t1"; db.rawTemplates.push(raw); save();
    res.status(201).json({ id: raw.id, name: req.file.originalname, text: text.slice(0, 8000) });
  } catch (e) { next(e); }
});

router.post("/raw/:id/tagify", allow("ADM"), (req, res, next) => {
  try {
    const raw = db.rawTemplates.find(r => r.id === req.params.id);
    if (!raw) return res.status(404).json({ error: "Raw document not found" });
    const { replacements, name, docType } = req.body || {};
    if (!Array.isArray(replacements) || !replacements.length)
      return res.status(400).json({ error: "replacements array required [{find, tag}]" });
    for (const r of replacements)
      if (!r.find || !r.tag || !/^[\w.]+$/.test(r.tag))
        return res.status(400).json({ error: "Each replacement needs 'find' text and a valid 'tag' (letters/numbers/_)" });

    const filePath = require("path").join(engine.TPL_DIR, raw.storedAs);
    const zip = new PizZip(fs.readFileSync(filePath));
    let xml = zip.file("word/document.xml").asText();
    const notFound = [];

    for (const { find, tag } of replacements) {
      let hit = false;
      // pass 1: direct replace when the text is inside a single run
      if (xml.includes(find)) { xml = xml.split(find).join(`{{${tag}}}`); hit = true; }
      else {
        // pass 2: text split across runs — rebuild each paragraph's text
        xml = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (para) => {
          const texts = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]);
          const joined = texts.join("");
          if (!joined.includes(find)) return para;
          hit = true;
          const replaced = joined.split(find).join(`{{${tag}}}`);
          let first = true;
          return para.replace(/(<w:t[^>]*>)[^<]*(<\/w:t>)/g, (m, a, b) => {
            if (first) { first = false; return `<w:t xml:space="preserve">${replaced}</w:t>`; }
            return `${a}${b}`;
          });
        });
      }
      if (!hit) notFound.push(find);
    }
    if (notFound.length)
      return res.status(422).json({ error: "Text not found in document: " + notFound.join(" | "), notFound });

    zip.file("word/document.xml", xml);
    const outName = `${Date.now()}-studio-${raw.originalName.replace(/[^\w.\-]/g, "_")}`;
    fs.writeFileSync(require("path").join(engine.TPL_DIR, outName), zip.generate({ type: "nodebuffer" }));
    const tags = engine.scanTags(require("path").join(engine.TPL_DIR, outName));
    const t = { id: id("tpl"), name: name || raw.originalName.replace(/\.docx$/i, "") + " (template)",
      docType: docType || "ATTESTATION", storedAs: outName, originalName: raw.originalName, tags,
      uploadedBy: req.user.id, uploadedAt: new Date().toISOString() };
    t.tenantId = req.user.tenantId || "t1"; db.templates.push(t); save();
    audit(req.user, "CREATED", "Template", t.id, { studio: true, name: t.name, tags: tags.length });
    res.status(201).json(t);
  } catch (e) { next(e); }
});
