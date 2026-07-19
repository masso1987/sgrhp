/**
 * Application settings managed from the interface (administrator only):
 *  - security  : 2FA policy, session duration, login lockout
 *  - smtp      : outgoing email server used for workflow notifications
 * Secrets are never returned to the client; changes are audited.
 */
const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const mailer = require("../mailer");

const DEFAULTS = {
  security: {
    require2faForAdmins: process.env.ENFORCE_2FA === "true" || process.env.NODE_ENV === "production",
    require2faForAll: false,
    sessionHours: 8,
    maxFailedLogins: 5,
    lockoutMinutes: 15,
    idleTimeoutMinutes: 30,
  },
  smtp: { enabled: false, host: "", port: 587, secure: false, user: "", password: "",
    from: "SGRHP <no-reply@cible-rh.ci>", notifyOnWorkflow: true, notifyOnSla: true },
  branding: {
    appName: "SGRHP",
    tagline: "Cible RH Emploi S.A.",
    logo: "",                       // small data-URL, optional
    colors: {
      primary: "#1e3a5f", accent: "#e8833a", bg: "#f4f6f9",
      sidebar: "#ffffff", text: "#1f2937",
    },
    // optional accent override per interface section (falls back to accent)
    sectionColors: {
      dash: "", employees: "", queue: "", career: "", reports: "",
      grid: "", fiches: "", dataio: "", params: "", settings: "",
    },
    density: "comfortable",         // comfortable | compact
  },
};

function settings() {
  if (!db.settings) db.settings = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k of Object.keys(DEFAULTS))
    db.settings[k] = { ...DEFAULTS[k], ...(db.settings[k] || {}) };
  return db.settings;
}

/** Public read: password masked. */
router.get("/", allow("ADM"), (req, res) => {
  const s = settings();
  res.json({ security: s.security,
    smtp: { ...s.smtp, password: s.smtp.password ? "********" : "" },
    branding: s.branding });
});

router.put("/security", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  const before = { ...s.security };
  if (b.sessionHours !== undefined && !(b.sessionHours >= 1 && b.sessionHours <= 24))
    return res.status(400).json({ error: "La durée de session doit être comprise entre 1 et 24 heures" });
  if (b.maxFailedLogins !== undefined && !(b.maxFailedLogins >= 3 && b.maxFailedLogins <= 20))
    return res.status(400).json({ error: "Le nombre d'échecs autorisés doit être compris entre 3 et 20" });
  if (b.idleTimeoutMinutes !== undefined && !(b.idleTimeoutMinutes >= 5 && b.idleTimeoutMinutes <= 480))
    return res.status(400).json({ error: "Le délai d'inactivité doit être compris entre 5 et 480 minutes" });
  Object.assign(s.security, {
    require2faForAdmins: b.require2faForAdmins ?? s.security.require2faForAdmins,
    require2faForAll: b.require2faForAll ?? s.security.require2faForAll,
    sessionHours: b.sessionHours ?? s.security.sessionHours,
    maxFailedLogins: b.maxFailedLogins ?? s.security.maxFailedLogins,
    lockoutMinutes: b.lockoutMinutes ?? s.security.lockoutMinutes,
    idleTimeoutMinutes: b.idleTimeoutMinutes ?? s.security.idleTimeoutMinutes,
  });
  save();
  audit(req.user, "CONFIG_CHANGED", "Settings", "security", { before, after: s.security });
  res.json(s.security);
});

router.put("/smtp", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  const before = { ...s.smtp, password: s.smtp.password ? "***" : "" };
  if (b.enabled && !b.host) return res.status(400).json({ error: "Le serveur SMTP est obligatoire" });
  if (b.port !== undefined && !(b.port > 0 && b.port < 65536))
    return res.status(400).json({ error: "Port SMTP invalide" });
  Object.assign(s.smtp, {
    enabled: b.enabled ?? s.smtp.enabled,
    host: b.host ?? s.smtp.host,
    port: b.port ?? s.smtp.port,
    secure: b.secure ?? s.smtp.secure,
    user: b.user ?? s.smtp.user,
    // an unchanged masked password must not overwrite the stored one
    password: (b.password && b.password !== "********") ? b.password : s.smtp.password,
    from: b.from ?? s.smtp.from,
    notifyOnWorkflow: b.notifyOnWorkflow ?? s.smtp.notifyOnWorkflow,
    notifyOnSla: b.notifyOnSla ?? s.smtp.notifyOnSla,
  });
  save();
  mailer.reset();
  audit(req.user, "CONFIG_CHANGED", "Settings", "smtp",
    { before, after: { ...s.smtp, password: s.smtp.password ? "***" : "" } });
  res.json({ ...s.smtp, password: s.smtp.password ? "********" : "" });
});

/** Send a test message to verify the configuration. */
router.post("/smtp/test", allow("ADM"), async (req, res) => {
  const to = req.body?.to;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
    return res.status(400).json({ error: "Adresse email de test invalide" });
  try {
    const info = await mailer.send(to, "SGRHP — test de configuration",
      "Ceci est un message de test envoyé depuis SGRHP.\n\nSi vous le recevez, la configuration SMTP est correcte.");
    audit(req.user, "CONFIG_CHANGED", "Settings", "smtp-test", { to, ok: true });
    res.json({ ok: true, messageId: info.messageId || null });
  } catch (e) {
    audit(req.user, "CONFIG_CHANGED", "Settings", "smtp-test", { to, ok: false, error: e.message });
    res.status(400).json({ error: `Échec de l'envoi : ${e.message}` });
  }
});

const HEX = /^#[0-9a-fA-F]{6}$/;
router.put("/branding", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  const before = JSON.parse(JSON.stringify(s.branding));
  if (b.appName !== undefined) s.branding.appName = String(b.appName).slice(0, 40) || "SGRHP";
  if (b.tagline !== undefined) s.branding.tagline = String(b.tagline).slice(0, 80);
  if (b.logo !== undefined) {
    if (b.logo && !/^data:image\/(png|jpeg|svg\+xml);base64,/.test(b.logo) && b.logo.length > 0)
      return res.status(400).json({ error: "Logo invalide (image PNG/JPEG/SVG en data-URL attendue)" });
    if (b.logo && b.logo.length > 300000) return res.status(400).json({ error: "Logo trop volumineux (max ~200 Ko)" });
    s.branding.logo = b.logo;
  }
  if (b.density && ["comfortable", "compact"].includes(b.density)) s.branding.density = b.density;
  for (const [k, v] of Object.entries(b.colors || {})) {
    if (s.branding.colors[k] === undefined) continue;
    if (!HEX.test(v)) return res.status(400).json({ error: `Couleur invalide pour ${k} : ${v}` });
    s.branding.colors[k] = v;
  }
  for (const [k, v] of Object.entries(b.sectionColors || {})) {
    if (s.branding.sectionColors[k] === undefined) continue;
    if (v && !HEX.test(v)) return res.status(400).json({ error: `Couleur de section invalide : ${k}` });
    s.branding.sectionColors[k] = v || "";
  }
  save();
  audit(req.user, "CONFIG_CHANGED", "Settings", "branding", { before, after: s.branding });
  res.json(s.branding);
});

module.exports = { router, settings, DEFAULTS };
