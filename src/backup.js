/**
 * Backup/restore — full-platform OR per-tenant, with strict tenant isolation.
 *  - createArchive(db, {tenantId}) : if tenantId, only that tenant's rows (every array
 *    collection filtered by tenantId) + only that tenant's uploaded files. Otherwise the
 *    whole platform.
 *  - restore : a tenant-scoped archive replaces ONLY that tenant (its rows across all
 *    collections + its files are removed, then the backup is loaded); other tenants are
 *    never touched. A full-platform archive replaces everything.
 * Archive = magic-byte + gzip(JSON{meta, db, files[]}), optionally AES-256-GCM encrypted.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { encryptBuffer, decryptBuffer } = require("./crypto");

const UPLOADS = path.join(__dirname, "..", "uploads");
const MAGIC_PLAIN = 0x11, MAGIC_ENC = 0x12;
const tid_ = (x) => (x && x.tenantId) || "t1";

function fileExists(name) { try { return fs.existsSync(path.join(UPLOADS, name)); } catch (e) { return false; } }

/** Every uploads-dir file referenced by a given tenant's rows (across all collections). */
function tenantFileRels(db, tid) {
  const set = new Set();
  const scan = (v) => { if (v == null) return;
    if (typeof v === "string") { if (v && !v.includes("/") && !v.includes("..") && fileExists(v)) set.add(v); }
    else if (Array.isArray(v)) v.forEach(scan);
    else if (typeof v === "object") for (const k in v) scan(v[k]); };
  for (const k of Object.keys(db)) { if (!Array.isArray(db[k])) continue; for (const row of db[k]) { if (tid_(row) !== tid) continue; scan(row); } }
  return [...set];
}
function collectUploads() {
  const out = [];
  const walk = (dir, rel) => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) { if (e.name.startsWith(".")) continue; const p = path.join(dir, e.name), r = (rel ? rel + "/" : "") + e.name;
      if (e.isDirectory()) walk(p, r); else { try { out.push(e.name && r); } catch (x) {} } } };
  walk(UPLOADS, ""); return out.filter(Boolean);
}
function readFilesByRel(rels) {
  const out = [];
  for (const rel of rels) { try { const b = fs.readFileSync(path.join(UPLOADS, rel)); out.push({ path: rel, b64: b.toString("base64"), size: b.length }); } catch (e) {} }
  return out;
}
function scanUploads() {
  const out = [];
  const walk = (dir, rel) => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) { if (e.name.startsWith(".")) continue; const p = path.join(dir, e.name), r = (rel ? rel + "/" : "") + e.name;
      if (e.isDirectory()) walk(p, r); else { try { const st = fs.statSync(p); out.push({ path: r, size: st.size, mtime: Math.round(st.mtimeMs) }); } catch (x) {} } } };
  walk(UPLOADS, ""); return out;
}
function readUpload(rel) { return fs.readFileSync(path.join(UPLOADS, rel)); }

function dbSnapshotFull(db) { const o = {}; for (const k of Object.keys(db)) { if (typeof db[k] === "function") continue; o[k] = db[k]; } return JSON.parse(JSON.stringify(o)); }
function dbSnapshotTenant(db, tid) { const o = {}; for (const k of Object.keys(db)) { if (!Array.isArray(db[k])) continue; const rows = db[k].filter(x => tid_(x) === tid); if (rows.length) o[k] = rows; } return JSON.parse(JSON.stringify(o)); }

/** Build an archive Buffer. opts.tenantId → per-tenant; else full-platform. */
function createArchive(db, opts) {
  opts = opts || {}; const tid = opts.tenantId || null;
  let dbPart, files;
  if (tid) { dbPart = dbSnapshotTenant(db, tid); files = opts.includeFiles === false ? [] : readFilesByRel(tenantFileRels(db, tid)); }
  else { dbPart = dbSnapshotFull(db); files = opts.includeFiles === false ? [] : readFilesByRel(collectUploads()); }
  const payload = { meta: { version: 2, createdAt: new Date().toISOString(), scope: tid ? "tenant" : "platform", tenantId: tid, collections: Object.keys(dbPart).filter(k => Array.isArray(dbPart[k])).length, fileCount: files.length }, db: dbPart, files };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 });
  const body = opts.encrypt ? encryptBuffer(gz) : gz;
  return { buffer: Buffer.concat([Buffer.from([opts.encrypt ? MAGIC_ENC : MAGIC_PLAIN]), body]), meta: payload.meta, encrypted: !!opts.encrypt };
}
function parseArchive(buf) {
  const magic = buf[0]; const body = buf.subarray(1);
  const gz = magic === MAGIC_ENC ? decryptBuffer(body) : body;
  return JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
}

function writeFiles(files) { for (const f of (files || [])) { try { const dest = path.join(UPLOADS, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(f.b64, "base64")); } catch (e) {} } }

/** Apply a parsed archive in place. Tenant scope replaces only that tenant; else full replace. */
function applyArchive(db, payload, save) {
  const meta = payload.meta || {}; const tid = meta.tenantId;
  if (tid) {
    // remove this tenant's current files from disk first (replace-entirely)
    for (const rel of tenantFileRels(db, tid)) { try { fs.unlinkSync(path.join(UPLOADS, rel)); } catch (e) {} }
    for (const k of Object.keys(payload.db || {})) {
      if (!Array.isArray(db[k])) db[k] = [];
      for (let i = db[k].length - 1; i >= 0; i--) if (tid_(db[k][i]) === tid) db[k].splice(i, 1);
      for (const it of payload.db[k]) db[k].push(it);
    }
    writeFiles(payload.files);
  } else {
    for (const k of Object.keys(payload.db || {})) {
      if (Array.isArray(db[k]) && Array.isArray(payload.db[k])) { db[k].length = 0; for (const it of payload.db[k]) db[k].push(it); }
      else db[k] = payload.db[k];
    }
    writeFiles(payload.files);
  }
  if (typeof save === "function") save();
}

/** Restore from a buffer: take a safety snapshot of the SAME scope first, then apply. */
function restoreArchive(db, buf, save) {
  const payload = parseArchive(buf);
  const tid = payload.meta && payload.meta.tenantId;
  const safety = createArchive(db, { encrypt: false, tenantId: tid || null });
  applyArchive(db, payload, save);
  return { safety: safety.buffer, restoredMeta: payload.meta };
}

module.exports = { createArchive, parseArchive, applyArchive, restoreArchive, collectUploads, scanUploads, readUpload, tenantFileRels, UPLOADS };
