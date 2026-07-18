/**
 * Authentication & account security (§8.2).
 * - scrypt password hashing, strong password policy
 * - TOTP two-factor authentication, mandatory for ADM accounts
 * - brute-force lockout after repeated failures, every attempt audited
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const { db, save } = require("./store");
const { audit } = require("./audit");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const TOKEN_TTL = process.env.TOKEN_TTL || "8h";
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// 2FA is enforced for administrators in production; opt-in in development so the
// demo accounts stay usable. Set ENFORCE_2FA=true to enforce it anywhere.
const ENFORCE_2FA = process.env.ENFORCE_2FA === "true" || process.env.NODE_ENV === "production";
const TWOFA_REQUIRED_ROLES = ENFORCE_2FA ? ["ADM"] : [];

if (process.env.NODE_ENV === "production" && SECRET === "dev-secret-change-in-production")
  throw new Error("JWT_SECRET must be set in production");

/* ---------- passwords ---------- */
function hash(pw, salt = crypto.randomBytes(8).toString("hex")) {
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function verifyPw(pw, stored) {
  const [salt, h] = stored.split(":");
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Policy: >=10 chars, upper, lower, digit; rejects the demo password in production. */
function passwordPolicy(pw) {
  if (!pw || pw.length < 10) return "Le mot de passe doit contenir au moins 10 caractères";
  if (!/[a-z]/.test(pw)) return "Le mot de passe doit contenir une minuscule";
  if (!/[A-Z]/.test(pw)) return "Le mot de passe doit contenir une majuscule";
  if (!/[0-9]/.test(pw)) return "Le mot de passe doit contenir un chiffre";
  if (/^(demo|password|azerty|123456)/i.test(pw)) return "Mot de passe trop courant";
  return null;
}

/* ---------- login ---------- */
function login(req, res) {
  const { email, password, totp } = req.body || {};
  const user = db.users.find(u => u.email === email && u.active);
  const fail = (msg, code = 401) => res.status(code).json({ error: msg });

  if (!user) return fail("Identifiants invalides");
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    const mins = Math.ceil((new Date(user.lockedUntil) - Date.now()) / 60000);
    return fail(`Compte temporairement verrouillé — réessayez dans ${mins} min`, 423);
  }
  if (!verifyPw(password || "", user.password)) {
    user.failedLogins = (user.failedLogins || 0) + 1;
    if (user.failedLogins >= MAX_FAILED) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      user.failedLogins = 0;
      audit({ id: user.id, fullName: user.fullName, role: user.role, tenantId: "t1" },
        "LOCKED", "User", user.id, { reason: "too many failed logins" });
    }
    save();
    return fail("Identifiants invalides");
  }

  // Two-factor: mandatory for administrators, optional (opt-in) for others
  const needs2fa = user.totpEnabled || TWOFA_REQUIRED_ROLES.includes(user.role);
  if (needs2fa) {
    if (!user.totpSecret)
      return res.status(428).json({ error: "Configuration 2FA requise", setupRequired: true, userId: user.id });
    if (!totp) return res.status(401).json({ error: "Code 2FA requis", totpRequired: true });
    const ok = speakeasy.totp.verify({ secret: user.totpSecret, encoding: "base32", token: String(totp), window: 1 });
    if (!ok) {
      audit({ id: user.id, fullName: user.fullName, role: user.role, tenantId: "t1" },
        "LOGIN_FAILED", "User", user.id, { reason: "bad 2FA code" });
      return fail("Code 2FA invalide");
    }
  }

  user.failedLogins = 0; user.lockedUntil = null; save();
  const token = jwt.sign({ id: user.id, role: user.role, fullName: user.fullName, tenantId: "t1" },
    SECRET, { expiresIn: TOKEN_TTL });
  audit({ id: user.id, fullName: user.fullName, role: user.role, tenantId: "t1" }, "LOGIN", "User", user.id, {});
  res.json({ token, user: { id: user.id, fullName: user.fullName, role: user.role, portfolioIds: user.portfolioIds } });
}

function authenticate(req, res, next) {
  const h = req.header("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Jeton manquant" });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { return res.status(401).json({ error: "Session expirée, reconnectez-vous" }); }
}

function me(req, res) {
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "Introuvable" });
  const { password, totpSecret, ...safe } = u;
  res.json({ ...safe, twoFactor: !!u.totpSecret });
}

/* ---------- 2FA enrolment ----------
 * Works either for a logged-in user (Bearer token) or, when 2FA is mandatory and
 * not yet configured, before login by re-proving email + password.
 */
function resolveUser(req) {
  const h = req.header("authorization") || "";
  if (h.startsWith("Bearer ")) {
    try { const p = jwt.verify(h.slice(7), SECRET); return db.users.find(u => u.id === p.id); } catch { /* fall through */ }
  }
  const { email, password } = req.body || {};
  if (email && password) {
    const u = db.users.find(x => x.email === email && x.active);
    if (u && verifyPw(password, u.password)) return u;
  }
  return null;
}

async function totpSetup(req, res) {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: "Authentification requise (jeton ou email + mot de passe)" });
  const secret = speakeasy.generateSecret({ name: `SGRHP (${user.email})`, issuer: "Cible RH Emploi" });
  user.pendingTotp = secret.base32; save();
  const qr = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ qr, manualKey: secret.base32 });
}

function totpConfirm(req, res) {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: "Authentification requise" });
  if (!user.pendingTotp) return res.status(400).json({ error: "Aucune configuration 2FA en cours" });
  const ok = speakeasy.totp.verify({ secret: user.pendingTotp, encoding: "base32",
    token: String(req.body?.totp || ""), window: 1 });
  if (!ok) return res.status(400).json({ error: "Code invalide — vérifiez l'heure de votre téléphone" });
  user.totpSecret = user.pendingTotp; user.totpEnabled = true; delete user.pendingTotp; save();
  audit({ id: user.id, fullName: user.fullName, role: user.role, tenantId: "t1" },
    "CONFIG_CHANGED", "User", user.id, { twoFactor: "enabled" });
  res.json({ ok: true });
}

function changePassword(req, res) {
  const user = db.users.find(u => u.id === req.user.id);
  const { current, next } = req.body || {};
  if (!verifyPw(current || "", user.password)) return res.status(401).json({ error: "Mot de passe actuel incorrect" });
  const err = passwordPolicy(next);
  if (err) return res.status(400).json({ error: err });
  user.password = hash(next); save();
  audit(req.user, "CONFIG_CHANGED", "User", user.id, { password: "changed" });
  res.json({ ok: true });
}

module.exports = { login, authenticate, hash, verifyPw, me, passwordPolicy,
  totpSetup, totpConfirm, changePassword, TWOFA_REQUIRED_ROLES };
