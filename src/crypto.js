/**
 * Secret encryption at rest (AES-256-GCM).
 * Master key from env APP_MASTER_KEY (64 hex chars = 32 bytes). If absent, a random key
 * is generated once and persisted to data/.masterkey so secrets survive restarts — with a
 * loud warning. Set APP_MASTER_KEY in production for a stronger posture.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEYFILE = path.join(__dirname, "..", "data", ".masterkey");
let _key = null;

function masterKey() {
  if (_key) return _key;
  const env = process.env.APP_MASTER_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env.trim())) { _key = Buffer.from(env.trim(), "hex"); return _key; }
  try { if (fs.existsSync(KEYFILE)) { _key = Buffer.from(fs.readFileSync(KEYFILE, "utf8").trim(), "hex"); return _key; } } catch (e) {}
  _key = crypto.randomBytes(32);
  try { fs.mkdirSync(path.dirname(KEYFILE), { recursive: true }); fs.writeFileSync(KEYFILE, _key.toString("hex"), { mode: 0o600 }); } catch (e) {}
  console.warn("[crypto] APP_MASTER_KEY non defini — cle generee dans data/.masterkey. Definissez APP_MASTER_KEY (64 hex) en production.");
  return _key;
}

function encryptSecret(plain) {
  if (plain == null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "v1:" + iv.toString("base64") + ":" + c.getAuthTag().toString("base64") + ":" + ct.toString("base64");
}
function decryptSecret(token) {
  if (!token || typeof token !== "string" || !token.startsWith("v1:")) return token || "";
  try {
    const [, ivB, tagB, ctB] = token.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  } catch (e) { return ""; }
}
const isEncrypted = (v) => typeof v === "string" && v.startsWith("v1:");

function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function decryptBuffer(buf) {
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

module.exports = { encryptSecret, decryptSecret, isEncrypted, encryptBuffer, decryptBuffer, masterKey };
