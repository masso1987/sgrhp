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

const COLS = ["smqAxes", "smqProcesses", "smqIndicators", "smqMeasures", "smqDocTypes",
  "smqDocuments", "smqDocRevisions", "smqStakeholders", "smqScope", "smqClauses", "smqPolicy", "smqImprovements"];
for (const k of COLS) if (!db[k]) db[k] = [];

const now = () => new Date().toISOString();
const RW = ["ADM", "CD", "RJ"];            // qualité : ADM/CD/RJ écrivent (RJ = responsable qualité de facto)
const RO = ["ADM", "CD", "RJ", "GPF", "UI"];
const uName = (uid) => { const u = (db.users || []).find(x => x.id === uid); return u ? u.fullName : ""; };

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
  ["processId", "libelle", "modeCalcul", "cible", "seuil", "unite", "frequence", "sens", "source", "binding", "axeCode"],
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
const PROC_FIELDS = ["code", "type", "intitule", "piloteId", "piloteName", "coPiloteName", "finalite",
  "objectifs", "missionsPrincipales", "missionsQuotidiennes", "competencesRequises", "entrees", "sorties",
  "logigrammeFileId", "statut", "ordre"];
router.post("/processes", allow(...RW), (req, res) => {
  const b = req.body || {}; if (!b.code || !b.intitule) return res.status(400).json({ error: "Code et intitulé obligatoires" });
  const rec = { id: id("smq"), objectifs: [], statut: "active", createdAt: now() };
  for (const f of PROC_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqProcesses.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqProcess", rec.id, { code: rec.code });
  res.status(201).json(rec);
});
router.put("/processes/:id", allow(...RW), (req, res) => {
  const x = mine(db.smqProcesses, req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
  for (const f of PROC_FIELDS) if (req.body[f] !== undefined) x[f] = req.body[f];
  x.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqProcess", x.id, {}); res.json(x);
});
router.delete("/processes/:id", allow("ADM", "CD"), (req, res) => {
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
  const rows = mine(db.smqDocuments, req).map(d => {
    const cur = revs.find(r => r.id === d.currentRevisionId);
    return Object.assign({}, d, { current: cur || null, nbVersions: revs.filter(r => r.documentId === d.id).length });
  }).sort((a, b) => String(a.ref || "").localeCompare(String(b.ref || ""), "fr", { numeric: true }));
  res.json(rows);
});
router.get("/documents/:id", allow(...RO), (req, res) => {
  const d = mine(db.smqDocuments, req).find(r => r.id === req.params.id); if (!d) return res.status(404).json({ error: "Introuvable" });
  const revs = mine(db.smqDocRevisions, req).filter(r => r.documentId === d.id)
    .sort((a, b) => String(b.version).localeCompare(String(a.version), "fr", { numeric: true }));
  res.json({ document: d, revisions: revs });
});

// Créer un document = créer sa 1re version (brouillon).
router.post("/documents", allow(...RW), (req, res) => {
  const b = req.body || {};
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
    resumeModif: b.resumeModif || "Création", contenu: b.contenu || "", fileId: b.fileId || null,
    frequenceRevueMonths: freq, diffusion: b.diffusion || [], createdAt: now(),
  }, req);
  const docRec = stamp({
    id: docId, ref, titre: b.titre, typeCode: b.typeCode, processId: b.processId || null,
    seq, statutCourant: "brouillon", versionCourante: version, currentRevisionId: revId,
    frequenceRevueMonths: freq, createdAt: now(),
  }, req);
  db.smqDocuments.push(docRec); db.smqDocRevisions.push(revRec); save();
  audit(req.user, "CREATED", "SmqDocument", docId, { ref, titre: b.titre });
  res.status(201).json({ document: docRec, revision: revRec });
});

// Éditer une révision en brouillon.
router.put("/revisions/:id", allow(...RW), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  if (r.statut !== "brouillon") return res.status(400).json({ error: "Seule une version en brouillon est modifiable." });
  const b = req.body || {};
  for (const f of ["redacteurName", "verificateurName", "approbateurName", "resumeModif", "contenu", "fileId", "frequenceRevueMonths", "diffusion"])
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
  if (r.statut !== "brouillon") return res.status(400).json({ error: "Transition invalide" });
  setDocStatus(req, r, "verifie"); save(); audit(req.user, "STATUS", "SmqDocument", r.documentId, { version: r.version, statut: "verifie" }); res.json(r);
});
router.post("/revisions/:id/approve", allow(...RW), (req, res) => {
  const r = mine(db.smqDocRevisions, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
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
  setDocStatus(req, r, "obsolete"); save(); audit(req.user, "STATUS", "SmqDocument", r.documentId, { version: r.version, statut: "obsolete" }); res.json(r);
});

// Nouvelle version (révision) d'un document existant.
router.post("/documents/:id/revise", allow(...RW), (req, res) => {
  const d = mine(db.smqDocuments, req).find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: "Introuvable" });
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
    fileId: b.fileId || null, frequenceRevueMonths: Number(b.frequenceRevueMonths) || d.frequenceRevueMonths || 24,
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

module.exports = router;
