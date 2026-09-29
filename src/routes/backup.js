/**
 * Sauvegarde & restauration + stockage, multi-tenant.
 *  - ADM : agit uniquement sur SON tenant (destinations, plannings, sync, sauvegardes).
 *  - SADM : choisit le tenant (?tenantId=...) ou le périmètre "_platform" (toute la plateforme).
 * Chaque enregistrement (backend, planning, sync, sauvegarde) porte un tenantId. Une sauvegarde
 * de tenant ne contient que ses données ; sa restauration ne touche que ce tenant.
 */
const router = require("express").Router();
const multer = require("multer");
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const { encryptSecret } = require("../crypto");
const storage = require("../storage");
const backup = require("../backup");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });
const MASK = "••••••";
const SECRET_FIELDS = ["password", "secretAccessKey", "accountKey", "connectionString", "privateKey"];
const ADMIN = allow("ADM", "SADM");
const PLATFORM = "_platform";

function ensure() { for (const k of ["storageBackends", "backupSchedules", "backups", "notifications", "fileSyncState", "syncSettings"]) if (!db[k]) db[k] = []; }
/** Scope for the request: ADM -> own tenant; SADM -> ?tenantId or "_platform". */
function scopeTid(req) {
  if (req.user.role === "SADM") { const t = (req.query && req.query.tenantId) || (req.body && req.body.tenantId); return t || PLATFORM; }
  return req.user.tenantId || "t1";
}
const isPlat = (tid) => tid === PLATFORM;
const inScope = (arr, tid) => (arr || []).filter(x => (x.tenantId || "t1") === tid);

function maskBackend(b) { const c = Object.assign({}, b.config || {}); for (const f of SECRET_FIELDS) if (c[f]) c[f] = MASK; return Object.assign({}, b, { config: c }); }
function mergeSecrets(existing, incoming) {
  const out = Object.assign({}, incoming || {});
  for (const f of SECRET_FIELDS) {
    if (out[f] === MASK || out[f] === undefined) out[f] = (existing && existing.config && existing.config[f]) || "";
    else if (out[f]) out[f] = encryptSecret(out[f]);
  }
  return out;
}
function notifyScope(tid, text, link, ok) {
  ensure();
  const targets = db.users.filter(u => u.role === "SADM" || (u.role === "ADM" && !isPlat(tid) && (u.tenantId || "t1") === tid));
  for (const u of targets) db.notifications.push({ id: id("ntf"), userId: u.id, text: (ok ? "✓ " : "⚠ ") + text, link: "backuphome", createdAt: new Date().toISOString(), readAt: null, kind: ok ? "backup_ok" : "backup_err" });
}
function backendById(tid, bid) { ensure(); return inScope(db.storageBackends, tid).find(b => b.id === bid); }
function defaultBackend(tid) { ensure(); const s = inScope(db.storageBackends, tid); return s.find(b => b.active) || s.find(b => b.type === "local") || null; }

/* Core backup: full-platform (tid=_platform) or per-tenant. */
async function runBackup(opts) {
  ensure(); opts = opts || {}; const tid = opts.tid || PLATFORM;
  const backend = opts.backendId ? backendById(tid, opts.backendId) : defaultBackend(tid);
  const rec = { id: id("bkp"), tenantId: tid, createdAt: new Date().toISOString(), type: opts.type || "manual", scope: isPlat(tid) ? "platform" : "tenant", backendId: backend ? backend.id : "local-default", backendName: backend ? backend.name : "Disque local (défaut)", encrypted: opts.encrypt !== false, includeFiles: opts.includeFiles !== false, scheduleId: opts.scheduleId || null, by: opts.by || null, status: "running" };
  db.backups.push(rec);
  try {
    const arc = backup.createArchive(db, { encrypt: opts.encrypt !== false, includeFiles: opts.includeFiles !== false, tenantId: isPlat(tid) ? null : tid });
    const key = `backups/${isPlat(tid) ? "platform" : tid}/sgrhp_${rec.createdAt.replace(/[:.]/g, "-")}.sgbak`;
    const adapter = backend ? storage.adapterFor(backend) : storage.adapterFor({ type: "local", config: {} });
    await adapter.put(key, arc.buffer);
    Object.assign(rec, { status: "ok", key, size: arc.buffer.length, meta: arc.meta });
    save(); audit(opts.user || { id: "system", role: "SADM" }, "BACKUP_OK", "Backup", rec.id, { scope: rec.scope, tenant: tid, backend: rec.backendName, size: rec.size });
    notifyScope(tid, `Sauvegarde ${rec.scope === "platform" ? "plateforme" : "du tenant"} réussie (${(rec.size / 1048576).toFixed(1)} Mo) vers ${rec.backendName}.`, "backuphome", true);
    if (opts.schedule) await pruneRetention(tid, backend, opts.schedule);
  } catch (e) {
    Object.assign(rec, { status: "error", error: e.message }); save();
    audit(opts.user || { id: "system", role: "SADM" }, "BACKUP_ERROR", "Backup", rec.id, { error: e.message });
    notifyScope(tid, `Échec de la sauvegarde vers ${rec.backendName} : ${e.message}`, "backuphome", false);
  }
  return rec;
}
async function pruneRetention(tid, backend, schedule) {
  try {
    const adapter = backend ? storage.adapterFor(backend) : storage.adapterFor({ type: "local", config: {} });
    const prefix = `backups/${isPlat(tid) ? "platform" : tid}`;
    const list = (await adapter.list(prefix)).filter(f => /\.sgbak$/.test(f.key)).sort((a, b) => b.mtime - a.mtime);
    const ret = schedule.retention || {}; let keep;
    if (ret.mode === "keepN") keep = new Set(list.slice(0, Math.max(1, ret.keep || 14)).map(f => f.key));
    else { keep = new Set();
      const byBucket = (fmt) => { const seen = new Set(), out = []; for (const f of list) { const bkt = fmt(new Date(f.mtime)); if (!seen.has(bkt)) { seen.add(bkt); out.push(f); } } return out; };
      byBucket(d => d.toISOString().slice(0, 10)).slice(0, ret.daily || 7).forEach(f => keep.add(f.key));
      byBucket(d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); }).slice(0, ret.weekly || 4).forEach(f => keep.add(f.key));
      byBucket(d => d.toISOString().slice(0, 7)).slice(0, ret.monthly || 12).forEach(f => keep.add(f.key));
    }
    for (const f of list) if (!keep.has(f.key)) { await adapter.remove(f.key); const r = db.backups.find(x => x.key === f.key); if (r) r.pruned = true; }
    save();
  } catch (e) {}
}
async function runDueSchedules() {
  ensure(); const now = new Date();
  for (const s of db.backupSchedules) { if (!s.active) continue; if (isDue(s, now)) { s.lastRun = now.toISOString(); save(); await runBackup({ type: "auto", tid: s.tenantId || PLATFORM, backendId: s.backendId, encrypt: s.encrypt !== false, includeFiles: s.includeFiles !== false, scheduleId: s.id, schedule: s }); } }
  try { await runDueSync(); } catch (e) {}
}
function isDue(s, now) {
  if (now.getHours() !== Number(s.hour != null ? s.hour : 2)) return false;
  const last = s.lastRun ? new Date(s.lastRun) : null;
  if (last && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate() && last.getHours() === now.getHours()) return false;
  if (s.cadence === "daily") return true;
  if (s.cadence === "weekly") return now.getDay() === (Number(s.weekday) || 1);
  if (s.cadence === "monthly") return now.getDate() === (Number(s.dayOfMonth) || 1);
  return false;
}

/* ---------------- File sync (per tenant) ---------------- */
function syncCfg(tid) { ensure(); let c = db.syncSettings.find(x => (x.tenantId || "t1") === tid); if (!c) { c = { id: id("sync"), tenantId: tid, mode: "off", backendId: null, intervalMin: 60, lastRun: null }; db.syncSettings.push(c); } return c; }
function syncStatus(tid) {
  ensure(); const files = isPlat(tid) ? backup.scanUploads() : (backup.tenantFileRels(db, tid).map(rel => { try { const st = require("fs").statSync(require("path").join(backup.UPLOADS, rel)); return { path: rel, size: st.size, mtime: Math.round(st.mtimeMs) }; } catch (e) { return null; } }).filter(Boolean));
  const map = {}; for (const r of inScope(db.fileSyncState, tid)) map[r.path] = r;
  let synced = 0, pending = 0, failed = 0;
  for (const f of files) { const st = map[f.path]; if (st && st.status === "synced" && st.size === f.size && st.mtime === f.mtime) synced++; else if (st && st.status === "failed") failed++; else pending++; }
  const cfg = syncCfg(tid);
  return { total: files.length, synced, pending, failed, mode: cfg.mode, backendId: cfg.backendId, intervalMin: cfg.intervalMin, lastRun: cfg.lastRun, backendName: (backendById(tid, cfg.backendId) || defaultBackend(tid) || {}).name || "défaut" };
}
async function runSync(tid, opts) {
  ensure(); opts = opts || {}; const cfg = syncCfg(tid);
  const backend = (opts.backendId && backendById(tid, opts.backendId)) || backendById(tid, cfg.backendId) || defaultBackend(tid);
  if (!backend) { const e = new Error("Aucune destination de stockage configurée pour ce périmètre."); e.status = 400; throw e; }
  const adapter = storage.adapterFor(backend);
  const files = isPlat(tid) ? backup.scanUploads() : backup.tenantFileRels(db, tid).map(rel => { const st = require("fs").statSync(require("path").join(backup.UPLOADS, rel)); return { path: rel, size: st.size, mtime: Math.round(st.mtimeMs) }; });
  const map = {}; for (const r of inScope(db.fileSyncState, tid)) map[r.path] = r;
  let synced = 0, failed = 0, skipped = 0;
  for (const f of files) {
    const st = map[f.path];
    if (st && st.status === "synced" && st.size === f.size && st.mtime === f.mtime && st.backendId === backend.id) { skipped++; continue; }
    let rec = st; if (!rec) { rec = { id: id("fsx"), tenantId: tid, path: f.path }; db.fileSyncState.push(rec); }
    try { await adapter.put(`files/${isPlat(tid) ? "" : tid + "/"}${f.path}`, backup.readUpload(f.path)); Object.assign(rec, { size: f.size, mtime: f.mtime, status: "synced", backendId: backend.id, syncedAt: new Date().toISOString(), error: null }); synced++; }
    catch (e) { Object.assign(rec, { size: f.size, mtime: f.mtime, status: "failed", backendId: backend.id, error: e.message }); failed++; }
  }
  cfg.lastRun = new Date().toISOString(); save();
  audit(opts.user || { id: "system", role: "SADM" }, "FILESYNC", "FileSync", tid, { synced, failed, skipped });
  if (failed) notifyScope(tid, `Synchronisation : ${synced} envoyé(s), ${failed} échec(s) vers ${backend.name}.`, "backuphome", false);
  return { synced, failed, skipped, total: files.length, backendName: backend.name };
}
async function runDueSync() { ensure(); for (const cfg of db.syncSettings) { if (cfg.mode !== "auto") continue; const iv = Math.max(5, Number(cfg.intervalMin) || 60); if (Date.now() - (cfg.lastRun ? new Date(cfg.lastRun).getTime() : 0) < iv * 60000) continue; try { await runSync(cfg.tenantId || "t1", {}); } catch (e) {} } }

/* ---------------- Tenants list (for SADM selector) ---------------- */
router.get("/scopes", ADMIN, (req, res) => {
  if (req.user.role !== "SADM") return res.json({ platform: false, tenants: [{ id: req.user.tenantId || "t1", name: "Mon entreprise" }] });
  const tenants = (db.tenants || []).map(t => ({ id: t.id, name: t.name || t.id }));
  res.json({ platform: true, tenants });
});

/* ---------------- Storage backends ---------------- */
router.get("/storage-backends", ADMIN, (req, res) => { res.json(inScope(db.storageBackends, scopeTid(req)).map(maskBackend)); });
router.post("/storage-backends", ADMIN, (req, res) => {
  const tid = scopeTid(req); const b = req.body || {};
  if (!storage.TYPES.includes(b.type)) return res.status(400).json({ error: "Type de stockage invalide" });
  const rec = { id: id("stg"), tenantId: tid, type: b.type, name: b.name || b.type, active: !!b.active, config: mergeSecrets(null, b.config || {}), createdAt: new Date().toISOString() };
  if (rec.active) inScope(db.storageBackends, tid).forEach(x => x.active = false);
  db.storageBackends.push(rec); save(); audit(req.user, "CREATED", "StorageBackend", rec.id, { type: rec.type, tenant: tid });
  res.status(201).json(maskBackend(rec));
});
router.put("/storage-backends/:id", ADMIN, (req, res) => {
  const tid = scopeTid(req); const rec = backendById(tid, req.params.id); if (!rec) return res.status(404).json({ error: "Backend introuvable" });
  const b = req.body || {};
  if (b.name !== undefined) rec.name = b.name;
  if (b.config) rec.config = mergeSecrets(rec, b.config);
  if (b.active) { inScope(db.storageBackends, tid).forEach(x => x.active = false); rec.active = true; } else if (b.active === false) rec.active = false;
  save(); audit(req.user, "UPDATED", "StorageBackend", rec.id, {}); res.json(maskBackend(rec));
});
router.delete("/storage-backends/:id", ADMIN, (req, res) => {
  const rec = backendById(scopeTid(req), req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  db.storageBackends.splice(db.storageBackends.indexOf(rec), 1); save(); audit(req.user, "DELETED", "StorageBackend", rec.id, {}); res.json({ ok: true });
});
router.post("/storage-backends/:id/test", ADMIN, async (req, res) => {
  const rec = backendById(scopeTid(req), req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  try { res.json(await storage.adapterFor(rec).test()); } catch (e) { res.status(400).json({ ok: false, error: e.message, code: e.code || null }); }
});
router.post("/storage-backends/test", ADMIN, async (req, res) => {
  const b = req.body || {};
  try { res.json(await storage.adapterFor({ type: b.type, config: mergeSecrets(null, b.config || {}) }).test()); } catch (e) { res.status(400).json({ ok: false, error: e.message, code: e.code || null }); }
});

/* ---------------- Schedules ---------------- */
router.get("/schedules", ADMIN, (req, res) => { res.json(inScope(db.backupSchedules, scopeTid(req))); });
router.post("/schedules", ADMIN, (req, res) => {
  const tid = scopeTid(req); const b = req.body || {};
  const rec = { id: id("bsch"), tenantId: tid, name: b.name || "Sauvegarde", cadence: b.cadence || "daily", hour: b.hour != null ? Number(b.hour) : 2, weekday: Number(b.weekday) || 1, dayOfMonth: Number(b.dayOfMonth) || 1, backendId: b.backendId || null, encrypt: b.encrypt !== false, includeFiles: b.includeFiles !== false, retention: b.retention || { mode: "gfs", daily: 7, weekly: 4, monthly: 12 }, active: b.active !== false, lastRun: null, createdAt: new Date().toISOString() };
  db.backupSchedules.push(rec); save(); audit(req.user, "CREATED", "BackupSchedule", rec.id, { cadence: rec.cadence, tenant: tid }); res.status(201).json(rec);
});
router.put("/schedules/:id", ADMIN, (req, res) => {
  const rec = inScope(db.backupSchedules, scopeTid(req)).find(s => s.id === req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  for (const f of ["name", "cadence", "backendId", "retention"]) if (b[f] !== undefined) rec[f] = b[f];
  for (const f of ["hour", "weekday", "dayOfMonth"]) if (b[f] !== undefined) rec[f] = Number(b[f]);
  for (const f of ["encrypt", "includeFiles", "active"]) if (b[f] !== undefined) rec[f] = !!b[f];
  save(); audit(req.user, "UPDATED", "BackupSchedule", rec.id, {}); res.json(rec);
});
router.delete("/schedules/:id", ADMIN, (req, res) => {
  const rec = inScope(db.backupSchedules, scopeTid(req)).find(s => s.id === req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  db.backupSchedules.splice(db.backupSchedules.indexOf(rec), 1); save(); audit(req.user, "DELETED", "BackupSchedule", rec.id, {}); res.json({ ok: true });
});

/* ---------------- Backups (run / list / download / restore) ---------------- */
router.get("/backups", ADMIN, (req, res) => { res.json(inScope(db.backups, scopeTid(req)).slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 200)); });
router.post("/run", ADMIN, async (req, res) => {
  const tid = scopeTid(req); const b = req.body || {};
  const rec = await runBackup({ type: "manual", tid, backendId: b.backendId, encrypt: b.encrypt !== false, includeFiles: b.includeFiles !== false, by: req.user.fullName || req.user.id, user: req.user });
  if (rec.status === "error") return res.status(500).json(rec);
  res.status(201).json(rec);
});
router.get("/backups/:id/download", ADMIN, async (req, res) => {
  const rec = inScope(db.backups, scopeTid(req)).find(x => x.id === req.params.id); if (!rec || rec.status !== "ok") return res.status(404).json({ error: "Sauvegarde introuvable" });
  try { const buf = await storage.adapterFor(backendById(rec.tenantId, rec.backendId) || { type: "local", config: {} }).get(rec.key);
    res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("Content-Disposition", `attachment; filename="${rec.key.split("/").pop()}"`); res.end(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/backups/:id", ADMIN, async (req, res) => {
  const rec = inScope(db.backups, scopeTid(req)).find(x => x.id === req.params.id); if (!rec) return res.status(404).json({ error: "Introuvable" });
  try { if (rec.key) await storage.adapterFor(backendById(rec.tenantId, rec.backendId) || { type: "local", config: {} }).remove(rec.key); } catch (e) {}
  db.backups.splice(db.backups.indexOf(rec), 1); save(); audit(req.user, "DELETED", "Backup", rec.id, {}); res.json({ ok: true });
});
async function doRestore(req, res, rec) {
  const tid = rec.tenantId;
  try {
    const buf = await storage.adapterFor(backendById(tid, rec.backendId) || { type: "local", config: {} }).get(rec.key);
    const r = backup.restoreArchive(db, buf, save);
    const skey = `backups/${isPlat(tid) ? "platform" : tid}/pre-restore_${new Date().toISOString().replace(/[:.]/g, "-")}.sgbak`;
    await storage.adapterFor({ type: "local", config: {} }).put(skey, r.safety);
    db.backups.push({ id: id("bkp"), tenantId: tid, createdAt: new Date().toISOString(), type: "pre-restore", scope: isPlat(tid) ? "platform" : "tenant", backendId: "local-default", backendName: "Disque local (défaut)", encrypted: false, key: skey, size: r.safety.length, status: "ok", note: "Instantané de sécurité avant restauration" });
    save(); audit(req.user, "RESTORED", "Backup", rec.id, { scope: rec.scope, tenant: tid, from: rec.key });
    notifyScope(tid, `Restauration ${rec.scope === "platform" ? "plateforme" : "du tenant"} effectuée. Instantané de sécurité créé.`, "backuphome", true);
    res.json({ ok: true, restored: r.restoredMeta });
  } catch (e) { res.status(500).json({ error: "Échec de la restauration : " + e.message }); }
}
router.post("/restore/:id", ADMIN, async (req, res) => {
  if ((req.body && req.body.confirm) !== "RESTAURER") return res.status(400).json({ error: "Confirmation requise : tapez RESTAURER." });
  const rec = inScope(db.backups, scopeTid(req)).find(x => x.id === req.params.id); if (!rec || rec.status !== "ok") return res.status(404).json({ error: "Sauvegarde introuvable" });
  await doRestore(req, res, rec);
});
router.post("/restore-upload", ADMIN, upload.single("file"), async (req, res) => {
  if ((req.body && req.body.confirm) !== "RESTAURER") return res.status(400).json({ error: "Confirmation requise : tapez RESTAURER." });
  if (!req.file) return res.status(400).json({ error: "Fichier de sauvegarde requis (.sgbak)" });
  try {
    const payloadMeta = (() => { try { return backup.parseArchive(req.file.buffer).meta; } catch (e) { return null; } })();
    if (!payloadMeta) return res.status(400).json({ error: "Fichier invalide ou clé de déchiffrement incorrecte." });
    // ADM may only restore their own tenant's archive
    if (req.user.role !== "SADM") { if (payloadMeta.scope === "platform" || (payloadMeta.tenantId && payloadMeta.tenantId !== (req.user.tenantId || "t1"))) return res.status(403).json({ error: "Ce fichier ne correspond pas à votre entreprise." }); }
    const r = backup.restoreArchive(db, req.file.buffer, save);
    const tid = payloadMeta.tenantId || PLATFORM;
    const skey = `backups/${isPlat(tid) ? "platform" : tid}/pre-restore_${new Date().toISOString().replace(/[:.]/g, "-")}.sgbak`;
    await storage.adapterFor({ type: "local", config: {} }).put(skey, r.safety);
    ensure(); db.backups.push({ id: id("bkp"), tenantId: tid, createdAt: new Date().toISOString(), type: "pre-restore", scope: payloadMeta.scope, backendId: "local-default", backendName: "Disque local (défaut)", encrypted: false, key: skey, size: r.safety.length, status: "ok", note: "Instantané de sécurité avant restauration (import)" });
    save(); audit(req.user, "RESTORED", "Backup", "upload", { file: req.file.originalname, scope: payloadMeta.scope });
    res.json({ ok: true, restored: r.restoredMeta });
  } catch (e) { res.status(500).json({ error: "Échec : " + e.message }); }
});

/* ---------------- Sync ---------------- */
router.get("/sync/config", ADMIN, (req, res) => { res.json(syncCfg(scopeTid(req))); });
router.put("/sync/config", ADMIN, (req, res) => { const c = syncCfg(scopeTid(req)); const b = req.body || {}; if (b.mode !== undefined) c.mode = b.mode; if (b.backendId !== undefined) c.backendId = b.backendId || null; if (b.intervalMin !== undefined) c.intervalMin = Math.max(5, Number(b.intervalMin) || 60); save(); audit(req.user, "UPDATED", "SyncConfig", c.id, { mode: c.mode }); res.json(c); });
router.get("/sync/status", ADMIN, (req, res) => { res.json(syncStatus(scopeTid(req))); });
router.post("/sync/run", ADMIN, async (req, res) => { try { res.json(await runSync(scopeTid(req), { backendId: (req.body || {}).backendId, user: req.user })); } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code || null }); } });

module.exports = router;
module.exports.runBackup = runBackup;
module.exports.runDueSchedules = runDueSchedules;
module.exports.runSync = runSync;
