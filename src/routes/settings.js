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
  },
  smtp: { enabled: false, host: "", port: 587, secure: false, user: "", password: "",
    from: "SGRHP <no-reply@cible-rh.ci>", notifyOnWorkflow: true, notifyOnSla: true },
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
    smtp: { ...s.smtp, password: s.smtp.password ? "********" : "" } });
});

router.put("/security", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  const before = { ...s.security };
  if (b.sessionHours !== undefined && !(b.sessionHours >= 1 && b.sessionHours <= 24))
    return res.status(400).json({ error: "La durée de session doit être comprise entre 1 et 24 heures" });
  if (b.maxFailedLogins !== undefined && !(b.maxFailedLogins >= 3 && b.maxFailedLogins <= 20))
    return res.status(400).json({ error: "Le nombre d'échecs autorisés doit être compris entre 3 et 20" });
  Object.assign(s.security, {
    require2faForAdmins: b.require2faForAdmins ?? s.security.require2faForAdmins,
    require2faForAll: b.require2faForAll ?? s.security.require2faForAll,
    sessionHours: b.sessionHours ?? s.security.sessionHours,
    maxFailedLogins: b.maxFailedLogins ?? s.security.maxFailedLogins,
    lockoutMinutes: b.lockoutMinutes ?? s.security.lockoutMinutes,
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

module.exports = { router, settings, DEFAULTS };
