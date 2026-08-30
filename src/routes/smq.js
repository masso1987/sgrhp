/**
 * SGRHP — Système de Management de la Qualité (module « quality »).
 * Phase 1 : cartographie & fiches processus (livret), maîtrise documentaire (versionnée),
 * axes stratégiques, politique qualité, parties intéressées, domaine & exclusions,
 * bibliothèque de clauses ISO 9001:2015, indicateurs (+ mesures manuelles) et tableau de bord.
 * Modèle calqué sur le SMQ réel de CIBLE RH EMPLOI (voir SGRHP_SMQ_PLAN.md).
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const _path = require("path");
const _fs = require("fs");
let _multer; try { _multer = require("multer"); } catch (e) { _multer = null; }
const SMQ_DIR = _path.join(__dirname, "..", "..", "uploads", "smq");
try { _fs.mkdirSync(SMQ_DIR, { recursive: true }); } catch (e) {}
const smqUpload = _multer ? _multer({ storage: _multer.diskStorage({ destination: SMQ_DIR, filename: (rq, file, cb) => cb(null, id("smqf") + _path.extname(file.originalname || "").slice(0, 8)) }), limits: { fileSize: 50 * 1024 * 1024 } }) : { single: () => (rq, rs, nx) => nx() };
// Import Excel volumineux : upload multipart en mémoire (jusqu'à 50 Mo), évite la limite du corps JSON.
const smqImport = _multer ? _multer({ storage: _multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }) : { single: () => (rq, rs, nx) => nx() };
function xlsxBuf(req) { if (req.file && req.file.buffer) return req.file.buffer; const d = (req.body || {}).data; return d ? Buffer.from(d, "base64") : null; }

const COLS = ["smqAxes", "smqProcesses", "smqIndicators", "smqMeasures", "smqDocTypes",
  "smqDocuments", "smqDocRevisions", "smqStakeholders", "smqScope", "smqClauses", "smqPolicy", "smqImprovements", "smqEvents", "smqConfig", "smqAudits", "smqAuditItems", "smqRisks", "smqSatisfaction", "smqClaims", "smqCompetences", "smqSupplierEvals", "smqEquipment", "smqReviews", "smqConformity", "smqTdb", "smqTdbData"];
for (const k of COLS) if (!db[k]) db[k] = [];

const now = () => new Date().toISOString();
const RW = ["ADM", "CD", "RJ", "RQ"];            // qualité : ADM/CD/RJ écrivent (RJ = responsable qualité de facto)
const RO = ["ADM", "CD", "RJ", "RQ", "GPF", "UI"];
const uName = (uid) => { const u = (db.users || []).find(x => x.id === uid); return u ? u.fullName : ""; };
const dbUser = (req) => (db.users || []).find(u => u.id === req.user.id) || {};
const isManager = (req) => req.user.role === "ADM" || req.user.role === "SADM" || !!dbUser(req).smqManager;
function procAccess(req, processId) {
  if (isManager(req)) return true;
  if (!processId) return false;
  const p = (db.smqProcesses || []).find(x => x.id === processId && (x.tenantId || "t1") === (req.user.tenantId || "t1"));
  return !!p && (p.piloteUserId === req.user.id || p.coPiloteUserId === req.user.id);
}
const docProcId = (req, docId) => { const d = mine(db.smqDocuments, req).find(x => x.id === docId); return d ? d.processId : null; };
const revProcId = (req, revId) => { const r = mine(db.smqDocRevisions, req).find(x => x.id === revId); return r ? docProcId(req, r.documentId) : null; };
const DENY = (res) => res.status(403).json({ error: "Accès réservé au responsable SMQ ou au pilote/co-pilote de ce processus." });
const mgrOnly = (req, res) => { if (isManager(req)) return true; res.status(403).json({ error: "Action réservée au responsable SMQ." }); return false; };
// Processus dont l'utilisateur est pilote/co-pilote.
const myProcessIds = (req) => mine(db.smqProcesses, req).filter(p => p.piloteUserId === req.user.id || p.coPiloteUserId === req.user.id).map(p => p.id);
// Filtre une liste au périmètre du pilote (le responsable SMQ voit tout).
function scopeByProc(req, rows, getPid) {
  if (isManager(req)) return rows;
  const ids = myProcessIds(req);
  return rows.filter(r => ids.includes(getPid(r)));
}

/* ------------------------------------------------------------------ seeds */
// Bibliothèque de clauses ISO 9001:2015 (préchargée, extensible par le client).
const ISO9001 = [
  ["4", "Contexte de l'organisme"], ["4.1", "Compréhension de l'organisme et de son contexte"],
  ["4.2", "Besoins et attentes des parties intéressées"], ["4.3", "Domaine d'application du SMQ"],
  ["4.4", "SMQ et ses processus"],
  ["5", "Leadership"], ["5.1", "Leadership et engagement"], ["5.2", "Politique"],
  ["5.3", "Rôles, responsabilités et autorités"],
  ["6", "Planification"], ["6.1", "Actions face aux risques et opportunités"],
  ["6.2", "Objectifs qualité et planification"], ["6.3", "Planification des modifications"],
  ["7", "Support"], ["7.1", "Ressources"], ["7.2", "Compétences"], ["7.3", "Sensibilisation"],
  ["7.4", "Communication"], ["7.5", "Informations documentées"],
  ["8", "Réalisation des activités opérationnelles"], ["8.1", "Planification et maîtrise opérationnelles"],
  ["8.2", "Exigences relatives aux produits et services"], ["8.3", "Conception et développement"],
  ["8.4", "Maîtrise des processus, produits et services fournis par des prestataires externes"],
  ["8.5", "Production et prestation de service"], ["8.6", "Libération des produits et services"],
  ["8.7", "Maîtrise des éléments de sortie non conformes"],
  ["9", "Évaluation des performances"], ["9.1", "Surveillance, mesure, analyse et évaluation"],
  ["9.1.2", "Satisfaction du client"], ["9.1.3", "Analyse et évaluation"], ["9.2", "Audit interne"],
  ["9.3", "Revue de direction"], ["10", "Amélioration"], ["10.1", "Généralités"],
  ["10.2", "Non-conformité et action corrective"], ["10.3", "Amélioration continue"],
];
// Types de documents par défaut (motif de numérotation paramétrable).
const DEFAULT_DOCTYPES = [
  { code: "MQ", libelle: "Manuel Qualité", pattern: "SMQ-MQ-{VERSION}", visas: 2, reviewFreqMonths: 36 },
  { code: "LP", libelle: "Livret de processus", pattern: "LP-{PROCESS}-{SEQ}{REV}", visas: 3, reviewFreqMonths: 24 },
  { code: "PR", libelle: "Procédure", pattern: "PR-{PROCESS}-{SEQ}{REV}", visas: 3, reviewFreqMonths: 24 },
  { code: "FM", libelle: "Formulaire", pattern: "{PROCESS}-FM-{SEQ}{REV}", visas: 2, reviewFreqMonths: 24 },
  { code: "EN", libelle: "Enregistrement", pattern: "{PROCESS}-EN-{SEQ}{REV}", visas: 2, reviewFreqMonths: 12 },
  { code: "PO", libelle: "Politique", pattern: "SMQ-PO-{VERSION}", visas: 2, reviewFreqMonths: 36 },
];

function seedSMQ(tid) {
  const has = (col) => (db[col] || []).some(x => (x.tenantId || "t1") === tid);
  const put = (col, rec) => db[col].push(Object.assign({ id: id("smq"), tenantId: tid, createdAt: now() }, rec));
  if (!has("smqClauses")) for (const [code, titre] of ISO9001) put("smqClauses", { referentiel: "ISO 9001:2015", code, titre });
  if (!has("smqDocTypes")) for (const t of DEFAULT_DOCTYPES) put("smqDocTypes", t);
  if (!has("smqScope")) put("smqScope", { perimetre: "", sites: "", exclusions: [] });
  save();
}

// Modèle CRHE (cartographie réelle) — chargé à la demande comme point de départ.
const CRHE_AXES = [
  "Consolider nos parts de marché en MAD (industrie pétrolière, télécommunications).",
  "Donner à l'entreprise un meilleur positionnement en Conseils et Prestation RH.",
  "Disposer d'un système d'information fiable, disponible et sécurisé.",
  "Accroître l'engagement des salariés.",
  "Porter le projet de mutualisation des moyens et ressources du Groupe.",
];
const CRHE_PROCESSES = [
  { code: "M1", type: "M", intitule: "Élaborer la stratégie, fixer et déployer les objectifs", pilote: "Theodoret-Marie FANSI", coPilote: "Christine FANSI", finalite: "Définir les orientations et objectifs stratégiques, les responsabilités et autorités, et fournir les ressources nécessaires." },
  { code: "M2", type: "M", intitule: "Évaluer les performances et améliorer le SMQ", pilote: "Brice OSSONGOMBIA", finalite: "Veiller à la mise en œuvre efficace du SMQ (maîtrise documentaire, audits, surveillance, analyse, évaluation)." },
  { code: "R1", type: "R", intitule: "Mettre les employés à la disposition des clients", pilote: "Célestin ANAGUE", finalite: "Préserver le savoir-faire et assurer un suivi opérationnel rigoureux et la satisfaction des ressources MAD." },
  { code: "R2", type: "R", intitule: "Apporter des solutions RH", pilote: "Gilles KENGNE", finalite: "Assister les clients dans la gestion de leur capital humain (recrutements, évaluations, formations)." },
  { code: "S1", type: "S", intitule: "Gérer les emplois et carrières", pilote: "Gilles KENGNE", finalite: "Gérer le personnel interne pour une meilleure performance sociale et économique." },
  { code: "S2", type: "S", intitule: "Suivre les comptes et les finances", pilote: "Jacques NJATOU", finalite: "Fournir des informations financières fiables et optimiser le coût de financement des activités." },
  { code: "S3", type: "S", intitule: "Acquérir des biens et prestations", pilote: "Danielle ZANG", finalite: "Mettre à disposition les produits et services adaptés aux meilleures conditions de prix et de délais." },
  { code: "S4", type: "S", intitule: "Entretenir le système d'information", pilote: "Ferdine MASSO", finalite: "Déterminer, acquérir et maintenir les infrastructures ; organiser, structurer et sécuriser les informations." },
];

router.post("/seed-crhe", allow("ADM", "CD"), (req, res) => {
  const tid = req.user.tenantId || "t1"; seedSMQ(tid);
  let ax = 0, pr = 0;
  CRHE_AXES.forEach((libelle, i) => {
    if (!mine(db.smqAxes, req).some(a => a.code === "Axe " + (i + 1))) {
      db.smqAxes.push(stamp({ id: id("smq"), code: "Axe " + (i + 1), libelle, ordre: i + 1, createdAt: now() }, req)); ax++;
    }
  });
  let ordre = 0;
  for (const p of CRHE_PROCESSES) {
    ordre++;
    if (mine(db.smqProcesses, req).some(x => x.code === p.code)) continue;
    db.smqProcesses.push(stamp({
      id: id("smq"), code: p.code, type: p.type, intitule: p.intitule, piloteName: p.pilote,
      coPiloteName: p.coPilote || "", finalite: p.finalite, objectifs: [], missionsPrincipales: "",
      missionsQuotidiennes: "", competencesRequises: "", entrees: "", sorties: "", statut: "active",
      ordre, createdAt: now(),
    }, req)); pr++;
  }
  save(); audit(req.user, "CREATED", "SmqTemplate", "crhe", { axes: ax, processes: pr });
  res.json({ ok: true, axes: ax, processes: pr });
});

/* --------------------------------------------------------------- generic crud */
function crud(path, col, fields, keyField, sortField) {
  router.get("/" + path, allow(...RO), (req, res) => {
    seedSMQ(req.user.tenantId || "t1");
    const rows = mine(db[col], req).slice();
    if (sortField) rows.sort((a, b) => String(a[sortField] || "").localeCompare(String(b[sortField] || ""), "fr", { numeric: true }));
    res.json(rows);
  });
  router.post("/" + path, allow(...RW), (req, res) => {
    const b = req.body || {};
    if (keyField && !b[keyField]) return res.status(400).json({ error: keyField + " obligatoire" });
    const rec = { id: id("smq"), createdAt: now() };
    for (const f of fields) if (b[f] !== undefined) rec[f] = b[f];
    db[col].push(stamp(rec, req)); save(); audit(req.user, "CREATED", col, rec.id, {});
    res.status(201).json(rec);
  });
  router.put("/" + path + "/:id", allow(...RW), (req, res) => {
    const x = mine(db[col], req).find(r => r.id === req.params.id);
    if (!x) return res.status(404).json({ error: "Introuvable" });
    for (const f of fields) if (req.body[f] !== undefined) x[f] = req.body[f];
    x.updatedAt = now(); save(); audit(req.user, "UPDATED", col, x.id, {}); res.json(x);
  });
  router.delete("/" + path + "/:id", allow("ADM", "CD"), (req, res) => {
    const x = mine(db[col], req).find(r => r.id === req.params.id);
    if (!x) return res.status(404).json({ error: "Introuvable" });
    db[col].splice(db[col].indexOf(x), 1); save(); audit(req.user, "DELETED", col, x.id, {}); res.json({ ok: true });
  });
}

crud("axes", "smqAxes", ["code", "libelle", "ordre"], "libelle", "ordre");
crud("stakeholders", "smqStakeholders", ["partie", "besoins", "attentes", "frequenceRevue", "type"], "partie", "partie");
crud("doctypes", "smqDocTypes", ["code", "libelle", "pattern", "visas", "reviewFreqMonths"], "code", "code");
crud("indicators", "smqIndicators",
  ["processId", "libelle", "modeCalcul", "cible", "seuil", "unite", "frequence", "sens", "source", "binding", "autoMetric", "axeCode"],
  "libelle", "libelle");

/* --------------------------------------------------------------- clauses (read + extend) */
router.get("/clauses", allow(...RO), (req, res) => { seedSMQ(req.user.tenantId || "t1"); res.json(mine(db.smqClauses, req)); });
router.post("/clauses", allow(...RW), (req, res) => {
  const b = req.body || {}; if (!b.code) return res.status(400).json({ error: "code obligatoire" });
  const rec = stamp({ id: id("smq"), referentiel: b.referentiel || "Personnalisé", code: b.code, titre: b.titre || "", createdAt: now() }, req);
  db.smqClauses.push(rec); save(); res.status(201).json(rec);
});
router.delete("/clauses/:id", allow("ADM", "CD"), (req, res) => {
  const x = mine(db.smqClauses, req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
  db.smqClauses.splice(db.smqClauses.indexOf(x), 1); save(); res.json({ ok: true });
});

/* --------------------------------------------------------------- processes (+ fiche aggrégée) */
router.get("/processes", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  res.json(mine(db.smqProcesses, req).slice().sort((a, b) =>
    (a.ordre || 99) - (b.ordre || 99) || String(a.code).localeCompare(String(b.code), "fr", { numeric: true })));
});
const PROC_FIELDS = ["code", "type", "intitule", "piloteId", "piloteName", "piloteUserId", "coPiloteId", "coPiloteUserId", "coPiloteName", "finalite",
  "objectifs", "missionsPrincipales", "missionsQuotidiennes", "competencesRequises", "entrees", "sorties",
  "logigrammeFileId", "statut", "ordre"];
router.post("/processes", allow(...RW), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const b = req.body || {}; if (!b.code || !b.intitule) return res.status(400).json({ error: "Code et intitulé obligatoires" });
  const rec = { id: id("smq"), objectifs: [], statut: "active", createdAt: now() };
  for (const f of PROC_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqProcesses.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqProcess", rec.id, { code: rec.code });
  res.status(201).json(rec);
});
router.put("/processes/:id", allow(...RW), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const x = mine(db.smqProcesses, req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
  for (const f of PROC_FIELDS) if (req.body[f] !== undefined) x[f] = req.body[f];
  x.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqProcess", x.id, {}); res.json(x);
});
router.delete("/processes/:id", allow("ADM", "CD", "RQ"), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const x = mine(db.smqProcesses, req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
  db.smqProcesses.splice(db.smqProcesses.indexOf(x), 1); save(); audit(req.user, "DELETED", "SmqProcess", x.id, {}); res.json({ ok: true });
});
// Livret vivant : le processus + ses indicateurs + dernière mesure + ses risques (phase risques à venir).
router.get("/processes/:id/livret", allow(...RO), (req, res) => {
  const p = mine(db.smqProcesses, req).find(r => r.id === req.params.id); if (!p) return res.status(404).json({ error: "Introuvable" });
  const inds = mine(db.smqIndicators, req).filter(i => i.processId === p.id).map(i => {
    const ms = mine(db.smqMeasures, req).filter(m => m.indicatorId === i.id).sort((a, b) => String(b.periode).localeCompare(String(a.periode)));
    return Object.assign({}, i, { derniere: ms[0] || null, mesures: ms.slice(0, 12) });
  });
  const axes = mine(db.smqAxes, req);
  res.json({ processus: p, indicateurs: inds, axes });
});

/* --------------------------------------------------------------- indicator measures */
router.get("/indicators/:id/measures", allow(...RO), (req, res) => {
  res.json(mine(db.smqMeasures, req).filter(m => m.indicatorId === req.params.id)
    .sort((a, b) => String(a.periode).localeCompare(String(b.periode))));
});
router.post("/indicators/:id/measures", allow(...RW), (req, res) => {
  const ind = mine(db.smqIndicators, req).find(i => i.id === req.params.id); if (!ind) return res.status(404).json({ error: "Indicateur introuvable" });
  const b = req.body || {}; if (!b.periode) return res.status(400).json({ error: "Période obligatoire" });
  const ex = mine(db.smqMeasures, req).find(m => m.indicatorId === ind.id && m.periode === b.periode);
  if (ex) { ex.valeur = Number(b.valeur) || 0; ex.commentaire = b.commentaire || ""; ex.updatedAt = now(); save(); return res.json(ex); }
  const rec = stamp({ id: id("smq"), indicatorId: ind.id, periode: b.periode, valeur: Number(b.valeur) || 0, commentaire: b.commentaire || "", source: "manuel", createdAt: now() }, req);
  db.smqMeasures.push(rec); save(); res.status(201).json(rec);
});

/* --------------------------------------------------------------- scope (domaine + exclusions) */
router.get("/scope", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  let s = mine(db.smqScope, req)[0];
  if (!s) { s = stamp({ id: id("smq"), perimetre: "", sites: "", exclusions: [], createdAt: now() }, req); db.smqScope.push(s); save(); }
  res.json(s);
});
router.put("/scope", allow(...RW), (req, res) => {
  let s = mine(db.smqScope, req)[0];
  if (!s) { s = stamp({ id: id("smq"), createdAt: now() }, req); db.smqScope.push(s); }
  const b = req.body || {};
  if (b.perimetre !== undefined) s.perimetre = b.perimetre;
  if (b.sites !== undefined) s.sites = b.sites;
  if (Array.isArray(b.exclusions)) s.exclusions = b.exclusions;
  s.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqScope", s.id, {}); res.json(s);
});

/* --------------------------------------------------------------- politique qualité (versionnée) */
router.get("/policy", allow(...RO), (req, res) => {
  res.json(mine(db.smqPolicy, req).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))));
});
router.post("/policy", allow(...RW), (req, res) => {
  const b = req.body || {};
  const rec = stamp({ id: id("smq"), texte: b.texte || "", version: b.version || "1.0", date: b.date || now().slice(0, 10), axes: b.axes || [], enVigueur: !!b.enVigueur, createdAt: now() }, req);
  if (rec.enVigueur) mine(db.smqPolicy, req).forEach(p => p.enVigueur = false);
  db.smqPolicy.push(rec); save(); audit(req.user, "CREATED", "SmqPolicy", rec.id, { version: rec.version }); res.status(201).json(rec);
});

/* --------------------------------------------------------------- maîtrise documentaire */
function docType(req, code) { return mine(db.smqDocTypes, req).find(t => t.code === code); }
function procCode(req, pid) { const p = mine(db.smqProcesses, req).find(x => x.id === pid); return p ? p.code : ""; }
// Séquence globale par type de document (par tenant).
function nextSeq(req, typeCode) {
  const docs = mine(db.smqDocuments, req).filter(d => d.typeCode === typeCode);
  let max = 0; for (const d of docs) { const n = parseInt(d.seq, 10); if (n > max) max = n; }
  return max + 1;
}
function resolveRef(pattern, ctx) {
  return String(pattern || "{TYPE}-{SEQ}{REV}")
    .replace(/\{TYPE\}/g, ctx.type || "")
    .replace(/\{PROCESS\}/g, ctx.process || "")
    .replace(/\{SEQ\}/g, String(ctx.seq || "").padStart(2, "0"))
    .replace(/\{REV\}/g, ctx.rev || "")
    .replace(/\{VERSION\}/g, ctx.version || "")
    .replace(/\{DOMAINE\}/g, ctx.domaine || "SMQ")
    .replace(/\{YYYY\}/g, String(new Date().getFullYear()));
}
const REV_LETTERS = "abcdefghijklmnopqrstuvwxyz";
function revLetter(n) { return REV_LETTERS[n] || ("z" + n); }        // 0->a, 1->b …

router.get("/documents", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const revs = mine(db.smqDocRevisions, req);
  const rows = scopeByProc(req, mine(db.smqDocuments, req), d => d.processId).map(d => {
    const cur = revs.find(r => r.id === d.currentRevisionId);
    return Object.assign({}, d, { current: cur || null, nbVersions: revs.filter(r => r.documentId === d.id).length });
  }).sort((a, b) => String(a.ref || "").localeCompare(String(b.ref || ""), "fr", { numeric: true }));
  res.json(rows);
});
router.get("/documents/:id", allow(...RO), (req, res) => {
  const d = mine(db.smqDocuments, req).find(r => r.id === req.params.id); if (!d) return res.status(404).json({ error: "Introuvable" });
  if (!isManager(req) && d.processId && !myProcessIds(req).includes(d.processId)) return res.status(403).json({ error: "Document hors de votre périmètre." });
  const revs = mine(db.smqDocRevisions, req).filter(r => r.documentId === d.id)
    .sort((a, b) => String(b.version).localeCompare(String(a.version), "fr", { numeric: true }));
  res.json({ document: d, revisions: revs });
});

// Créer un document = créer sa 1re version (brouillon).
router.post("/documents", allow(...RW), (req, res) => {
  const b = req.body || {};
  if (!procAccess(req, b.processId || null)) return DENY(res);
  if (!b.titre || !b.typeCode) return res.status(400).json({ error: "Titre et type de document obligatoires" });
  const t = docType(req, b.typeCode); if (!t) return res.status(400).json({ error: "Type de document inconnu" });
  const seq = nextSeq(req, b.typeCode);
  const version = b.version || (t.pattern.includes("{VERSION}") ? "1.0" : "1");
  const rev = t.pattern.includes("{REV}") ? "a" : "";
  const ref = resolveRef(t.pattern, { type: b.typeCode, process: procCode(req, b.processId), seq, rev, version });
  const docId = id("smq");
  const revId = id("smq");
  const freq = Number(b.frequenceRevueMonths) || Number(t.reviewFreqMonths) || 24;
  const revRec = stamp({
    id: revId, documentId: docId, version, ref, statut: "brouillon",
    redacteurId: b.redacteurId || req.user.id, redacteurName: b.redacteurName || req.user.fullName,
    verificateurName: b.verificateurName || "", approbateurName: b.approbateurName || "",
    dateCreation: now().slice(0, 10), dateModification: now().slice(0, 10),
    resumeModif: b.resumeModif || "Création", contenu: b.contenu || "", fileId: b.fileId || null, file: b.file && b.file.storedAs ? b.file : null,
    frequenceRevueMonths: freq, diffusion: b.diffusion || [], createdAt: now(),
  }, req);
  const REG_FIELDS = ["stockageMode","stockageLieu","stockageDuree","archivageMode","archivageLieu","archivageDuree","destructionLieu","destructionMethode","observations"];
  const docRec = stamp({
    id: docId, ref, titre: b.titre, typeCode: b.typeCode, processId: b.processId || null,
    seq, statutCourant: "brouillon", versionCourante: version, currentRevisionId: revId,
    frequenceRevueMonths: freq, dateCreation: b.dateCreation || now().slice(0,10), createdAt: now(),
  }, req);
  for (const rf of REG_FIELDS) if (b[rf] !== undefined) docRec[rf] = b[rf];
  db.smqDocuments.push(docRec); db.smqDocRevisions.push(revRec); save();
  audit(req.user, "CREATED", "SmqDocument", docId, { ref, titre: b.titre });
  res.status(201).json({ document: docRec, revision: revRec });
});

// Mettre à jour les métadonnées du document (titre, processus, fiche §7.5 informations documentées).
router.put("/documents/:id", allow(...RW), (req, res) => {
  const d = mine(db.smqDocuments, req).find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, d.processId)) return DENY(res);
  const b = req.body || {};
  for (const f of ["titre", "processId", "dateCreation", "stockageMode", "stockageLieu", "stockageDuree", "archivageMode", "archivageLieu", "archivageDuree", "destructionLieu", "destructionMethode", "observations"])
    if (b[f] !== undefined) d[f] = b[f];
  d.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqDocument", d.id, {}); res.json(d);
});

// Éditer une révision en brouillon.
router.put("/revisions/:id", allow(...RW), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, docProcId(req, r.documentId))) return DENY(res);
  if (r.statut !== "brouillon") return res.status(400).json({ error: "Seule une version en brouillon est modifiable." });
  const b = req.body || {};
  for (const f of ["redacteurName", "verificateurName", "approbateurName", "resumeModif", "contenu", "fileId", "file", "frequenceRevueMonths", "diffusion"])
    if (b[f] !== undefined) r[f] = b[f];
  r.dateModification = now().slice(0, 10); save(); res.json(r);
});

function setDocStatus(req, r, statut) {
  r.statut = statut; r.dateModification = now().slice(0, 10);
  const d = mine(db.smqDocuments, req).find(x => x.id === r.documentId);
  if (d && d.currentRevisionId === r.id) d.statutCourant = statut;
}
router.post("/revisions/:id/submit", allow(...RW), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, docProcId(req, r.documentId))) return DENY(res);
  if (r.statut !== "brouillon") return res.status(400).json({ error: "Transition invalide" });
  setDocStatus(req, r, "verifie"); save(); audit(req.user, "STATUS", "SmqDocument", r.documentId, { version: r.version, statut: "verifie" }); res.json(r);
});
router.post("/revisions/:id/approve", allow(...RW), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, docProcId(req, r.documentId))) return DENY(res);
  if (!["verifie", "brouillon"].includes(r.statut)) return res.status(400).json({ error: "Transition invalide" });
  // approuvée -> en vigueur ; les versions antérieures en vigueur deviennent obsolètes
  mine(db.smqDocRevisions, req).filter(x => x.documentId === r.documentId && x.id !== r.id && x.statut === "en_vigueur")
    .forEach(x => { x.statut = "obsolete"; x.dateModification = now().slice(0, 10); });
  r.approuveLe = now().slice(0, 10);
  setDocStatus(req, r, "en_vigueur");
  const d = mine(db.smqDocuments, req).find(x => x.id === r.documentId);
  if (d) {
    d.currentRevisionId = r.id; d.versionCourante = r.version; d.statutCourant = "en_vigueur"; d.ref = r.ref;
    const f = Number(r.frequenceRevueMonths) || 24;
    const nd = new Date(); nd.setMonth(nd.getMonth() + f); d.nextReviewDate = nd.toISOString().slice(0, 10);
  }
  save(); audit(req.user, "APPROVED", "SmqDocument", r.documentId, { version: r.version, ref: r.ref }); res.json(r);
});
router.post("/revisions/:id/obsolete", allow(...RW), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, docProcId(req, r.documentId))) return DENY(res);
  setDocStatus(req, r, "obsolete"); save(); audit(req.user, "STATUS", "SmqDocument", r.documentId, { version: r.version, statut: "obsolete" }); res.json(r);
});

// Nouvelle version (révision) d'un document existant.
router.post("/documents/:id/revise", allow(...RW), (req, res) => {
  const d = mine(db.smqDocuments, req).find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, d.processId)) return DENY(res);
  const t = docType(req, d.typeCode) || {};
  const revs = mine(db.smqDocRevisions, req).filter(x => x.documentId === d.id);
  const b = req.body || {};
  let version, rev = "";
  if ((t.pattern || "").includes("{VERSION}")) {                    // 2.4 -> 2.5
    const parts = String(d.versionCourante || "1.0").split(".");
    version = b.version || (parts[0] + "." + ((parseInt(parts[1], 10) || 0) + 1));
  } else {                                                          // 09a -> 09b (rév.)
    version = d.seq ? String(d.seq).padStart(2, "0") : String(revs.length + 1);
    rev = revLetter(revs.length);
  }
  const ref = resolveRef(t.pattern, { type: d.typeCode, process: procCode(req, d.processId), seq: d.seq, rev, version });
  const src = revs.find(x => x.id === d.currentRevisionId) || {};
  const revId = id("smq");
  const revRec = stamp({
    id: revId, documentId: d.id, version, ref, statut: "brouillon",
    redacteurId: b.redacteurId || req.user.id, redacteurName: b.redacteurName || req.user.fullName,
    verificateurName: b.verificateurName || src.verificateurName || "",
    approbateurName: b.approbateurName || src.approbateurName || "",
    dateCreation: now().slice(0, 10), dateModification: now().slice(0, 10),
    resumeModif: b.resumeModif || "", contenu: b.contenu !== undefined ? b.contenu : (src.contenu || ""),
    fileId: b.fileId || null, file: b.file && b.file.storedAs ? b.file : (src.file || null), frequenceRevueMonths: Number(b.frequenceRevueMonths) || d.frequenceRevueMonths || 24,
    diffusion: b.diffusion || src.diffusion || [], createdAt: now(),
  }, req);
  db.smqDocRevisions.push(revRec); save();
  audit(req.user, "REVISED", "SmqDocument", d.id, { version, ref }); res.status(201).json(revRec);
});

/* --------------------------------------------------------------- dashboard */
router.get("/dashboard", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const procs = mine(db.smqProcesses, req);
  const docs = mine(db.smqDocuments, req);
  const byType = {}; procs.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });
  const docStatus = {}; docs.forEach(d => { docStatus[d.statutCourant] = (docStatus[d.statutCourant] || 0) + 1; });
  const today = now().slice(0, 10);
  const soon = new Date(); soon.setDate(soon.getDate() + 60); const soonS = soon.toISOString().slice(0, 10);
  const aRevoir = docs.filter(d => d.nextReviewDate && d.nextReviewDate <= soonS)
    .map(d => ({ id: d.id, ref: d.ref, titre: d.titre, nextReviewDate: d.nextReviewDate, enRetard: d.nextReviewDate < today }));
  res.json({
    kpi: {
      processes: procs.length, mgmt: byType.M || 0, real: byType.R || 0, support: byType.S || 0,
      documents: docs.length, enVigueur: docStatus.en_vigueur || 0, brouillon: docStatus.brouillon || 0,
      indicateurs: mine(db.smqIndicators, req).length, axes: mine(db.smqAxes, req).length,
      partiesInteressees: mine(db.smqStakeholders, req).length, aRevoir: aRevoir.length,
      fiches: mine(db.smqImprovements, req).length,
      fichesOuvertes: mine(db.smqImprovements, req).filter(x => x.statut !== "cloturee").length,
      evenements: mine(db.smqEvents, req).length,
      evenementsNonRevus: mine(db.smqEvents, req).filter(x => !x.reviewed).length,
      audits: mine(db.smqAudits, req).length,
      auditsPlanifies: mine(db.smqAudits, req).filter(x => x.statut === "planifie").length,
      risques: mine(db.smqRisks, req).filter(x => (x.sens || "R") === "R").length,
      risquesEleves: mine(db.smqRisks, req).filter(x => { const c=(Number(x.vraisemblance)||0)*(Number(x.impact)||0); return (x.sens||"R")==="R" && c>=8; }).length,
      reclamationsOuvertes: mine(db.smqClaims, req).filter(x => !["resolue","cloturee"].includes(x.statut)).length,
      habilitationsExpirant: mine(db.smqCompetences, req).filter(x => x.habilitation && x.dateExpiration && x.dateExpiration < new Date().toISOString().slice(0,10)).length,
      equipementsAEtalonner: mine(db.smqEquipment, req).filter(x => { const p=x.prochainEtalonnage||(x.dernierEtalonnage&&x.frequenceEtalonnageMois?(()=>{const d=new Date(x.dernierEtalonnage);d.setMonth(d.getMonth()+(Number(x.frequenceEtalonnageMois)||12));return d.toISOString().slice(0,10);})():null); return p && ((new Date(p)-new Date())/86400000)<=30; }).length,
      revues: mine(db.smqReviews, req).length,
      tauxConformite: conformitySummary(req).taux,
    },
    docStatus, aRevoir,
    processes: procs.slice().sort((a, b) => (a.ordre || 99) - (b.ordre || 99)),
  });
});

/* ============================ Fiches d'amélioration (NC + action corrective + vérification) ============================ */
// Modèle unifié CRHE : une seule fiche porte non-conformité, actions et vérification (voir §10.1 du plan).
const IMP_ORIGINES = ["Non-conformité", "Réclamation client", "Audit interne", "Audit externe",
  "Audit à blanc", "Revue de direction", "Minute qualité", "Rencontre évènementielle",
  "Risques et opportunités", "Autres"];
const IMP_STATUTS = ["ouverte", "analyse", "traitement", "verification", "cloturee"];
const IMP_ACT_STATUTS = ["planifiee", "en_cours", "faite", "verifiee", "cloturee", "en_retard", "abandonnee"];

function impRef(req, procId) {
  const y = new Date().getFullYear();
  const same = mine(db.smqImprovements, req).filter(x => String(x.ref || "").endsWith("/" + y));
  let max = 0; for (const x of same) { const n = parseInt(String(x.ref), 10); if (n > max) max = n; }
  const p = procId ? (mine(db.smqProcesses, req).find(z => z.id === procId) || {}).code : "";
  return String(max + 1).padStart(2, "0") + "/" + (p || "QHSE") + "/" + y;
}
const IMP_FIELDS = ["date", "processId", "entite", "origine", "origineAutre", "type", "gravite",
  "description", "emetteurName", "emetteurVisa", "correctionImmediate", "correctionResponsable", "correctionDate",
  "analyseCauses", "actions", "actionsProposeesPar", "visaPilote",
  "verifResultat", "verifCommentaire", "verifiePar", "verifDate",
  "roRecurrence", "roRisqueRef", "roNouveaux", "statut",
  "norme", "clause", "auditRef", "auditeur", "clotureLe"];

router.get("/improvements", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  let rows = mine(db.smqImprovements, req).slice();
  const q = req.query || {};
  if (q.statut) rows = rows.filter(r => r.statut === q.statut);
  if (q.origine) rows = rows.filter(r => r.origine === q.origine);
  if (q.processId) rows = rows.filter(r => r.processId === q.processId);
  rows.sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
  res.json(rows);
});
router.get("/improvements/meta", allow(...RO), (req, res) =>
  res.json({ origines: IMP_ORIGINES, statuts: IMP_STATUTS, actionStatuts: IMP_ACT_STATUTS }));
router.get("/improvements/:id", allow(...RO), (req, res) => {
  const x = mine(db.smqImprovements, req).find(r => r.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Introuvable" });
  const chain = mine(db.smqImprovements, req).filter(r => r.parentId === x.id).map(r => ({ id: r.id, ref: r.ref }));
  res.json(Object.assign({}, x, { suivantes: chain }));
});
router.post("/improvements", allow(...RW), (req, res) => {
  const b = req.body || {};
  const rec = {
    id: id("smq"), ref: b.ref || impRef(req, b.processId), entite: b.entite || "QHSE",
    date: b.date || now().slice(0, 10), type: b.type || "interne", gravite: b.gravite || "mineure",
    statut: b.statut || "ouverte", actions: Array.isArray(b.actions) ? b.actions : [],
    emetteurName: b.emetteurName || req.user.fullName, parentId: b.parentId || null, createdAt: now(),
  };
  for (const f of IMP_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqImprovements.push(stamp(rec, req)); save();
  audit(req.user, "CREATED", "SmqImprovement", rec.id, { ref: rec.ref, origine: rec.origine });
  res.status(201).json(rec);
});
router.put("/improvements/:id", allow(...RW), (req, res) => {
  const x = mine(db.smqImprovements, req).find(r => r.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Introuvable" });
  for (const f of IMP_FIELDS) if (req.body[f] !== undefined) x[f] = req.body[f];
  // Efficacité conforme => clôture automatique.
  if (x.verifResultat === "conforme" && x.statut !== "cloturee") { x.statut = "cloturee"; x.clotureLe = now().slice(0, 10); }
  x.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqImprovement", x.id, {}); res.json(x);
});
router.delete("/improvements/:id", allow("ADM", "CD"), (req, res) => {
  const x = mine(db.smqImprovements, req).find(r => r.id === req.params.id);
  if (!x) return res.status(404).json({ error: "Introuvable" });
  db.smqImprovements.splice(db.smqImprovements.indexOf(x), 1); save();
  audit(req.user, "DELETED", "SmqImprovement", x.id, {}); res.json({ ok: true });
});
// Chaînage : quand l'efficacité est non conforme, ouvrir une nouvelle fiche liée.
router.post("/improvements/:id/spawn", allow(...RW), (req, res) => {
  const src = mine(db.smqImprovements, req).find(r => r.id === req.params.id);
  if (!src) return res.status(404).json({ error: "Introuvable" });
  const rec = stamp({
    id: id("smq"), ref: impRef(req, src.processId), parentId: src.id, entite: src.entite || "QHSE",
    date: now().slice(0, 10), processId: src.processId || null, origine: "Non-conformité",
    type: "interne", gravite: src.gravite || "mineure", statut: "ouverte",
    description: "Suite à l'inefficacité de la fiche " + src.ref + " : " + (src.description || ""),
    analyseCauses: "", actions: [], emetteurName: req.user.fullName, createdAt: now(),
  }, req);
  db.smqImprovements.push(rec); save();
  audit(req.user, "CREATED", "SmqImprovement", rec.id, { ref: rec.ref, parent: src.ref });
  res.status(201).json(rec);
});
// État des actions correctives : origine × statut (pour tableau de bord & revues).
router.get("/improvements-summary", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const rows = mine(db.smqImprovements, req);
  const grid = {}; IMP_ORIGINES.forEach(o => { grid[o] = { ouverte: 0, analyse: 0, traitement: 0, verification: 0, cloturee: 0, total: 0 }; });
  const totals = { ouverte: 0, analyse: 0, traitement: 0, verification: 0, cloturee: 0, total: 0 };
  for (const r of rows) {
    const o = IMP_ORIGINES.includes(r.origine) ? r.origine : "Autres";
    const st = IMP_STATUTS.includes(r.statut) ? r.statut : "ouverte";
    grid[o][st]++; grid[o].total++; totals[st]++; totals.total++;
  }
  // Actions en retard (échéance dépassée, non clôturées).
  const today = now().slice(0, 10); let enRetard = 0;
  for (const r of rows) for (const a of (r.actions || []))
    if (a.echeance && a.echeance < today && !["cloturee", "verifiee", "faite"].includes(a.statut)) enRetard++;
  res.json({ grid, totals, origines: IMP_ORIGINES, enRetard, ouvertes: totals.total - totals.cloturee });
});

/* ============================ Traçabilité qualité (événements) + configuration ============================ */
router.get("/events", allow(...RO), (req, res) => {
  let rows = mine(db.smqEvents, req).slice();
  const q = req.query || {};
  if (q.objectType) rows = rows.filter(r => r.objectType === q.objectType);
  if (q.reviewed === "0") rows = rows.filter(r => !r.reviewed);
  if (q.changed === "1") rows = rows.filter(r => r.changed);
  rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  res.json(rows.slice(0, 500));
});
router.get("/events-summary", allow(...RO), (req, res) => {
  const rows = mine(db.smqEvents, req);
  const changed = rows.filter(r => r.changed).length;
  const withFiche = rows.filter(r => r.improvementId).length;
  const nonReviewed = rows.filter(r => !r.reviewed).length;
  const byType = {}; rows.forEach(r => { byType[r.objectType || "?"] = (byType[r.objectType || "?"] || 0) + 1; });
  res.json({ total: rows.length, changed, withFiche, nonReviewed, byType });
});
router.put("/events/:id/review", allow(...RW), (req, res) => {
  const e = mine(db.smqEvents, req).find(r => r.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Introuvable" });
  e.reviewed = req.body && req.body.reviewed === false ? false : true; save(); res.json(e);
});
router.get("/config", allow(...RO), (req, res) => {
  if (!db.smqConfig) db.smqConfig = [];
  let c = mine(db.smqConfig, req)[0];
  if (!c) { c = stamp({ id: id("smq"), autoRaiseOnChange: true, createdAt: now() }, req); db.smqConfig.push(c); save(); }
  res.json(c);
});
router.put("/config", allow(...RW), (req, res) => {
  if (!db.smqConfig) db.smqConfig = [];
  let c = mine(db.smqConfig, req)[0];
  if (!c) { c = stamp({ id: id("smq"), createdAt: now() }, req); db.smqConfig.push(c); }
  if (req.body.autoRaiseOnChange !== undefined) c.autoRaiseOnChange = !!req.body.autoRaiseOnChange;
  c.updatedAt = now(); save(); res.json(c);
});

/* ============================ Audits (internes / externes) + constats ============================ */
const AUDIT_TYPES = ["interne", "externe", "fournisseur"];
const AUDIT_STATUTS = ["planifie", "realise", "cloture"];
const CONFORMITES = ["C", "NC", "OBS", "NA"];   // Conforme, Non-conformité, Observation, Non applicable

function auditRef(req) {
  const y = new Date().getFullYear();
  const same = mine(db.smqAudits, req).filter(x => String(x.ref || "").includes("-" + y + "-"));
  let max = 0; for (const x of same) { const n = parseInt(String(x.ref).split("-").pop(), 10); if (n > max) max = n; }
  return "AUD-" + y + "-" + String(max + 1).padStart(2, "0");
}
const AUDIT_FIELDS = ["type", "perimetre", "processIds", "norme", "plannedDate", "realizedDate",
  "auditeurs", "audites", "statut", "conclusion", "externalBody", "reportFileId", "annee"];

router.get("/audits", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const items = mine(db.smqAuditItems, req);
  const rows = mine(db.smqAudits, req).map(a => {
    const its = items.filter(i => i.auditId === a.id);
    return Object.assign({}, a, {
      nbConstats: its.length,
      ncMajeures: its.filter(i => i.conformite === "NC" && i.gravite === "majeure").length,
      ncMineures: its.filter(i => i.conformite === "NC" && i.gravite !== "majeure").length,
      observations: its.filter(i => i.conformite === "OBS").length,
    });
  }).sort((a, b) => String(b.plannedDate || b.createdAt || "").localeCompare(String(a.plannedDate || a.createdAt || "")));
  res.json(rows);
});
router.get("/audits/:id", allow(...RO), (req, res) => {
  const a = mine(db.smqAudits, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  const items = mine(db.smqAuditItems, req).filter(i => i.auditId === a.id)
    .sort((x, y) => String(x.clause || "").localeCompare(String(y.clause || ""), "fr", { numeric: true }));
  res.json({ audit: a, items });
});
router.post("/audits", allow(...RW), (req, res) => {
  const b = req.body || {};
  const rec = {
    id: id("smq"), ref: b.ref || auditRef(req), type: b.type || "interne",
    norme: b.norme || "ISO 9001:2015", statut: b.statut || "planifie",
    processIds: Array.isArray(b.processIds) ? b.processIds : [],
    annee: b.annee || new Date().getFullYear(), createdAt: now(),
  };
  for (const f of AUDIT_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqAudits.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqAudit", rec.id, { ref: rec.ref });
  res.status(201).json(rec);
});
router.put("/audits/:id", allow(...RW), (req, res) => {
  const a = mine(db.smqAudits, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  for (const f of AUDIT_FIELDS) if (req.body[f] !== undefined) a[f] = req.body[f];
  a.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqAudit", a.id, {}); res.json(a);
});
router.delete("/audits/:id", allow("ADM", "CD"), (req, res) => {
  const a = mine(db.smqAudits, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  db.smqAuditItems = db.smqAuditItems.filter(i => i.auditId !== a.id);
  db.smqAudits.splice(db.smqAudits.indexOf(a), 1); save(); audit(req.user, "DELETED", "SmqAudit", a.id, {}); res.json({ ok: true });
});

// Générer une check-list depuis la bibliothèque de clauses (optionnellement filtrée).
router.post("/audits/:id/checklist", allow(...RW), (req, res) => {
  const a = mine(db.smqAudits, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  seedSMQ(req.user.tenantId || "t1");
  const onlyLeaf = req.body && req.body.onlyLeaf !== false;   // par défaut, sous-clauses seulement
  let clauses = mine(db.smqClauses, req).slice().sort((x, y) => String(x.code).localeCompare(String(y.code), "fr", { numeric: true }));
  if (onlyLeaf) clauses = clauses.filter(c => String(c.code).includes("."));   // ignore les titres 4,5,6…
  const prefixes = (req.body && req.body.clausePrefixes) || null;              // ex. ["8","9"]
  if (prefixes && prefixes.length) clauses = clauses.filter(c => prefixes.some(p => String(c.code).startsWith(p)));
  const existing = new Set(mine(db.smqAuditItems, req).filter(i => i.auditId === a.id).map(i => i.clause));
  let added = 0;
  for (const c of clauses) {
    if (existing.has(c.code)) continue;
    db.smqAuditItems.push(stamp({ id: id("smq"), auditId: a.id, clause: c.code, question: c.titre, conformite: "", preuve: "", constat: "", gravite: "mineure", createdAt: now() }, req));
    added++;
  }
  save(); res.json({ ok: true, added });
});
router.post("/audits/:id/items", allow(...RW), (req, res) => {
  const a = mine(db.smqAudits, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  const rec = stamp({ id: id("smq"), auditId: a.id, clause: b.clause || "", question: b.question || "", conformite: b.conformite || "", preuve: b.preuve || "", constat: b.constat || "", gravite: b.gravite || "mineure", createdAt: now() }, req);
  db.smqAuditItems.push(rec); save(); res.status(201).json(rec);
});
router.put("/items/:id", allow(...RW), (req, res) => {
  const it = mine(db.smqAuditItems, req).find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: "Introuvable" });
  for (const f of ["clause", "question", "conformite", "preuve", "constat", "gravite"]) if (req.body[f] !== undefined) it[f] = req.body[f];
  save(); res.json(it);
});
router.delete("/items/:id", allow(...RW), (req, res) => {
  const it = mine(db.smqAuditItems, req).find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: "Introuvable" });
  db.smqAuditItems.splice(db.smqAuditItems.indexOf(it), 1); save(); res.json({ ok: true });
});
// Convertir un constat (NC/OBS) en fiche d'amélioration, rattachée à la clause.
router.post("/items/:id/to-improvement", allow(...RW), (req, res) => {
  const it = mine(db.smqAuditItems, req).find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: "Introuvable" });
  if (it.improvementId) return res.status(409).json({ error: "Une fiche existe déjà pour ce constat." });
  const a = mine(db.smqAudits, req).find(x => x.id === it.auditId) || {};
  const origine = a.type === "externe" ? "Audit externe" : (a.type === "fournisseur" ? "Audit externe" : "Audit interne");
  const rec = stamp({
    id: id("smq"), ref: impRef(req, (a.processIds || [])[0] || null), entite: "QHSE",
    date: now().slice(0, 10), processId: (a.processIds || [])[0] || null, origine,
    type: "interne", gravite: it.gravite || (it.conformite === "OBS" ? "mineure" : "majeure"), statut: "ouverte",
    description: `Constat d'audit ${a.ref || ""} — clause ${it.clause} : ${it.constat || it.question || ""}`,
    analyseCauses: "", actions: [], emetteurName: req.user.fullName,
    sourceAuditId: a.id, sourceAuditItemId: it.id, norme: a.norme, clause: it.clause, auditRef: a.ref, createdAt: now(),
  }, req);
  db.smqImprovements.push(rec); it.improvementId = rec.id; save();
  audit(req.user, "CREATED", "SmqImprovement", rec.id, { ref: rec.ref, fromAudit: a.ref, clause: it.clause });
  res.status(201).json({ improvement: rec });
});
router.get("/audits-summary", allow(...RO), (req, res) => {
  const auds = mine(db.smqAudits, req);
  const items = mine(db.smqAuditItems, req);
  res.json({
    total: auds.length,
    planifies: auds.filter(a => a.statut === "planifie").length,
    realises: auds.filter(a => a.statut === "realise" || a.statut === "cloture").length,
    ncMajeures: items.filter(i => i.conformite === "NC" && i.gravite === "majeure").length,
    ncMineures: items.filter(i => i.conformite === "NC" && i.gravite !== "majeure").length,
    observations: items.filter(i => i.conformite === "OBS").length,
  });
});

/* ============================ Registre des risques & opportunités (méthode CRHE 4×4 + maîtrise 3 axes) ============================ */
// Échelles : Vraisemblance 1-4, Impact 1-4 → Criticité = V×I (1..16).
// Maîtrise sur 3 axes (Moyens, Compétences, Méthodes) 1-4 → Niveau = moyenne.
const RISK_FIELDS = ["processId", "objectifRef", "evenement", "source", "sens", "effet", "cause",
  "vraisemblance", "impact", "maitriseMoyens", "maitriseCompetences", "maitriseMethodes",
  "traitement", "ownerName", "echeance", "probResiduelle", "impactResiduel", "commentaire", "statut"];
const RISK_TRAITEMENTS = ["éviter", "réduire", "transférer", "accepter", "saisir"];

function critBand(c) { return c >= 13 ? "critique" : c >= 8 ? "eleve" : c >= 4 ? "moyen" : "faible"; }
function riskCompute(r) {
  const V = Number(r.vraisemblance) || 0, I = Number(r.impact) || 0;
  const criticite = V * I;
  const mo = Number(r.maitriseMoyens) || 0, co = Number(r.maitriseCompetences) || 0, me = Number(r.maitriseMethodes) || 0;
  const vals = [mo, co, me].filter(x => x > 0);
  const niveauMaitrise = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0;
  const critResiduelle = (Number(r.probResiduelle) || 0) * (Number(r.impactResiduel) || 0);
  // priorité : criticité élevée ET maîtrise faible
  const prioritaire = criticite >= 8 && niveauMaitrise > 0 && niveauMaitrise < 3;
  return Object.assign({}, r, { criticite, band: critBand(criticite), niveauMaitrise, critResiduelle, prioritaire });
}
function riskRef(req) {
  const y = new Date().getFullYear();
  const same = mine(db.smqRisks, req).filter(x => String(x.ref || "").includes("-" + y + "-"));
  let max = 0; for (const x of same) { const n = parseInt(String(x.ref).split("-").pop(), 10); if (n > max) max = n; }
  return "RSK-" + y + "-" + String(max + 1).padStart(3, "0");
}

router.get("/risks", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  let rows = scopeByProc(req, mine(db.smqRisks, req), r => r.processId).map(riskCompute);
  const q = req.query || {};
  if (q.processId) rows = rows.filter(r => r.processId === q.processId);
  if (q.sens) rows = rows.filter(r => (r.sens || "R") === q.sens);
  rows.sort((a, b) => (b.criticite - a.criticite) || String(a.ref).localeCompare(String(b.ref)));
  res.json(rows);
});
router.get("/risks/:id", allow(...RO), (req, res) => {
  const r = mine(db.smqRisks, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  res.json(riskCompute(r));
});
router.post("/risks", allow(...RW), (req, res) => {
  const b = req.body || {};
  if (!procAccess(req, b.processId || null)) return DENY(res);
  const rec = { id: id("smq"), ref: b.ref || riskRef(req), sens: b.sens || "R", statut: b.statut || "actif", createdAt: now() };
  for (const f of RISK_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqRisks.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqRisk", rec.id, { ref: rec.ref });
  res.status(201).json(riskCompute(rec));
});
router.put("/risks/:id", allow(...RW), (req, res) => {
  const r = mine(db.smqRisks, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, r.processId)) return DENY(res);
  for (const f of RISK_FIELDS) if (req.body[f] !== undefined) r[f] = req.body[f];
  r.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqRisk", r.id, {}); res.json(riskCompute(r));
});
router.delete("/risks/:id", allow(...RW), (req, res) => {
  const r = mine(db.smqRisks, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, r.processId)) return DENY(res);
  db.smqRisks.splice(db.smqRisks.indexOf(r), 1); save(); audit(req.user, "DELETED", "SmqRisk", r.id, {}); res.json({ ok: true });
});
// Carte thermique 4×4 : compte par cellule (vraisemblance × impact), risques seulement par défaut.
router.get("/risks-matrix", allow(...RO), (req, res) => {
  const sens = (req.query && req.query.sens) || "R";
  const rows = mine(db.smqRisks, req).filter(r => (r.sens || "R") === sens);
  const grid = {}; for (let v = 1; v <= 4; v++) for (let i = 1; i <= 4; i++) grid[v + "x" + i] = [];
  for (const r of rows) {
    const v = Number(r.vraisemblance) || 0, i = Number(r.impact) || 0;
    if (v >= 1 && v <= 4 && i >= 1 && i <= 4) grid[v + "x" + i].push({ id: r.id, ref: r.ref, evenement: r.evenement });
  }
  res.json({ grid });
});
router.get("/risks-summary", allow(...RO), (req, res) => {
  const rows = mine(db.smqRisks, req).map(riskCompute);
  const risques = rows.filter(r => (r.sens || "R") === "R"), opps = rows.filter(r => r.sens === "O");
  const band = { faible: 0, moyen: 0, eleve: 0, critique: 0 };
  risques.forEach(r => band[r.band]++);
  res.json({
    total: rows.length, risques: risques.length, opportunites: opps.length,
    band, prioritaires: risques.filter(r => r.prioritaire).length,
    top: risques.sort((a, b) => b.criticite - a.criticite).slice(0, 5).map(r => ({ id: r.id, ref: r.ref, evenement: r.evenement, criticite: r.criticite, niveauMaitrise: r.niveauMaitrise, band: r.band })),
  });
});
// Ouvrir une fiche d'amélioration (traitement) à partir d'un risque.
router.post("/risks/:id/to-improvement", allow(...RW), (req, res) => {
  const r = mine(db.smqRisks, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (r.improvementId) return res.status(409).json({ error: "Une fiche existe déjà pour ce risque." });
  const rec = stamp({
    id: id("smq"), ref: impRef(req, r.processId || null), entite: "QHSE", date: now().slice(0, 10),
    processId: r.processId || null, origine: "Risques et opportunités", type: "interne",
    gravite: (Number(r.vraisemblance) || 0) * (Number(r.impact) || 0) >= 13 ? "critique" : "majeure", statut: "ouverte",
    description: `Traitement du risque ${r.ref} — ${r.evenement || ""}. Cause : ${r.cause || ""}. Effet : ${r.effet || ""}.`,
    analyseCauses: r.cause || "", actions: [], emetteurName: req.user.fullName,
    roRecurrence: true, sourceRiskId: r.id, createdAt: now(),
  }, req);
  db.smqImprovements.push(rec); r.improvementId = rec.id; save();
  audit(req.user, "CREATED", "SmqImprovement", rec.id, { ref: rec.ref, fromRisk: r.ref });
  res.status(201).json({ improvement: rec });
});

/* KPI : indicateurs avec dernière mesure + série (pour feu tricolore & tendance). */
router.get("/indicators-kpi", allow(...RO), (req, res) => {
  const procs = mine(db.smqProcesses, req);
  const rows = mine(db.smqIndicators, req).map(i => {
    const ms = mine(db.smqMeasures, req).filter(m => m.indicatorId === i.id)
      .sort((a, b) => String(a.periode).localeCompare(String(b.periode)));
    const derniere = ms.length ? ms[ms.length - 1] : null;
    const cible = parseFloat(i.cible);
    let feu = "gris";
    if (derniere && !isNaN(cible)) {
      const v = Number(derniere.valeur), sens = i.sens === "baisse" ? "baisse" : "hausse";
      const ok = sens === "baisse" ? v <= cible : v >= cible;
      const near = sens === "baisse" ? v <= cible * 1.1 : v >= cible * 0.9;
      feu = ok ? "vert" : (near ? "orange" : "rouge");
    }
    const p = procs.find(x => x.id === i.processId);
    return { id: i.id, libelle: i.libelle, processCode: p ? p.code : "", modeCalcul: i.modeCalcul,
      cible: i.cible, unite: i.unite, frequence: i.frequence, sens: i.sens || "hausse", source: i.source || "manuel",
      derniere, feu, serie: ms.slice(-12).map(m => ({ periode: m.periode, valeur: m.valeur })) };
  }).sort((a, b) => String(a.processCode).localeCompare(String(b.processCode)) || String(a.libelle).localeCompare(String(b.libelle)));
  res.json(rows);
});

/* ============================ Instrumentation auto des indicateurs (Phase 4bis) ============================ */
const qmetrics = require("../quality-metrics");
router.get("/metrics-catalog", allow(...RO), (req, res) => res.json(qmetrics.catalog()));

function computeIndicator(req, ind, period) {
  const tid = req.user.tenantId || "t1";
  const key = ind.autoMetric || (ind.binding && ind.binding.metric);
  if (!key) return { error: "Aucune métrique liée." };
  const r = qmetrics.compute(tid, key, period);
  if (r.error) return r;
  const per = r.periodless ? (period || now().slice(0, 7)) : period;
  // upsert de la mesure (source auto)
  let m = mine(db.smqMeasures, req).find(x => x.indicatorId === ind.id && x.periode === per);
  if (m) { m.valeur = r.value; m.num = r.num; m.den = r.den; m.source = "auto"; m.commentaire = "Calcul auto : " + (r.label || key); m.updatedAt = now(); }
  else { m = stamp({ id: id("smq"), indicatorId: ind.id, periode: per, valeur: r.value, num: r.num, den: r.den, source: "auto", commentaire: "Calcul auto : " + (r.label || key), createdAt: now() }, req); db.smqMeasures.push(m); }
  return { measure: m, result: r };
}
router.post("/indicators/:id/compute", allow(...RW), (req, res) => {
  const ind = mine(db.smqIndicators, req).find(x => x.id === req.params.id); if (!ind) return res.status(404).json({ error: "Introuvable" });
  const period = (req.body && req.body.period) || now().slice(0, 7);
  const r = computeIndicator(req, ind, period);
  if (r.error) return res.status(400).json({ error: r.error });
  save(); res.json(r);
});
router.post("/indicators/compute-all", allow(...RW), (req, res) => {
  const period = (req.body && req.body.period) || now().slice(0, 7);
  const autos = mine(db.smqIndicators, req).filter(i => i.source === "auto" && (i.autoMetric || (i.binding && i.binding.metric)));
  let done = 0, errors = 0;
  for (const ind of autos) { const r = computeIndicator(req, ind, period); if (r.error) errors++; else done++; }
  save(); res.json({ period, total: autos.length, done, errors });
});

/* ============================ Écoute client : satisfaction & réclamations (§9.1.2) ============================ */
const CLAIM_STATUTS = ["ouverte", "en_cours", "resolue", "cloturee"];

crud("satisfaction", "smqSatisfaction",
  ["clientName", "contactId", "periode", "canal", "score", "scoreMax", "note", "date", "campagne"],
  "clientName", "date");

router.get("/satisfaction-summary", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const rows = mine(db.smqSatisfaction, req);
  const norm = (r) => { const max = Number(r.scoreMax) || 100; return max ? (Number(r.score) || 0) / max * 100 : 0; };
  const moyenne = rows.length ? Math.round(rows.reduce((a, r) => a + norm(r), 0) / rows.length * 10) / 10 : 0;
  const byPeriod = {}; rows.forEach(r => { const p = String(r.periode || r.date || "").slice(0, 7); if (!p) return; (byPeriod[p] = byPeriod[p] || []).push(norm(r)); });
  const trend = Object.keys(byPeriod).sort().map(p => ({ periode: p, moyenne: Math.round(byPeriod[p].reduce((a, b) => a + b, 0) / byPeriod[p].length * 10) / 10, n: byPeriod[p].length }));
  const byCanal = {}; rows.forEach(r => { const c = r.canal || "—"; (byCanal[c] = byCanal[c] || []).push(norm(r)); });
  const canaux = Object.keys(byCanal).map(c => ({ canal: c, moyenne: Math.round(byCanal[c].reduce((a, b) => a + b, 0) / byCanal[c].length * 10) / 10, n: byCanal[c].length }));
  res.json({ total: rows.length, moyenne, trend, canaux });
});

/* Réclamations */
router.get("/claims", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  let rows = mine(db.smqClaims, req).slice();
  if (req.query && req.query.statut) rows = rows.filter(r => r.statut === req.query.statut);
  rows.sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
  res.json(rows);
});
function claimRef(req) {
  const y = new Date().getFullYear();
  const same = mine(db.smqClaims, req).filter(x => String(x.ref || "").endsWith("/" + y));
  let max = 0; for (const x of same) { const n = parseInt(String(x.ref), 10); if (n > max) max = n; }
  return "REC-" + String(max + 1).padStart(3, "0") + "/" + y;
}
const CLAIM_FIELDS = ["clientName", "contactId", "date", "objet", "description", "gravite", "canal", "statut", "reponse", "closedAt"];
router.post("/claims", allow(...RW), (req, res) => {
  const b = req.body || {};
  const rec = { id: id("smq"), ref: b.ref || claimRef(req), date: b.date || now().slice(0, 10), statut: b.statut || "ouverte", gravite: b.gravite || "mineure", createdAt: now() };
  for (const f of CLAIM_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqClaims.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqClaim", rec.id, { ref: rec.ref });
  res.status(201).json(rec);
});
router.put("/claims/:id", allow(...RW), (req, res) => {
  const c = mine(db.smqClaims, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" });
  for (const f of CLAIM_FIELDS) if (req.body[f] !== undefined) c[f] = req.body[f];
  if (c.statut === "cloturee" && !c.closedAt) c.closedAt = now().slice(0, 10);
  c.updatedAt = now(); save(); res.json(c);
});
router.delete("/claims/:id", allow("ADM", "CD"), (req, res) => {
  const c = mine(db.smqClaims, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" });
  db.smqClaims.splice(db.smqClaims.indexOf(c), 1); save(); res.json({ ok: true });
});
router.post("/claims/:id/to-improvement", allow(...RW), (req, res) => {
  const c = mine(db.smqClaims, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" });
  if (c.improvementId) return res.status(409).json({ error: "Une fiche existe déjà pour cette réclamation." });
  const rec = stamp({
    id: id("smq"), ref: impRef(req, null), entite: "QHSE", date: now().slice(0, 10),
    origine: "Réclamation client", type: "interne", gravite: c.gravite || "majeure", statut: "ouverte",
    description: `Réclamation ${c.ref} — ${c.clientName || ""} : ${c.objet || ""}. ${c.description || ""}`,
    analyseCauses: "", actions: [], emetteurName: req.user.fullName, sourceClaimId: c.id, createdAt: now(),
  }, req);
  db.smqImprovements.push(rec); c.improvementId = rec.id; save();
  audit(req.user, "CREATED", "SmqImprovement", rec.id, { ref: rec.ref, fromClaim: c.ref });
  res.status(201).json({ improvement: rec });
});
router.get("/claims-summary", allow(...RO), (req, res) => {
  const rows = mine(db.smqClaims, req);
  const byStatut = { ouverte: 0, en_cours: 0, resolue: 0, cloturee: 0 };
  rows.forEach(r => { byStatut[r.statut] = (byStatut[r.statut] || 0) + 1; });
  const resolues = byStatut.resolue + byStatut.cloturee;
  res.json({ total: rows.length, byStatut, ouvertes: rows.length - resolues, tauxResolution: rows.length ? Math.round(resolues / rows.length * 1000) / 10 : 0 });
});

/* ============================ Ressources : compétences, fournisseurs, métrologie (§7.1, §7.2, §8.4) ============================ */
const DAYS = (d) => { const t = new Date(); const x = new Date(d); return Math.round((x - t) / 86400000); };

/* --- Compétences / habilitations (lien RH) --- */
crud("competences", "smqCompetences",
  ["employeeId", "employeeName", "poste", "competence", "niveauRequis", "niveauActuel", "habilitation", "dateObtention", "dateExpiration", "preuveFileId"],
  "competence", "employeeName");
router.get("/competences-summary", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const rows = mine(db.smqCompetences, req);
  const ecarts = rows.filter(r => (Number(r.niveauActuel) || 0) < (Number(r.niveauRequis) || 0)).length;
  const today = now().slice(0, 10); const soon = new Date(); soon.setDate(soon.getDate() + 60); const soonS = soon.toISOString().slice(0, 10);
  const expirant = rows.filter(r => r.habilitation && r.dateExpiration && r.dateExpiration <= soonS)
    .map(r => ({ id: r.id, employeeName: r.employeeName, competence: r.competence, dateExpiration: r.dateExpiration, expiree: r.dateExpiration < today }))
    .sort((a, b) => String(a.dateExpiration).localeCompare(String(b.dateExpiration)));
  res.json({ total: rows.length, ecarts, expirant });
});

/* --- Évaluation des fournisseurs (lien stock) --- */
function supEvalCompute(e) {
  const c = e.criteres || {};
  const vals = ["qualite", "delai", "prix", "reactivite"].map(k => Number(c[k]) || 0).filter(v => v > 0);
  const note = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : 0;
  return Object.assign({}, e, { note });
}
router.get("/supplier-evals", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  res.json(mine(db.smqSupplierEvals, req).map(supEvalCompute).sort((a, b) => String(b.periode || "").localeCompare(String(a.periode || ""))));
});
const SUPEVAL_FIELDS = ["supplierId", "supplierName", "periode", "criteres", "decision", "commentaire"];
router.post("/supplier-evals", allow(...RW), (req, res) => {
  const b = req.body || {};
  const rec = { id: id("smq"), periode: b.periode || now().slice(0, 7), decision: b.decision || "agréé", criteres: b.criteres || {}, createdAt: now() };
  for (const f of SUPEVAL_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqSupplierEvals.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqSupplierEval", rec.id, {});
  res.status(201).json(supEvalCompute(rec));
});
router.put("/supplier-evals/:id", allow(...RW), (req, res) => {
  const e = mine(db.smqSupplierEvals, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Introuvable" });
  for (const f of SUPEVAL_FIELDS) if (req.body[f] !== undefined) e[f] = req.body[f];
  e.updatedAt = now(); save(); res.json(supEvalCompute(e));
});
router.delete("/supplier-evals/:id", allow("ADM", "CD"), (req, res) => {
  const e = mine(db.smqSupplierEvals, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Introuvable" });
  db.smqSupplierEvals.splice(db.smqSupplierEvals.indexOf(e), 1); save(); res.json({ ok: true });
});
router.get("/supplier-evals-summary", allow(...RO), (req, res) => {
  const rows = mine(db.smqSupplierEvals, req).map(supEvalCompute);
  const byDecision = {}; rows.forEach(r => { byDecision[r.decision] = (byDecision[r.decision] || 0) + 1; });
  const agrees = (byDecision["agréé"] || 0) + (byDecision["sous conditions"] || 0);
  res.json({ total: rows.length, byDecision, tauxAgrees: rows.length ? Math.round(agrees / rows.length * 1000) / 10 : 0, noteMoyenne: rows.length ? Math.round(rows.reduce((a, r) => a + r.note, 0) / rows.length * 10) / 10 : 0 });
});

/* --- Métrologie / équipements (§7.1.5) --- */
function eqCompute(e) {
  let prochain = e.prochainEtalonnage;
  if (!prochain && e.dernierEtalonnage && e.frequenceEtalonnageMois) {
    const d = new Date(e.dernierEtalonnage); d.setMonth(d.getMonth() + (Number(e.frequenceEtalonnageMois) || 12));
    prochain = d.toISOString().slice(0, 10);
  }
  const joursRestants = prochain ? DAYS(prochain) : null;
  let statutAuto = e.statut || "conforme";
  if (joursRestants != null) { if (joursRestants < 0) statutAuto = "hors service"; else if (joursRestants <= 30) statutAuto = "à surveiller"; }
  return Object.assign({}, e, { prochainEtalonnage: prochain, joursRestants, statutAuto });
}
router.get("/equipment", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  res.json(mine(db.smqEquipment, req).map(eqCompute).sort((a, b) => String(a.prochainEtalonnage || "9999").localeCompare(String(b.prochainEtalonnage || "9999"))));
});
const EQ_FIELDS = ["code", "designation", "localisation", "frequenceEtalonnageMois", "dernierEtalonnage", "prochainEtalonnage", "statut", "certificatFileId"];
router.post("/equipment", allow(...RW), (req, res) => {
  const b = req.body || {}; if (!b.designation) return res.status(400).json({ error: "Désignation obligatoire" });
  const rec = { id: id("smq"), statut: b.statut || "conforme", createdAt: now() };
  for (const f of EQ_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqEquipment.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqEquipment", rec.id, {});
  res.status(201).json(eqCompute(rec));
});
router.put("/equipment/:id", allow(...RW), (req, res) => {
  const e = mine(db.smqEquipment, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Introuvable" });
  for (const f of EQ_FIELDS) if (req.body[f] !== undefined) e[f] = req.body[f];
  e.updatedAt = now(); save(); res.json(eqCompute(e));
});
router.delete("/equipment/:id", allow("ADM", "CD"), (req, res) => {
  const e = mine(db.smqEquipment, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Introuvable" });
  db.smqEquipment.splice(db.smqEquipment.indexOf(e), 1); save(); res.json({ ok: true });
});
router.get("/equipment-summary", allow(...RO), (req, res) => {
  const rows = mine(db.smqEquipment, req).map(eqCompute);
  const conformes = rows.filter(r => r.statutAuto === "conforme").length;
  const aEtalonner = rows.filter(r => r.joursRestants != null && r.joursRestants <= 30).length;
  res.json({ total: rows.length, conformes, aEtalonner, tauxConforme: rows.length ? Math.round(conformes / rows.length * 1000) / 10 : 0 });
});

/* ============================ Revue de direction / processus (§9.3) — auto-agrégation ============================ */
// Rassemble les données d'entrée ISO 9.3 en direct. scope 'direction' (global) ou 'processus' (processId).
function reviewAggregate(req, opts = {}) {
  const scope = opts.scope || "direction";
  const pid = opts.processId || null;
  const inProc = (x) => !pid || x.processId === pid;

  const fiches = mine(db.smqImprovements, req).filter(inProc);
  const capaByOrigine = {};
  IMP_ORIGINES.forEach(o => { capaByOrigine[o] = { total: 0, cloturee: 0 }; });
  fiches.forEach(f => { const o = IMP_ORIGINES.includes(f.origine) ? f.origine : "Autres"; capaByOrigine[o].total++; if (f.statut === "cloturee") capaByOrigine[o].cloturee++; });
  let actionsRetard = 0; const today = now().slice(0, 10);
  fiches.forEach(f => (f.actions || []).forEach(a => { if (a.echeance && a.echeance < today && !["cloturee", "verifiee", "faite"].includes(a.statut)) actionsRetard++; }));

  const audits = mine(db.smqAudits, req).filter(a => !pid || (a.processIds || []).includes(pid));
  const auditItems = mine(db.smqAuditItems, req).filter(i => audits.some(a => a.id === i.auditId));

  const risks = mine(db.smqRisks, req).filter(inProc).map(riskCompute);
  const riskBand = { faible: 0, moyen: 0, eleve: 0, critique: 0 };
  risks.filter(r => (r.sens || "R") === "R").forEach(r => riskBand[r.band]++);

  const inds = mine(db.smqIndicators, req).filter(inProc);
  const feux = { vert: 0, orange: 0, rouge: 0, gris: 0 };
  inds.forEach(i => {
    const ms = mine(db.smqMeasures, req).filter(m => m.indicatorId === i.id).sort((a, b) => String(a.periode).localeCompare(String(b.periode)));
    const d = ms[ms.length - 1]; const cible = parseFloat(i.cible);
    let feu = "gris";
    if (d && !isNaN(cible)) { const v = Number(d.valeur), ok = (i.sens === "baisse") ? v <= cible : v >= cible, near = (i.sens === "baisse") ? v <= cible * 1.1 : v >= cible * 0.9; feu = ok ? "vert" : (near ? "orange" : "rouge"); }
    feux[feu]++;
  });

  const out = {
    scope, processId: pid, generatedAt: now(),
    fiches: { total: fiches.length, ouvertes: fiches.filter(f => f.statut !== "cloturee").length, capaByOrigine, actionsRetard },
    audits: { total: audits.length, realises: audits.filter(a => a.statut !== "planifie").length, ncMajeures: auditItems.filter(i => i.conformite === "NC" && i.gravite === "majeure").length, ncMineures: auditItems.filter(i => i.conformite === "NC" && i.gravite !== "majeure").length, observations: auditItems.filter(i => i.conformite === "OBS").length },
    risques: { total: risks.filter(r => (r.sens || "R") === "R").length, band: riskBand, prioritaires: risks.filter(r => r.prioritaire).length },
    indicateurs: { total: inds.length, feux },
  };
  // écoute client & ressources : seulement en revue de direction (global)
  if (scope === "direction") {
    const sat = mine(db.smqSatisfaction, req); const norm = r => { const mx = Number(r.scoreMax) || 100; return mx ? (Number(r.score) || 0) / mx * 100 : 0; };
    out.satisfaction = { total: sat.length, moyenne: sat.length ? Math.round(sat.reduce((a, r) => a + norm(r), 0) / sat.length * 10) / 10 : 0 };
    const claims = mine(db.smqClaims, req);
    out.reclamations = { total: claims.length, ouvertes: claims.filter(c => !["resolue", "cloturee"].includes(c.statut)).length };
    const comps = mine(db.smqCompetences, req);
    out.competences = { total: comps.length, ecarts: comps.filter(c => (Number(c.niveauActuel) || 0) < (Number(c.niveauRequis) || 0)).length, habilitationsExpirees: comps.filter(c => c.habilitation && c.dateExpiration && c.dateExpiration < today).length };
    const sups = mine(db.smqSupplierEvals, req);
    out.fournisseurs = { total: sups.length, agrees: sups.filter(s => ["agréé", "sous conditions"].includes(s.decision)).length };
    const eqs = mine(db.smqEquipment, req).map(eqCompute);
    out.equipements = { total: eqs.length, aEtalonner: eqs.filter(e => e.joursRestants != null && e.joursRestants <= 30).length };
    out.politique = mine(db.smqPolicy, req).find(p => p.enVigueur) || null;
    out.axes = mine(db.smqAxes, req).length;
  }
  return out;
}
router.get("/reviews/aggregate", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  res.json(reviewAggregate(req, { scope: req.query.scope || "direction", processId: req.query.processId || null }));
});

function reviewRef(req, scope) {
  const y = new Date().getFullYear(); const pre = scope === "processus" ? "RP" : "RD";
  const same = mine(db.smqReviews, req).filter(x => String(x.ref || "").startsWith(pre) && String(x.ref || "").endsWith("/" + y));
  return pre + "-" + String(same.length + 1).padStart(2, "0") + "/" + y;
}
router.get("/reviews", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  res.json(mine(db.smqReviews, req).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))));
});
router.get("/reviews/:id", allow(...RO), (req, res) => {
  const r = mine(db.smqReviews, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  res.json(r);
});
const REVIEW_FIELDS = ["scope", "processId", "date", "periode", "participants", "ordreDuJour", "decisions", "actions", "conclusion", "nextDate", "statut"];
router.post("/reviews", allow(...RW), (req, res) => {
  const b = req.body || {};
  const scope = b.scope || "direction";
  const rec = { id: id("smq"), ref: b.ref || reviewRef(req, scope), scope, date: b.date || now().slice(0, 10),
    statut: b.statut || "realise", decisions: b.decisions || [], actions: b.actions || [],
    inputs: reviewAggregate(req, { scope, processId: b.processId || null }), createdAt: now() };
  for (const f of REVIEW_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqReviews.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqReview", rec.id, { ref: rec.ref });
  res.status(201).json(rec);
});
router.put("/reviews/:id", allow(...RW), (req, res) => {
  const r = mine(db.smqReviews, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  for (const f of REVIEW_FIELDS) if (req.body[f] !== undefined) r[f] = req.body[f];
  if (req.body.refreshInputs) r.inputs = reviewAggregate(req, { scope: r.scope, processId: r.processId });
  r.updatedAt = now(); save(); res.json(r);
});
router.delete("/reviews/:id", allow("ADM", "CD"), (req, res) => {
  const r = mine(db.smqReviews, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  db.smqReviews.splice(db.smqReviews.indexOf(r), 1); save(); res.json({ ok: true });
});

/* ============================ Prêt pour certification : conformité par clause & analyse d'écart ============================ */
const CONF_STATUTS = ["conforme", "partiel", "non_conforme", "non_applicable", "non_evalue"];
const CONF_WEIGHT = { conforme: 1, partiel: 0.5, non_conforme: 0, non_applicable: null, non_evalue: 0 };
const chapterOf = (code) => String(code || "").split(".")[0];

function conformityRows(req) {
  seedSMQ(req.user.tenantId || "t1");
  const clauses = mine(db.smqClauses, req).filter(c => String(c.code).includes(".")); // sous-clauses
  const assess = mine(db.smqConformity, req);
  const items = mine(db.smqAuditItems, req);
  const scope = mine(db.smqScope, req)[0] || {};
  const excl = new Set((scope.exclusions || []).map(e => String(e.clause)));
  return clauses.map(c => {
    const a = assess.find(x => x.clauseCode === c.code) || {};
    const findings = items.filter(i => i.clause === c.code);
    let statut = a.statut;
    if (!statut) statut = excl.has(c.code) ? "non_applicable" : "non_evalue";
    return {
      clauseCode: c.code, titre: c.titre, chapitre: chapterOf(c.code),
      statut, preuves: a.preuves || "", responsable: a.responsable || "", commentaire: a.commentaire || "",
      lastReviewedAt: a.lastReviewedAt || null,
      constatsNC: findings.filter(i => i.conformite === "NC").length,
      constatsC: findings.filter(i => i.conformite === "C").length,
      observations: findings.filter(i => i.conformite === "OBS").length,
      exclue: excl.has(c.code),
    };
  }).sort((a, b) => String(a.clauseCode).localeCompare(String(b.clauseCode), "fr", { numeric: true }));
}
router.get("/conformity", allow(...RO), (req, res) => res.json(conformityRows(req)));
router.put("/conformity/:clauseCode", allow(...RW), (req, res) => {
  const code = req.params.clauseCode;
  let a = mine(db.smqConformity, req).find(x => x.clauseCode === code);
  if (!a) { a = stamp({ id: id("smq"), clauseCode: code, createdAt: now() }, req); db.smqConformity.push(a); }
  for (const f of ["statut", "preuves", "responsable", "commentaire"]) if (req.body[f] !== undefined) a[f] = req.body[f];
  a.lastReviewedAt = now().slice(0, 10); save(); audit(req.user, "UPDATED", "SmqConformity", code, { statut: a.statut });
  res.json(a);
});
function conformitySummary(req) {
  const rows = conformityRows(req);
  const applicable = rows.filter(r => r.statut !== "non_applicable");
  const scored = applicable.filter(r => CONF_WEIGHT[r.statut] != null);
  const taux = scored.length ? Math.round(scored.reduce((s, r) => s + CONF_WEIGHT[r.statut], 0) / scored.length * 1000) / 10 : 0;
  const byStatut = {}; CONF_STATUTS.forEach(s => byStatut[s] = 0); rows.forEach(r => byStatut[r.statut]++);
  const chapters = {};
  applicable.forEach(r => { const c = r.chapitre; (chapters[c] = chapters[c] || { total: 0, score: 0, evalues: 0 }); chapters[c].total++; if (CONF_WEIGHT[r.statut] != null) { chapters[c].score += CONF_WEIGHT[r.statut]; chapters[c].evalues++; } });
  const byChapter = Object.keys(chapters).sort((a, b) => a - b).map(c => ({ chapitre: c, taux: chapters[c].evalues ? Math.round(chapters[c].score / chapters[c].evalues * 1000) / 10 : 0, total: chapters[c].total }));
  return { taux, total: rows.length, applicable: applicable.length, byStatut, byChapter };
}
router.get("/conformity-summary", allow(...RO), (req, res) => res.json(conformitySummary(req)));
router.get("/conformity/gap", allow(...RO), (req, res) => {
  const rows = conformityRows(req).filter(r => ["non_conforme", "partiel", "non_evalue"].includes(r.statut));
  res.json(rows);
});


/* ---- Registre des informations documentées (§7.5) : import Excel + export ---- */
router.post("/documents/import-register", allow(...RW), smqImport.single("file"), (req, res) => {
  if (!mgrOnly(req, res)) return;
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const b = req.body || {};
  const _buf = xlsxBuf(req);
  if (!_buf) return res.status(400).json({ error: "Fichier manquant" });
  let rows;
  try {
    const wb = XLSX.read(_buf, { type: "buffer", cellDates: true, sheetRows: 20000, bookDeps: false });
    const ws = wb.Sheets["Informations documentées"] || wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
  } catch (e) { return res.status(400).json({ error: "Lecture Excel impossible : " + e.message }); }
  seedSMQ(req.user.tenantId || "t1");
  const procs = mine(db.smqProcesses, req);
  const findProc = (txt) => { const code = String(txt || "").split(/[-\s]/)[0].trim().toUpperCase(); return procs.find(p => (p.code || "").toUpperCase() === code); };
  const t = mine(db.smqDocTypes, req);
  const d10 = (v) => { if (!v) return ""; if (v instanceof Date) return v.toISOString().slice(0, 10); const d = new Date(v); return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10); };
  let added = 0, skipped = 0;
  // trouver la ligne d'en-tête (contient "Type de document")
  let start = 0;
  for (let i = 0; i < Math.min(rows.length, 6); i++) if (String(rows[i][0] || "").toLowerCase().includes("type")) { start = i + 2; break; }
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r[0] || !r[3]) continue;              // type + référence requis
    const ref = String(r[3]).trim();
    if (mine(db.smqDocuments, req).some(x => x.ref === ref)) { skipped++; continue; }
    const p = findProc(r[2]);
    const docId = id("smq"), revId = id("smq");
    const dc = d10(r[4]) || now().slice(0, 10);
    db.smqDocRevisions.push(stamp({ id: revId, documentId: docId, version: "1", ref, statut: "en_vigueur",
      redacteurName: "", dateCreation: dc, dateModification: d10(r[5]) || dc, resumeModif: "Import registre", createdAt: now() }, req));
    db.smqDocuments.push(stamp({ id: docId, ref, titre: String(r[1] || "").trim(), typeCode: String(r[0]).trim(),
      processId: p ? p.id : null, seq: 0, statutCourant: "en_vigueur", versionCourante: "1", currentRevisionId: revId,
      dateCreation: dc,
      stockageMode: r[6] || "", stockageLieu: r[7] || "", stockageDuree: (r[8] == null ? "" : String(r[8])),
      archivageMode: r[9] || "", archivageLieu: r[10] || "", archivageDuree: (r[11] == null ? "" : String(r[11])),
      destructionLieu: r[12] || "", destructionMethode: r[13] || "", observations: r[14] || "", createdAt: now() }, req));
    added++;
  }
  save(); audit(req.user, "CREATED", "SmqRegisterImport", "register", { added, skipped });
  res.json({ ok: true, added, skipped });
});

router.get("/documents/register-export", allow(...RO), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const procs = mine(db.smqProcesses, req);
  const pLabel = (pid) => { const p = procs.find(x => x.id === pid); return p ? (p.code + " - " + p.intitule) : ""; };
  const docs = mine(db.smqDocuments, req).slice().sort((a, b) => String(a.ref || "").localeCompare(String(b.ref || ""), "fr", { numeric: true }));
  const head1 = ["Type de document", "Identification de l'enregistrement", "Processus/activité", "Référence", "Date de création", "Dernière modification", "Stockage", "", "", "Archivage", "", "", "Destruction", "", "observations"];
  const head2 = ["", "", "", "", "", "", "Mode", "Lieu /responsable", "Durée (ans)", "Mode", "Lieu", "Durée", "Lieu", "Méthode", ""];
  const aoa = [head1, head2];
  for (const d of docs) {
    const rev = mine(db.smqDocRevisions, req).find(x => x.id === d.currentRevisionId) || {};
    aoa.push([d.typeCode || "", d.titre || "", pLabel(d.processId), d.ref || "", d.dateCreation || "", rev.dateModification || "",
      d.stockageMode || "", d.stockageLieu || "", d.stockageDuree || "", d.archivageMode || "", d.archivageLieu || "", d.archivageDuree || "",
      d.destructionLieu || "", d.destructionMethode || "", d.observations || ""]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Informations documentées");
  res.setHeader("Content-Disposition", 'attachment; filename="registre_informations_documentees.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

/* ---- Suppression d'un document (responsable SMQ ou pilote du processus) ---- */
router.delete("/documents/:id", allow(...RW), (req, res) => {
  const d = mine(db.smqDocuments, req).find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, d.processId)) return DENY(res);
  db.smqDocRevisions = db.smqDocRevisions.filter(r => r.documentId !== d.id);
  db.smqDocuments.splice(db.smqDocuments.indexOf(d), 1); save();
  audit(req.user, "DELETED", "SmqDocument", d.id, { ref: d.ref }); res.json({ ok: true });
});

/* ---- Attribution des pilotes/co-pilotes d'un processus (admin ou responsable SMQ) ---- */
router.put("/processes/:id/pilotes", allow("ADM", "SADM", "CD", "RJ", "RQ"), (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: "Réservé à l'administrateur ou au responsable SMQ." });
  const p = mine(db.smqProcesses, req).find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  const uName2 = (uid) => { const u = (db.users || []).find(x => x.id === uid); return u ? u.fullName : ""; };
  if (b.piloteUserId !== undefined) { p.piloteUserId = b.piloteUserId || null; p.piloteName = b.piloteUserId ? uName2(b.piloteUserId) : ""; }
  if (b.coPiloteUserId !== undefined) { p.coPiloteUserId = b.coPiloteUserId || null; p.coPiloteName = b.coPiloteUserId ? uName2(b.coPiloteUserId) : ""; }
  p.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqProcess", p.id, { pilotes: true });
  res.json({ id: p.id, piloteUserId: p.piloteUserId, piloteName: p.piloteName, coPiloteUserId: p.coPiloteUserId, coPiloteName: p.coPiloteName });
});

/* ---- Pièces jointes des documents (fichier original attaché à une version) ---- */
router.post("/documents/upload", allow(...RW), smqUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  res.json({ storedAs: req.file.filename, name: req.file.originalname, size: req.file.size });
});
router.get("/revisions/:id/file", allow(...RO), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id);
  if (!r || !r.file || !r.file.storedAs) return res.status(404).json({ error: "Aucun fichier" });
  res.download(_path.join(SMQ_DIR, r.file.storedAs), r.file.name || "document");
});
router.get("/documents/:id/file", allow(...RO), (req, res) => {
  const d = mine(db.smqDocuments, req).find(x => x.id === req.params.id);
  const r = d && mine(db.smqDocRevisions, req).find(x => x.id === d.currentRevisionId);
  if (!r || !r.file || !r.file.storedAs) return res.status(404).json({ error: "Aucun fichier" });
  res.download(_path.join(SMQ_DIR, r.file.storedAs), r.file.name || "document");
});
/* ---- Contexte de gouvernance pour l'utilisateur courant ---- */
router.get("/users", allow(...RO), (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: "Réservé au responsable SMQ ou à l'administrateur." });
  res.json((db.users || []).filter(u => (u.tenantId || "t1") === (req.user.tenantId || "t1") && u.role !== "SADM")
    .map(u => ({ id: u.id, fullName: u.fullName, role: u.role, smqManager: !!u.smqManager, active: u.active })));
});
router.get("/workspace", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const manager = isManager(req);
  const ids = manager ? mine(db.smqProcesses, req).map(p => p.id) : myProcessIds(req);
  const procs = mine(db.smqProcesses, req).filter(p => ids.includes(p.id)).sort((a, b) => (a.ordre || 99) - (b.ordre || 99));
  const docs = mine(db.smqDocuments, req), risks = mine(db.smqRisks, req), tdb = mine(db.smqTdb, req), imps = mine(db.smqImprovements, req);
  const out = procs.map(p => {
    const pdocs = docs.filter(d => d.processId === p.id);
    const byType = {}; pdocs.forEach(d => { const k = d.typeCode || "?"; byType[k] = (byType[k] || 0) + 1; });
    const prisks = risks.filter(r => r.processId === p.id);
    return {
      id: p.id, code: p.code, intitule: p.intitule, type: p.type, statut: p.statut,
      piloteName: p.piloteName || "", coPiloteName: p.coPiloteName || "",
      documents: pdocs.length, docsByType: byType,
      risques: prisks.filter(r => (r.sens || "R") === "R").length, opportunites: prisks.filter(r => r.sens === "O").length,
      tdb: tdb.filter(t => t.processId === p.id).length,
      ameliorations: imps.filter(i => i.processId === p.id && i.statut !== "cloturee").length,
      objectifs: (p.objectifs || []).length,
    };
  });
  res.json({ manager, role: manager ? "Responsable SMQ" : "Pilote / Co-pilote", processes: out });
});
router.get("/my-context", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  const manager = isManager(req);
  const procs = mine(db.smqProcesses, req);
  const mine_procs = procs.filter(p => p.piloteUserId === req.user.id || p.coPiloteUserId === req.user.id).map(p => p.id);
  res.json({ manager, piloteProcessIds: mine_procs });
});

/* ============================ Tableau de bord processus (moteur type Excel CRHE) ============================ */
const MOIS_FR = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const FREQ_LABELS = { M: "Mensuel", T: "Trimestriel", S: "Semestriel", A: "Annuel" };
function parseCible(v) {
  if (v == null || v === "") return null;
  let str = String(v).replace(/[≥≤>=<\s]/g, "");
  const pct = str.includes("%"); str = str.replace("%", "").replace(",", ".");
  const n = parseFloat(str); if (isNaN(n)) return null;
  return pct ? n / 100 : n;
}
// Un indicateur : {key, libelle, freq, cible, sens('up'|'down'), formula:{op:'val'|'ratio'|'sum'|'avg'|'cumul', col, numCol, denCol}}
function tdbCompute(tdb, dataRows) {
  const byMonth = {};                       // mois(1..12) -> values{colKey:num}
  (dataRows || []).forEach(r => { byMonth[r.mois] = r.values || {}; });
  const num = (m, col) => { const v = (byMonth[m] || {})[col]; return v === "" || v == null ? null : Number(v); };
  const monthsWith = (col) => { const a = []; for (let m = 1; m <= 12; m++) { const v = num(m, col); if (v != null) a.push(v); } return a; };
  const inds = (tdb.indicators || []).map(ind => {
    const F = ind.formula || {}; const monthly = [];
    for (let m = 1; m <= 12; m++) {
      let val = null;
      if (F.op === "ratio") { const n = num(m, F.numCol), d = num(m, F.denCol); val = (n != null && d) ? n / d : null; }
      else if (F.op === "cumul") { let sum = 0, any = false; for (let k = 1; k <= m; k++) { const v = num(k, F.col); if (v != null) { sum += v; any = true; } } val = any ? sum : null; }
      else { val = num(m, F.col); }        // val/sum/avg mensuel = valeur du mois (1 ligne/mois)
      monthly.push(val);
    }
    // résultat annuel
    let result = null;
    if (F.op === "ratio") { let n = 0, d = 0, any = false; for (let m = 1; m <= 12; m++) { const a = num(m, F.numCol), b = num(m, F.denCol); if (a != null) { n += a; any = true; } if (b != null) d += b; } result = any && d ? n / d : null; }
    else if (F.op === "sum") { const a = monthsWith(F.col); result = a.length ? a.reduce((x, y) => x + y, 0) : null; }
    else if (F.op === "cumul") { const a = monthsWith(F.col); result = a.length ? a.reduce((x, y) => x + y, 0) : null; }
    else { const a = monthsWith(F.col); result = a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }   // avg / val
    const cible = ind.cible != null ? Number(ind.cible) : parseCible(ind.cibleTexte);
    let feu = "gris";
    if (result != null && cible != null) {
      const up = ind.sens !== "down";
      if (up) feu = result >= cible ? "vert" : (result < cible * 0.8 ? "rouge" : "orange");
      else feu = result <= cible ? "vert" : (result > cible * 1.2 ? "rouge" : "orange");
    }
    return Object.assign({}, ind, { monthly, result, cible, feu });
  });
  // performance globale = (vert + 0.8*orange) / (vert+orange+rouge)
  let v = 0, o = 0, r = 0; inds.forEach(i => { if (i.feu === "vert") v++; else if (i.feu === "orange") o++; else if (i.feu === "rouge") r++; });
  const perf = (v + o + r) ? (v + o * 0.8) / (v + o + r) : null;
  const perfFeu = perf == null ? "gris" : (perf >= 0.8 ? "vert" : (perf < 0.7 ? "rouge" : "orange"));
  return { indicators: inds, performance: perf, performanceFeu: perfFeu };
}

router.get("/tdb", allow(...RO), (req, res) => {
  seedSMQ(req.user.tenantId || "t1");
  let rows = scopeByProc(req, mine(db.smqTdb, req), t => t.processId);
  if (req.query && req.query.processId) rows = rows.filter(x => x.processId === req.query.processId);
  rows.sort((a, b) => String(a.processId).localeCompare(String(b.processId)) || (b.annee - a.annee));
  const procs = mine(db.smqProcesses, req);
  res.json(rows.map(t => { const p = procs.find(x => x.id === t.processId); return { id: t.id, processId: t.processId, processCode: p ? p.code : "", titre: t.titre, annee: t.annee, nbIndicateurs: (t.indicators || []).length }; }));
});
router.get("/tdb/:id", allow(...RO), (req, res) => {
  const t = mine(db.smqTdb, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  const data = mine(db.smqTdbData, req).filter(d => d.tdbId === t.id).sort((a, b) => a.mois - b.mois);
  const canEdit = procAccess(req, t.processId);
  res.json({ tdb: t, data, computed: tdbCompute(t, data), canEditData: canEdit, canEditDef: isManager(req), mois: MOIS_FR });
});
const TDB_FIELDS = ["processId", "titre", "annee", "baseColumns", "indicators"];
router.post("/tdb", allow(...RW), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const b = req.body || {}; if (!b.processId) return res.status(400).json({ error: "Processus obligatoire" });
  const rec = { id: id("smq"), annee: b.annee || new Date().getFullYear(), baseColumns: [], indicators: [], titre: b.titre || "Tableau de bord", createdAt: now() };
  for (const f of TDB_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqTdb.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqTdb", rec.id, {}); res.status(201).json(rec);
});
router.put("/tdb/:id", allow(...RW), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const t = mine(db.smqTdb, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  for (const f of TDB_FIELDS) if (req.body[f] !== undefined) t[f] = req.body[f];
  t.updatedAt = now(); save(); res.json(t);
});
router.delete("/tdb/:id", allow("ADM", "CD", "RQ"), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const t = mine(db.smqTdb, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  db.smqTdbData = db.smqTdbData.filter(d => d.tdbId !== t.id);
  db.smqTdb.splice(db.smqTdb.indexOf(t), 1); save(); res.json({ ok: true });
});
// Saisie des données (base) — pilote ou responsable SMQ.
router.put("/tdb/:id/data", allow(...RW), (req, res) => {
  const t = mine(db.smqTdb, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  if (!procAccess(req, t.processId)) return DENY(res);
  const b = req.body || {}; const mois = Number(b.mois);
  if (!(mois >= 1 && mois <= 12)) return res.status(400).json({ error: "Mois invalide (1-12)" });
  let row = mine(db.smqTdbData, req).find(d => d.tdbId === t.id && d.mois === mois);
  if (!row) { row = stamp({ id: id("smq"), tdbId: t.id, annee: t.annee, mois, values: {}, createdAt: now() }, req); db.smqTdbData.push(row); }
  row.values = Object.assign({}, row.values, b.values || {}); row.updatedAt = now();
  save(); audit(req.user, "UPDATED", "SmqTdbData", t.id, { mois });
  const data = mine(db.smqTdbData, req).filter(d => d.tdbId === t.id);
  res.json({ ok: true, computed: tdbCompute(t, data) });
});

/* ---- Import d'un tableau de bord Excel CRHE (Base de données + Tableau de bord) ---- */
router.post("/tdb/import", allow(...RW), smqImport.single("file"), (req, res) => {
  if (!mgrOnly(req, res)) return;
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const b = req.body || {};
  const _buf = xlsxBuf(req);
  if (!_buf || !b.processId) return res.status(400).json({ error: "Fichier et processus obligatoires" });
  let baseAoa, tbAoa;
  try {
    const wb = XLSX.read(_buf, { type: "buffer", cellDates: true, sheetRows: 20000, bookDeps: false });
    const wsB = wb.Sheets["Base de données"] || wb.Sheets[wb.SheetNames[0]];
    const wsT = wb.Sheets["Tableau de bord"] || wb.Sheets[wb.SheetNames[1]];
    baseAoa = XLSX.utils.sheet_to_json(wsB, { header: 1, blankrows: false, defval: "" });
    tbAoa = wsT ? XLSX.utils.sheet_to_json(wsT, { header: 1, blankrows: false, defval: "" }) : [];
  } catch (e) { return res.status(400).json({ error: "Lecture Excel impossible : " + e.message }); }
  // Colonnes de base = en-têtes (ligne 1) à partir de la colonne 3 (après ANNEE, MOIS)
  const bh = baseAoa[0] || [];
  const baseColumns = [];
  for (let c = 2; c < bh.length; c++) { const lbl = String(bh[c] || "").trim(); if (lbl) baseColumns.push({ key: "c" + c, label: lbl, col: c }); }
  const colByLetter = {}; baseColumns.forEach(bc => { colByLetter[String.fromCharCode(65 + bc.col)] = bc.key; });
  // Ligne d'en-tête du tableau de bord (contient "Indicateur")
  let hRow = -1; for (let i = 0; i < Math.min(tbAoa.length, 12); i++) if (String((tbAoa[i] || [])[0] || "").toLowerCase().includes("indicat")) { hRow = i; break; }
  const indicators = [];
  if (hRow >= 0) {
    for (let i = hRow + 1; i < tbAoa.length; i++) {
      const r = tbAoa[i]; const lib = String((r || [])[0] || "").trim(); if (!lib) continue;
      const freq = String(r[1] || "M").trim().charAt(0).toUpperCase();
      const cibleRaw = r[14];                 // colonne O (Cible)
      const cible = parseCible(cibleRaw);
      // sens : par défaut 'up' ; heuristique par libellé (délai/incident/plainte = down)
      const low = lib.toLowerCase();
      const sens = /délai|incident|plainte|retard|rejet|non[- ]?conform|réclamation/.test(low) ? "down" : "up";
      indicators.push({ key: "i" + i, libelle: lib, freq: ["M", "T", "S", "A"].includes(freq) ? freq : "M", cible, cibleTexte: cibleRaw != null ? String(cibleRaw) : "", sens, formula: { op: "avg", col: baseColumns[0] ? baseColumns[0].key : "" } });
    }
  }
  const annee = b.annee || new Date().getFullYear();
  const tdb = stamp({ id: id("smq"), processId: b.processId, annee, titre: b.titre || "Tableau de bord", baseColumns, indicators, createdAt: now() }, req);
  db.smqTdb.push(tdb);
  // Données : lignes de la base pour l'année demandée
  const moisIndex = {}; MOIS_FR.forEach((m, idx) => moisIndex[m.toLowerCase()] = idx + 1);
  let dataRows = 0;
  for (let i = 1; i < baseAoa.length; i++) {
    const r = baseAoa[i]; if (!r) continue;
    const y = Number(r[0]); const mi = moisIndex[String(r[1] || "").trim().toLowerCase()];
    if (y !== Number(annee) || !mi) continue;
    const values = {}; let has = false;
    baseColumns.forEach(bc => { const v = r[bc.col]; if (v !== "" && v != null) { values[bc.key] = Number(v); has = true; } });
    if (has) { db.smqTdbData.push(stamp({ id: id("smq"), tdbId: tdb.id, annee, mois: mi, values, createdAt: now() }, req)); dataRows++; }
  }
  save(); audit(req.user, "CREATED", "SmqTdb", tdb.id, { import: true, indicators: indicators.length, dataRows });
  res.status(201).json({ tdb, indicators: indicators.length, baseColumns: baseColumns.length, dataRows, note: "Vérifiez les formules des indicateurs (op/colonnes) après import." });
});

router.get("/tdb/:id/export", allow(...RO), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const t = mine(db.smqTdb, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  const data = mine(db.smqTdbData, req).filter(d => d.tdbId === t.id);
  const comp = tdbCompute(t, data);
  const bcols = t.baseColumns || [];
  const baseAoa = [["ANNEE", "MOIS", ...bcols.map(c => c.label)]];
  for (let m = 1; m <= 12; m++) { const row = data.find(d => d.mois === m); baseAoa.push([t.annee, MOIS_FR[m - 1], ...bcols.map(c => (row && row.values[c.key] != null ? row.values[c.key] : ""))]); }
  const tbAoa = [["Indicateurs de performances", "Fréq.", ...MOIS_FR, "Cible", "Résultat", "Appréciation"]];
  comp.indicators.forEach(i => { tbAoa.push([i.libelle, i.freq, ...i.monthly.map(v => v == null ? "" : v), (i.cible != null ? i.cible : (i.cibleTexte || "")), (i.result == null ? "" : i.result), i.feu]); });
  tbAoa.push([]); tbAoa.push(["PERFORMANCE GLOBALE", "", comp.performance == null ? "" : comp.performance]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(baseAoa), "Base de données");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tbAoa), "Tableau de bord");
  res.setHeader("Content-Disposition", `attachment; filename="TdB_${t.annee}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

/* ---- Import d'un fichier « Approche Risque » CRHE (feuille Risques) ---- */
router.post("/risks/import", allow(...RW), smqImport.single("file"), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const b = req.body || {};
  const _buf = xlsxBuf(req);
  if (!_buf) return res.status(400).json({ error: "Fichier manquant" });
  let rows;
  try {
    const wb = XLSX.read(_buf, { type: "buffer", cellDates: true, sheetRows: 20000, bookDeps: false });
    const ws = wb.Sheets["Risques"] || wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
  } catch (e) { return res.status(400).json({ error: "Lecture Excel impossible : " + e.message }); }
  seedSMQ(req.user.tenantId || "t1");
  const procs = mine(db.smqProcesses, req);
  const findProc = (txt) => { const code = String(txt || "").trim().toUpperCase(); return procs.find(p => (p.code || "").toUpperCase() === code); };
  // en-tête : ligne où col0 == "Processus" ; données à partir de +2 (à cause de la sous-ligne Mo/Co/Me)
  let hr = -1; for (let i = 0; i < Math.min(rows.length, 10); i++) if (String((rows[i] || [])[0] || "").trim().toLowerCase() === "processus") { hr = i; break; }
  if (hr < 0) return res.status(400).json({ error: "En-tête « Processus » introuvable dans la feuille Risques." });
  const N = (v) => { const n = Number(v); return isNaN(n) ? undefined : n; };
  let added = 0;
  for (let i = hr + 2; i < rows.length; i++) {
    const r = rows[i]; const ev = String((r || [])[2] || "").trim(); if (!ev) continue;
    if (!procAccess(req, (findProc(r[0]) || {}).id || null) && !isManager(req)) continue;
    const p = findProc(r[0]);
    const rec = stamp({
      id: id("smq"), ref: riskRef(req), processId: p ? p.id : null,
      objectifRef: String(r[1] || "").trim(), evenement: ev, source: String(r[3] || "").trim(),
      sens: String(r[4] || "R").trim().toUpperCase().startsWith("O") ? "O" : "R",
      effet: String(r[5] || "").trim(), cause: String(r[6] || "").trim(),
      vraisemblance: N(r[7]), impact: N(r[8]),
      maitriseMoyens: N(r[10]), maitriseCompetences: N(r[11]), maitriseMethodes: N(r[12]),
      commentaire: String(r[14] || "").trim(), statut: "actif", createdAt: now(),
    }, req);
    db.smqRisks.push(rec); added++;
  }
  save(); audit(req.user, "CREATED", "SmqRiskImport", "import", { added });
  res.json({ ok: true, added });
});

/* ---- Rappel du responsable SMQ au pilote/co-pilote (mise à jour du tableau de bord) ---- */
router.post("/tdb/:id/remind", allow(...RW), (req, res) => {
  if (!mgrOnly(req, res)) return;
  const t = mine(db.smqTdb, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  const p = mine(db.smqProcesses, req).find(x => x.id === t.processId) || {};
  const targets = [p.piloteUserId, p.coPiloteUserId].filter(Boolean);
  if (!targets.length) return res.status(400).json({ error: "Aucun pilote/co-pilote attribué à ce processus." });
  const text = (req.body && req.body.message) || `Rappel : merci de mettre à jour le tableau de bord « ${t.titre} » (${p.code || ""} · ${t.annee}).`;
  if (!db.dmMessages) db.dmMessages = [];
  let chat = null; try { chat = require("../chat"); } catch (e) {}
  let sent = 0;
  for (const uid of targets) {
    const m = stamp({ id: id("dm"), fromId: req.user.id, fromName: req.user.fullName, toId: uid, text,
      at: now(), readAt: null, attachment: null, link: { type: "view", id: "smqtdb", label: "Tableau de bord " + (p.code || "") }, mentions: [] }, req);
    db.dmMessages.push(m);
    if (chat) try { chat.deliver(uid, { type: "message", message: m }); } catch (e) {}
    sent++;
  }
  save(); audit(req.user, "CREATED", "SmqReminder", t.id, { sent });
  res.json({ ok: true, sent });
});

module.exports = router;
