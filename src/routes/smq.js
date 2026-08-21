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
  "smqDocuments", "smqDocRevisions", "smqStakeholders", "smqScope", "smqClauses", "smqPolicy", "smqImprovements", "smqEvents", "smqConfig", "smqAudits", "smqAuditItems", "smqRisks"];
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
      evenements: mine(db.smqEvents, req).length,
      evenementsNonRevus: mine(db.smqEvents, req).filter(x => !x.reviewed).length,
      audits: mine(db.smqAudits, req).length,
      auditsPlanifies: mine(db.smqAudits, req).filter(x => x.statut === "planifie").length,
      risques: mine(db.smqRisks, req).filter(x => (x.sens || "R") === "R").length,
      risquesEleves: mine(db.smqRisks, req).filter(x => { const c=(Number(x.vraisemblance)||0)*(Number(x.impact)||0); return (x.sens||"R")==="R" && c>=8; }).length,
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
  let rows = mine(db.smqRisks, req).map(riskCompute);
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
  const rec = { id: id("smq"), ref: b.ref || riskRef(req), sens: b.sens || "R", statut: b.statut || "actif", createdAt: now() };
  for (const f of RISK_FIELDS) if (b[f] !== undefined) rec[f] = b[f];
  db.smqRisks.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "SmqRisk", rec.id, { ref: rec.ref });
  res.status(201).json(riskCompute(rec));
});
router.put("/risks/:id", allow(...RW), (req, res) => {
  const r = mine(db.smqRisks, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
  for (const f of RISK_FIELDS) if (req.body[f] !== undefined) r[f] = req.body[f];
  r.updatedAt = now(); save(); audit(req.user, "UPDATED", "SmqRisk", r.id, {}); res.json(riskCompute(r));
});
router.delete("/risks/:id", allow("ADM", "CD"), (req, res) => {
  const r = mine(db.smqRisks, req).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: "Introuvable" });
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

module.exports = router;
