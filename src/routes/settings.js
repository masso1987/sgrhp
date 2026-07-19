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
  email: {
    enabled: false, provider: "smtp", from: "SGRHP <no-reply@cible-rh.ci>",
    notifyOnWorkflow: true, notifyOnSla: true,
    smtp: { host: "", port: 587, secure: false, user: "", password: "" },
    ses: { region: "eu-west-1", smtpUser: "", smtpPass: "" },
    postmark: { serverToken: "" },
    mailgun: { region: "us", domain: "", smtpLogin: "", smtpPassword: "" },
    sendmail: { path: "/usr/sbin/sendmail" },
  },
  emailRecipients: { globalCC: "", byEvent: { submitted: "", validated: "", rejected: "", slaWarning: "", slaBreach: "" } },
  emailTemplates: {
    submitted: { subjectFr: "Nouveau document à valider : {{title}}", subjectEn: "New document to validate: {{title}}",
      bodyFr: "Bonjour,\n\nLe document « {{title}} » a été soumis par {{initiator}} et attend votre validation (délai : {{sla}}h).\n\n— SGRHP", 
      bodyEn: "Hello,\n\nThe document \"{{title}}\" was submitted by {{initiator}} and awaits your validation (deadline: {{sla}}h).\n\n— SGRHP" },
    validated: { subjectFr: "Document validé : {{title}}", subjectEn: "Document validated: {{title}}",
      bodyFr: "Le document « {{title}} » a été validé.\n\n— SGRHP", bodyEn: "The document \"{{title}}\" has been validated.\n\n— SGRHP" },
    rejected: { subjectFr: "Document rejeté : {{title}}", subjectEn: "Document rejected: {{title}}",
      bodyFr: "Le document « {{title}} » a été rejeté par {{validator}}.\nMotif : {{reason}}\n\nMerci de corriger et resoumettre.\n\n— SGRHP",
      bodyEn: "The document \"{{title}}\" was rejected by {{validator}}.\nReason: {{reason}}\n\nPlease correct and resubmit.\n\n— SGRHP" },
    slaWarning: { subjectFr: "Alerte délai (36h) : {{title}}", subjectEn: "SLA warning (36h): {{title}}",
      bodyFr: "Le document « {{title}} » approche du délai de validation de 48h ({{elapsed}}h écoulées).\n\n— SGRHP",
      bodyEn: "The document \"{{title}}\" is approaching the 48h validation deadline ({{elapsed}}h elapsed).\n\n— SGRHP" },
    slaBreach: { subjectFr: "Dépassement de délai : {{title}}", subjectEn: "SLA breach: {{title}}",
      bodyFr: "Le délai de 48h est dépassé pour « {{title}} » ({{elapsed}}h).\n\n— SGRHP",
      bodyEn: "The 48h deadline is exceeded for \"{{title}}\" ({{elapsed}}h).\n\n— SGRHP" },
  },
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
  const MASK = "********";
  const em = JSON.parse(JSON.stringify(s.email));
  if (em.smtp && em.smtp.password) em.smtp.password = MASK;
  if (em.ses && em.ses.smtpPass) em.ses.smtpPass = MASK;
  if (em.postmark && em.postmark.serverToken) em.postmark.serverToken = MASK;
  if (em.mailgun && em.mailgun.smtpPassword) em.mailgun.smtpPassword = MASK;
  res.json({ security: s.security, email: em,
    emailTemplates: s.emailTemplates, emailRecipients: s.emailRecipients,
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

const EMAILRE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function mergeSecret(next, cur) { return (next && next !== "********") ? next : cur; }

router.put("/email", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  const before = { provider: s.email.provider, enabled: s.email.enabled };
  const providers = ["smtp", "ses", "postmark", "mailgun", "sendmail"];
  if (b.provider && !providers.includes(b.provider)) return res.status(400).json({ error: "Fournisseur inconnu" });
  s.email.enabled = b.enabled ?? s.email.enabled;
  s.email.provider = b.provider ?? s.email.provider;
  if (b.from !== undefined) s.email.from = b.from;
  if (b.notifyOnWorkflow !== undefined) s.email.notifyOnWorkflow = !!b.notifyOnWorkflow;
  if (b.notifyOnSla !== undefined) s.email.notifyOnSla = !!b.notifyOnSla;
  if (b.smtp) Object.assign(s.email.smtp, { host: b.smtp.host ?? s.email.smtp.host,
    port: b.smtp.port ?? s.email.smtp.port, secure: b.smtp.secure ?? s.email.smtp.secure,
    user: b.smtp.user ?? s.email.smtp.user, password: mergeSecret(b.smtp.password, s.email.smtp.password) });
  if (b.ses) Object.assign(s.email.ses, { region: b.ses.region ?? s.email.ses.region,
    smtpUser: b.ses.smtpUser ?? s.email.ses.smtpUser, smtpPass: mergeSecret(b.ses.smtpPass, s.email.ses.smtpPass) });
  if (b.postmark) s.email.postmark.serverToken = mergeSecret(b.postmark.serverToken, s.email.postmark.serverToken);
  if (b.mailgun) Object.assign(s.email.mailgun, { region: b.mailgun.region ?? s.email.mailgun.region,
    domain: b.mailgun.domain ?? s.email.mailgun.domain, smtpLogin: b.mailgun.smtpLogin ?? s.email.mailgun.smtpLogin,
    smtpPassword: mergeSecret(b.mailgun.smtpPassword, s.email.mailgun.smtpPassword) });
  if (b.sendmail) s.email.sendmail.path = b.sendmail.path ?? s.email.sendmail.path;
  // basic provider-specific validation when enabling
  if (s.email.enabled) {
    if (s.email.provider === "smtp" && !s.email.smtp.host) return res.status(400).json({ error: "Serveur SMTP requis" });
    if (s.email.provider === "ses" && !s.email.ses.smtpUser) return res.status(400).json({ error: "Identifiants SMTP SES requis" });
    if (s.email.provider === "postmark" && !s.email.postmark.serverToken) return res.status(400).json({ error: "Server Token Postmark requis" });
    if (s.email.provider === "mailgun" && (!s.email.mailgun.domain || !s.email.mailgun.smtpLogin)) return res.status(400).json({ error: "Domaine et identifiants Mailgun requis" });
  }
  save(); mailer.reset();
  audit(req.user, "CONFIG_CHANGED", "Settings", "email", { before, after: { provider: s.email.provider, enabled: s.email.enabled } });
  res.json({ ok: true, provider: s.email.provider, enabled: s.email.enabled });
});

router.put("/email/templates", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  for (const key of Object.keys(s.emailTemplates)) {
    if (!b[key]) continue;
    for (const f of ["subjectFr", "subjectEn", "bodyFr", "bodyEn"])
      if (b[key][f] !== undefined) s.emailTemplates[key][f] = String(b[key][f]).slice(0, 4000);
  }
  save();
  audit(req.user, "CONFIG_CHANGED", "Settings", "emailTemplates", {});
  res.json(s.emailTemplates);
});

router.put("/email/recipients", allow("ADM"), (req, res) => {
  const s = settings();
  const b = req.body || {};
  const clean = v => String(v || "").split(",").map(x => x.trim()).filter(Boolean)
    .filter(x => { if (!EMAILRE.test(x)) throw Object.assign(new Error("Adresse invalide : " + x), { status: 400 }); return true; }).join(", ");
  try {
    if (b.globalCC !== undefined) s.emailRecipients.globalCC = clean(b.globalCC);
    for (const k of Object.keys(s.emailRecipients.byEvent))
      if (b.byEvent && b.byEvent[k] !== undefined) s.emailRecipients.byEvent[k] = clean(b.byEvent[k]);
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  save();
  audit(req.user, "CONFIG_CHANGED", "Settings", "emailRecipients", {});
  res.json(s.emailRecipients);
});

router.post("/email/test", allow("ADM"), async (req, res) => {
  const to = req.body && req.body.to;
  if (!to || !EMAILRE.test(to)) return res.status(400).json({ error: "Adresse email de test invalide" });
  try {
    const info = await mailer.send(to, "SGRHP — test de configuration email",
      `Ceci est un email de test envoyé via le fournisseur « ${mailer.cfg().provider} ».\n\nSi vous le recevez, la configuration est correcte.`);
    audit(req.user, "CONFIG_CHANGED", "Settings", "email-test", { to, provider: mailer.cfg().provider, ok: true });
    res.json({ ok: true, provider: mailer.cfg().provider, messageId: info.messageId || null });
  } catch (e) {
    audit(req.user, "CONFIG_CHANGED", "Settings", "email-test", { to, ok: false, error: e.message });
    res.status(400).json({ error: `Échec de l'envoi : ${e.message}` });
  }
});

module.exports = { router, settings, DEFAULTS };
