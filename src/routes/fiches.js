/**
 * §3.1 — Fiches de Poste: direct upload (PDF or Excel), automatic extraction of
 * profil, missions, activités, avantages, risques & pénibilités.
 * Upload allowed to GPF, CD, ADM (and RJ for review reads).
 */
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");

const DIR = path.join(__dirname, "..", "..", "uploads", "fiches");
fs.mkdirSync(DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: DIR,
    filename: (q, f, cb) => cb(null, `${Date.now()}-${f.originalname.replace(/[^\w.\-]/g, "_")}`) }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const SECTIONS = [
  ["profil",    /profil(?:\s+de\s+poste)?/i],
  ["missions",  /missions?/i],
  ["activites", /activit[ée]s?/i],
  ["avantages", /avantages?/i],
  ["risques",   /risques?(?:\s+professionnels)?/i],
  ["penibilites", /p[ée]nibilit[ée]s?/i],
];

/** Heuristic extraction: split text on section headings, capture what follows each. */
function extractSections(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {}; let current = null;
  for (const line of lines) {
    const head = SECTIONS.find(([k, rx]) =>
      line.length < 80 && rx.test(line) && line.replace(rx, "").replace(/[\s:—\-–.]/g, "").length < 25);
    if (head) { current = head[0]; out[current] = out[current] || []; continue; }
    if (current) out[current].push(line);
  }
  const r = {};
  for (const [k] of SECTIONS) r[k] = (out[k] || []).join("\n").slice(0, 3000);
  return r;
}

async function textOf(filePath, name) {
  if (/\.pdf$/i.test(name)) {
    const buf = fs.readFileSync(filePath);
    try {
      const pdfParse = require("pdf-parse");
      return (await pdfParse(buf)).text;
    } catch (err) {
      // Fallback for PDFs the parser cannot read: pull text from uncompressed streams
      const raw = buf.toString("latin1");
      const bits = [...raw.matchAll(/\(((?:[^()\\]|\\.)+)\)\s*Tj/g)].map(m =>
        m[1].replace(/\\([()\\])/g, "$1"));
      if (bits.length) return bits.join("\n");
      throw Object.assign(new Error("Unable to read this PDF — please upload a text-based PDF or Excel"), { status: 400 });
    }
  }
  if (/\.(xlsx|xls|csv)$/i.test(name)) {
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(filePath);
    return wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS: " " })).join("\n");
  }
  throw Object.assign(new Error("Only PDF or Excel files are accepted"), { status: 400 });
}

router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.fichesPoste, req)));

router.post("/", allow("GPF", "CD", "ADM"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File required (PDF or Excel)" });
    const text = await textOf(req.file.path, req.file.originalname);
    const extracted = extractSections(text);
    const found = Object.values(extracted).filter(Boolean).length;
    const fiche = { id: id("fp"), title: req.body.title || req.file.originalname.replace(/\.\w+$/, ""),
      fileName: req.file.originalname, storedAs: req.file.filename,
      extracted, sectionsFound: found,
      uploadedBy: req.user.id, uploadedAt: new Date().toISOString() };
    fiche.tenantId = req.user.tenantId || "t1"; db.fichesPoste.push(fiche); save();
    audit(req.user, "CREATED", "FichePoste", fiche.id, { title: fiche.title, sectionsFound: found });
    res.status(201).json(fiche);
  } catch (e) { next(e); }
});

// Correct/complete extracted sections manually
router.put("/:id", allow("GPF", "CD", "ADM"), (req, res) => {
  const f = mine(db.fichesPoste, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Not found" });
  for (const [k] of SECTIONS)
    if (req.body[k] !== undefined) f.extracted[k] = String(req.body[k]).slice(0, 3000);
  if (req.body.title) f.title = req.body.title;
  save();
  audit(req.user, "UPDATED", "FichePoste", f.id, { fields: Object.keys(req.body) });
  res.json(f);
});

router.get("/:id/download", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPoste, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Not found" });
  audit(req.user, "DOWNLOADED", "FichePoste", f.id, {});
  res.download(path.join(DIR, f.storedAs), f.fileName);
});

module.exports = router;
