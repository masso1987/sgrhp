/**
 * Logical backup/restore of the whole application: the in-memory DB (all collections)
 * plus the uploaded files. Archive = gzip(JSON{meta, db, files[]}), optionally AES-encrypted.
 * Restore always takes a safety snapshot first, then applies in place (works in JSON and PG
 * modes, since the DB lives in memory and save() persists to the active backend).
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { encryptBuffer, decryptBuffer } = require("./crypto");

const UPLOADS = path.join(__dirname, "..", "uploads");
const MAGIC_PLAIN = 0x11, MAGIC_ENC = 0x12;

function collectUploads() {
  const out = [];
  const walk = (dir, rel) => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) { if (e.name.startsWith(".")) continue; const p = path.join(dir, e.name), r = (rel ? rel + "/" : "") + e.name;
      if (e.isDirectory()) walk(p, r); else { try { const b = fs.readFileSync(p); out.push({ path: r, b64: b.toString("base64"), size: b.length }); } catch (x) {} } } };
  walk(UPLOADS, ""); return out;
}

function dbSnapshot(db) {
  const o = {};
  for (const k of Object.keys(db)) { const v = db[k]; if (typeof v === "function") continue; o[k] = v; }
  return JSON.parse(JSON.stringify(o));
}

/** Build an archive Buffer. opts.encrypt → AES-256-GCM wrap. */
function createArchive(db, opts) {
  opts = opts || {};
  const files = opts.includeFiles === false ? [] : collectUploads();
  const payload = { meta: { version: 1, createdAt: new Date().toISOString(), collections: Object.keys(db).filter(k => Array.isArray(db[k])).length, fileCount: files.length }, db: dbSnapshot(db), files };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 });
  const body = opts.encrypt ? encryptBuffer(gz) : gz;
  return { buffer: Buffer.concat([Buffer.from([opts.encrypt ? MAGIC_ENC : MAGIC_PLAIN]), body]), meta: payload.meta, encrypted: !!opts.encrypt };
}

function parseArchive(buf) {
  const magic = buf[0]; const body = buf.subarray(1);
  const gz = magic === MAGIC_ENC ? decryptBuffer(body) : body;
  return JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
}

/** Apply a parsed archive to the live db in place, then persist. Overwrites collections. */
function applyArchive(db, payload, save) {
  const src = payload.db || {};
  for (const k of Object.keys(src)) {
    if (Array.isArray(db[k]) && Array.isArray(src[k])) { db[k].length = 0; for (const it of src[k]) db[k].push(it); }
    else db[k] = src[k];
  }
  // restore files
  for (const f of (payload.files || [])) {
    try { const dest = path.join(UPLOADS, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(f.b64, "base64")); } catch (e) {}
  }
  if (typeof save === "function") save();
}

/** Restore from an archive buffer: snapshot current state first (safety), then apply. */
function restoreArchive(db, buf, save) {
  const safety = createArchive(db, { encrypt: false }); // pre-restore snapshot (unencrypted, kept locally)
  const payload = parseArchive(buf);
  applyArchive(db, payload, save);
  return { safety: safety.buffer, restoredMeta: payload.meta };
}

module.exports = { createArchive, parseArchive, applyArchive, restoreArchive, collectUploads, UPLOADS };
