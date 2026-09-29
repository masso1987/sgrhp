/**
 * Sauvegarde & restauration + stockage de fichiers (Local / SFTP / S3 / Azure).
 * Réservé ADM/SADM. Les secrets des backends sont chiffrés au repos (crypto.js) et masqués
 * en lecture. Les sauvegardes automatiques (schedules) sont déclenchées par le scheduler du serveur.
 */
const router = require("express").Router();
const multer = require("multer");
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const { encryptSecret, isEncrypted } = require("../crypto");
const storage = require("../storage");
const backup = require("../backup");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });
const MASK = "••••••";
const SECRET_FIELDS = ["password", "secretAccessKey", "accountKey", "connectionString", "privateKey"];
const ADMIN = allow("ADM", "SADM");

function ensure() { for (const k of ["storageBackends", "backupSchedules", "backups", "notifications"]) if (!db[k]) db[k] = []; }
function maskBackend(b) { const c = Object.assign({}, b.config || {}); for (const f of SECRET_FIELDS) if (c[f]) c[f] = MASK; return Object.assign({}, b, { config: c }); }
function mergeSecrets(existing, incoming) {
  const out = Object.assign({}, incoming || {});
  for (const f of SECRET_FIELDS) {
    if (out[f] === MASK || out[f] === undefined) { out[f] = (existing && existing.config && existing.config[f]) || ""; }
    else if (out[f]) { out[f] = encryptSecret(out[f]); }
  }
  return out;
}
function notifyAdmins(text, link, ok) {
  ensure();
  const admins = db.users.filter(u => ["ADM", "SADM"].includes(u.role));
  for (const u of admins) db.notifications.push({ id: id("ntf"), userId: u.id, text: (ok ? "✓ " : "⚠ ") + text, link: link || "backuphome", createdAt: new Date().toISOString(), readAt: null, kind: ok ? "backup_ok" : "backup_err" });
}
function backendById(bid) { ensure(); return db.storageBackends.find(b => b.id === bid); }
function defaultBackend() { ensure(); return db.storageBackends.find(b => b.active) || db.storageBackends.find(b => b.type === "local") || null; }

/** Core: run a backup to a backend, record it, notify, prune. Used by manual + scheduler. */
async function runBackup(opts) {
  ensure(); opts = opts || {};
  const backend = opts.backendId ? backendById(opts.backendId) : defaultBackend();
  const rec = { id: id("bkp"), createdAt: new Date().toISOString(), type: opts.type || "manual", backendId: backend ? backend.id : "local-default", backendName: backend ? backend.name : "Disque local (défaut)", encrypted: opts.encrypt !== false, includeFiles: opts.includeFiles !== false, scheduleId: opts.scheduleId || null, by: opts.by || null, status: "running" };
  db.backups.push(rec);
  try {
    const arc = backup.createArchive(db, { encrypt: opts.encrypt !== false, includeFiles: opts.includeFiles !== false });
    const key = `backups/sgrhp_${rec.createdAt.replace(/[:.]/g, "-")}.sgbak`;
    const adapter = backend ? storage.adapterFor(backend) : storage.adapterFor({ type: "local", config: {} });
    await adapter.put(key, arc.buffer);
    Object.assign(rec, { status: "ok", key, size: arc.buffer.length, meta: arc.meta });
    save(); audit(opts.user || { id: "system", role: "SADM" }, "BACKUP_OK", "Backup", rec.id, { backend: rec.backendName, size: rec.size, files: arc.meta.fileCount });
    notifyAdmins(`Sauvegarde réussie (${(rec.size / 1048576).toFixed(1)} Mo) vers ${rec.backendName}.`, "backuphome", true);
    if (opts.schedule) await pruneRetention(backend, opts.schedule);
  } catch (e) {
    Object.assign(rec, { status: "error", error: e.message }); save();
    audit(opts.user || { id: "system", role: "SADM" }, "BACKUP_ERROR", "Backup", rec.id, { error: e.message });
    notifyAdmins(`Échec de la sauvegarde vers ${rec.backendName} : ${e.message}`, "backuphome", false);
  }
  return rec;
}

/** Grandfather-Father-Son / keep-N pruning on a backend for one schedule. */
async function pruneRetention(backend, schedule) {
  try {
    const adapter = backend ? storage.adapterFor(backend) : storage.adapterFor({ type: "local", config: {} });
    const list = (await adapter.list("backups")).filter(f => /\.sgbak$/.test(f.key)).sort((a, b) => b.mtime - a.mtime);
    const ret = schedule.retention || {};
    let keep;
    if (ret.mode === "keepN") keep = new Set(list.slice(0, Math.max(1, ret.keep || 14)).map(f => f.key));
    else {
      keep = new Set();
      const byBucket = (fmt) => { const seen = new Set(); const out = []; for (const f of list) { const d = new Date(f.mtime); const b = fmt(d); if (!seen.has(b)) { seen.add(b); out.push(f); } } return out; };
      byBucket(d => d.toISOString().slice(0, 10)).slice(0, ret.daily || 7).forEach(f => keep.add(f.key));
      byBucket(d => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x.toISOString().slice(0, 10); }).slice(0, ret.weekly || 4).forEach(f => keep.add(f.key));
      byBucket(d => d.toISOString().slice(0, 7)).slice(0, ret.monthly || 12).forEach(f => keep.add(f.key));
    }
    for (const f of list) if (!keep.has(f.key)) { await adapter.remove(f.key); const r = db.backups.find(x => x.key === f.key); if (r) r.pruned = true; }
    save();
  } catch (e) { /* pruning best-effort */ }
}

/** Scheduler tick: run any schedule that is due. Called periodically by the server. */
async function runDueSchedules() {
  ensure(); const now = new Date();
  for (const s of db.backupSchedules) {
    if (!s.active) continue;
    if (isDue(s, now)) { s.lastRun = now.toISOString(); save(); await runBackup({ type: "auto", backendId: s.backendId, encrypt: s.encrypt !== false, includeFiles: s.includeFiles !== false, scheduleId: s.id, schedule: s }); }
  }
}
function isDue(s, now) {
  const hour = Number(s.hour != null ? s.hour : 2);
  if (now.getHours() !== hour) return false;
  const last = s.lastRun ? new Date(s.lastRun) : null;
  const sameHour = last && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate() && last.getHours() === now.getHours();
  if (sameHour) return false;
  if (s.cadence === "daily") return true;
  if (s.cadence === "weekly") return now.getDay() === (Number(s.weekday) || 1);
  if (s.cadence === "monthly") return now.getDate() === (Number(s.dayOfMonth) || 1);
  return false;
}

/* ------------------------------ Storage backends ------------------------------ */
router.get("/storage-backends", ADMIN, (req, res) => { ensure(); res.json(db.storageBackends.map(maskBackend)); });
router.post("/storage-backends", ADMIN, (req, res) => {
  ensure(); const b = req.body || {};
  if (!storage.TYPES.includes(b.type)) return res.status(400).json({ error: "Type de stockage invalide" });
  const rec = { id: id("stg"), type: b.type, name: b.name || b.type, active: !!b.active, config: mergeSecrets(null, b.config || {}), createdAt: new Date().toISOString() };
  if (rec.active) db.storageBackends.forEach(x => x.active = false);
  db.storageBackends.push(rec); save(); audit(req.user, "CREATED", "StorageBackend", rec.id, { type: rec.type });
  res.status(201).json(maskBackend(rec));
});
router.put("/storage-backends/:id", ADMIN, (req, res) => {
  const rec = backendById(req.params.id); if (!rec) return res.status(404).json({ error: "Backend introuvable" });
  const b = req.body || {};
  if (b.name !== undefined) rec.name = b.name;
  if (b.config) rec.config = mergeSecrets(rec, b.config);
  if (b.active) { db.storageBackends.forEach(x => x.active = false); rec.active = true; } else if (b.active === false) rec.active = false;
  save(); audit(req.user, "UPDATED", "StorageBackend", rec.id, {}); res.json(maskBackend(rec));
});
router.delete("/storage-backends/:id", ADMIN, (req, res) => {
  const rec = backendById(req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  db.storageBackends.splice(db.storageBackends.indexOf(rec), 1); save(); audit(req.user, "DELETED", "StorageBackend", rec.id, {}); res.json({ ok: true });
});
router.post("/storage-backends/:id/test", ADMIN, async (req, res) => {
  const rec = backendById(req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  try { const r = await storage.adapterFor(rec).test(); res.json(r); }
  catch (e) { res.status(400).json({ ok: false, error: e.message, code: e.code || null }); }
});
router.post("/storage-backends/test", ADMIN, async (req, res) => {
  const b = req.body || {};
  try { const r = await storage.adapterFor({ type: b.type, config: mergeSecrets(null, b.config || {}) }).test(); res.json(r); }
  catch (e) { res.status(400).json({ ok: false, error: e.message, code: e.code || null }); }
});

/* ------------------------------ Schedules ------------------------------ */
router.get("/schedules", ADMIN, (req, res) => { ensure(); res.json(db.backupSchedules); });
router.post("/schedules", ADMIN, (req, res) => {
  ensure(); const b = req.body || {};
  const rec = { id: id("bsch"), name: b.name || "Sauvegarde", cadence: b.cadence || "daily", hour: b.hour != null ? Number(b.hour) : 2, weekday: Number(b.weekday) || 1, dayOfMonth: Number(b.dayOfMonth) || 1, backendId: b.backendId || null, encrypt: b.encrypt !== false, includeFiles: b.includeFiles !== false, retention: b.retention || { mode: "gfs", daily: 7, weekly: 4, monthly: 12 }, active: b.active !== false, lastRun: null, createdAt: new Date().toISOString() };
  db.backupSchedules.push(rec); save(); audit(req.user, "CREATED", "BackupSchedule", rec.id, { cadence: rec.cadence }); res.status(201).json(rec);
});
router.put("/schedules/:id", ADMIN, (req, res) => {
  ensure(); const rec = db.backupSchedules.find(s => s.id === req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  for (const f of ["name", "cadence", "backendId", "retention"]) if (b[f] !== undefined) rec[f] = b[f];
  for (const f of ["hour", "weekday", "dayOfMonth"]) if (b[f] !== undefined) rec[f] = Number(b[f]);
  for (const f of ["encrypt", "includeFiles", "active"]) if (b[f] !== undefined) rec[f] = !!b[f];
  save(); audit(req.user, "UPDATED", "BackupSchedule", rec.id, {}); res.json(rec);
});
router.delete("/schedules/:id", ADMIN, (req, res) => {
  ensure(); const i = db.backupSchedules.findIndex(s => s.id === req.params.id); if (i < 0) return res.status(404).json({ error: "Introuvable" });
  const r = db.backupSchedules.splice(i, 1)[0]; save(); audit(req.user, "DELETED", "BackupSchedule", r.id, {}); res.json({ ok: true });
});

/* ------------------------------ Backups (run / list / download / restore) ------------------------------ */
router.get("/backups", ADMIN, (req, res) => { ensure(); res.json(db.backups.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 200)); });
router.post("/run", ADMIN, async (req, res) => {
  const b = req.body || {};
  const rec = await runBackup({ type: "manual", backendId: b.backendId, encrypt: b.encrypt !== false, includeFiles: b.includeFiles !== false, by: req.user.fullName || req.user.id, user: req.user });
  if (rec.status === "error") return res.status(500).json(rec);
  res.status(201).json(rec);
});
router.get("/backups/:id/download", ADMIN, async (req, res) => {
  ensure(); const rec = db.backups.find(x => x.id === req.params.id); if (!rec || rec.status !== "ok") return res.status(404).json({ error: "Sauvegarde introuvable" });
  try { const adapter = storage.adapterFor(backendById(rec.backendId) || { type: "local", config: {} });
    const buf = await adapter.get(rec.key);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${rec.key.split("/").pop()}"`);
    res.end(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/backups/:id", ADMIN, async (req, res) => {
  ensure(); const rec = db.backups.find(x => x.id === req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  try { if (rec.key) await storage.adapterFor(backendById(rec.backendId) || { type: "local", config: {} }).remove(rec.key); } catch (e) {}
  db.backups.splice(db.backups.indexOf(rec), 1); save(); audit(req.user, "DELETED", "Backup", rec.id, {}); res.json({ ok: true });
});
router.post("/restore/:id", ADMIN, async (req, res) => {
  ensure(); if (req.user.role !== "SADM" && req.user.role !== "ADM") return res.status(403).json({ error: "Réservé aux administrateurs" });
  if ((req.body && req.body.confirm) !== "RESTAURER") return res.status(400).json({ error: "Confirmation requise : tapez RESTAURER." });
  const rec = db.backups.find(x => x.id === req.params.id); if (!rec || rec.status !== "ok") return res.status(404).json({ error: "Sauvegarde introuvable" });
  try {
    const buf = await storage.adapterFor(backendById(rec.backendId) || { type: "local", config: {} }).get(rec.key);
    const r = backup.restoreArchive(db, buf, save);
    // keep the pre-restore safety snapshot as a downloadable local backup record
    const skey = `backups/pre-restore_${new Date().toISOString().replace(/[:.]/g, "-")}.sgbak`;
    await storage.adapterFor({ type: "local", config: {} }).put(skey, r.safety);
    db.backups.push({ id: id("bkp"), createdAt: new Date().toISOString(), type: "pre-restore", backendId: "local-default", backendName: "Disque local (défaut)", encrypted: false, key: skey, size: r.safety.length, status: "ok", note: "Instantané de sécurité avant restauration" });
    save(); audit(req.user, "RESTORED", "Backup", rec.id, { from: rec.key }); notifyAdmins(`Restauration effectuée depuis ${rec.backendName}. Instantané de sécurité créé.`, "backuphome", true);
    res.json({ ok: true, restored: r.restoredMeta });
  } catch (e) { res.status(500).json({ error: "Échec de la restauration : " + e.message }); }
});
router.post("/restore-upload", ADMIN, upload.single("file"), async (req, res) => {
  if ((req.body && req.body.confirm) !== "RESTAURER") return res.status(400).json({ error: "Confirmation requise : tapez RESTAURER." });
  if (!req.file) return res.status(400).json({ error: "Fichier de sauvegarde requis (.sgbak)" });
  try {
    const r = backup.restoreArchive(db, req.file.buffer, save);
    const skey = `backups/pre-restore_${new Date().toISOString().replace(/[:.]/g, "-")}.sgbak`;
    await storage.adapterFor({ type: "local", config: {} }).put(skey, r.safety);
    ensure(); db.backups.push({ id: id("bkp"), createdAt: new Date().toISOString(), type: "pre-restore", backendId: "local-default", backendName: "Disque local (défaut)", encrypted: false, key: skey, size: r.safety.length, status: "ok", note: "Instantané de sécurité avant restauration (import)" });
    save(); audit(req.user, "RESTORED", "Backup", "upload", { file: req.file.originalname }); notifyAdmins("Restauration effectuée depuis un fichier importé.", "backuphome", true);
    res.json({ ok: true, restored: r.restoredMeta });
  } catch (e) { res.status(500).json({ error: "Fichier invalide ou clé de déchiffrement incorrecte : " + e.message }); }
});

module.exports = router;
module.exports.runBackup = runBackup;
module.exports.runDueSchedules = runDueSchedules;
