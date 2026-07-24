/**
 * Multi-provider email delivery (§7.1).
 * Providers: SMTP, Amazon SES, Postmark, Mailgun, Sendmail — all via nodemailer
 * (SES/Postmark/Mailgun through their SMTP interface, no extra SDKs).
 * Config in settings.email; bilingual templates in settings.emailTemplates;
 * extra recipients in settings.emailRecipients.
 */
const nodemailer = require("nodemailer");
const { db } = require("./store");

let transport = null, signature = "";
function cfg() { return (db.settings && db.settings.email) || { enabled: false, provider: "smtp" }; }
function reset() { transport = null; signature = ""; }

function build() {
  const c = cfg();
  if (!c.enabled) return null;
  const sig = JSON.stringify(c);
  if (transport && sig === signature) return transport;
  let t;
  switch (c.provider) {
    case "sendmail":
      t = { sendmail: true, newline: "unix", path: (c.sendmail && c.sendmail.path) || "/usr/sbin/sendmail" }; break;
    case "ses": { const s = c.ses || {};
      t = { host: `email-smtp.${s.region || "eu-west-1"}.amazonaws.com`, port: 587, secure: false,
        auth: { user: s.smtpUser, pass: s.smtpPass } }; break; }
    case "postmark": { const p = c.postmark || {};
      t = { host: "smtp.postmarkapp.com", port: 587, secure: false, auth: { user: p.serverToken, pass: p.serverToken } }; break; }
    case "mailgun": { const m = c.mailgun || {};
      t = { host: m.region === "eu" ? "smtp.eu.mailgun.org" : "smtp.mailgun.org", port: 587, secure: false,
        auth: { user: m.smtpLogin, pass: m.smtpPassword } }; break; }
    case "smtp":
    default: { const s = c.smtp || {};
      t = { host: s.host, port: Number(s.port) || 587, secure: !!s.secure,
        auth: s.user ? { user: s.user, pass: s.password } : undefined }; }
  }
  t.connectionTimeout = 10000; t.greetingTimeout = 10000;
  transport = nodemailer.createTransport(t); signature = sig;
  return transport;
}

function recipientsFor(eventKey, base) {
  const r = (db.settings && db.settings.emailRecipients) || {};
  const extra = [(r.byEvent && r.byEvent[eventKey]) || "", r.globalCC || ""]
    .join(",").split(",").map(s => s.trim()).filter(Boolean);
  return [...new Set([...(Array.isArray(base) ? base : [base]).filter(Boolean), ...extra])];
}

function render(eventKey, lang, vars = {}) {
  const tpl = ((db.settings && db.settings.emailTemplates) || {})[eventKey];
  if (!tpl) return null;
  const L = lang === "en" ? "En" : "Fr";
  const fill = s => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  return { subject: fill(tpl["subject" + L] || tpl.subjectFr), body: fill(tpl["body" + L] || tpl.bodyFr) };
}

async function send(to, subject, text, attachments) {
  const t = build();
  if (!t) throw new Error("Configuration email désactivée ou incomplète");
  return t.sendMail({ from: cfg().from || "SGRHP <no-reply@localhost>", to: Array.isArray(to) ? to.join(",") : to, subject, text, attachments });
}
async function trySend(to, subject, text) {
  try { if (!to || !to.length) return false; await send(to, subject, text); return true; }
  catch (e) { console.error("[mailer] envoi échoué:", e.message); return false; }
}
module.exports = { send, trySend, reset, cfg, recipientsFor, render };
