/**
 * Multi-provider email delivery (§7.1).
 * Providers: SMTP, Amazon SES, Postmark, Mailgun, Sendmail - all via nodemailer
 * (SES/Postmark/Mailgun through their SMTP interface, no extra SDKs).
 * Config in settings.email; bilingual templates in settings.emailTemplates;
 * extra recipients in settings.emailRecipients.
 */
const nodemailer = require("nodemailer");
const { db } = require("./store");

// Settings are per tenant (see routes/settings). `scope` is a tenant id, request, user or
// record; without one, the platform's (founding tenant's) settings apply.
const own = (scope) => require("./routes/settings").settings(scope);
const transports = new Map();   // config signature -> nodemailer transport
// A company that has not enabled its own email server sends through the platform's.
function cfg(scope) {
  const platform = (db.settings && db.settings.email) || { enabled: false, provider: "smtp" };
  if (!scope) return platform;
  const e = own(scope).email;
  return e && e.enabled ? e : platform;
}
function reset() { transports.clear(); }

function build(c) {
  if (!c.enabled) return null;
  const sig = JSON.stringify(c);
  if (transports.has(sig)) return transports.get(sig);
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
      const port = Number(s.port) || 587;
      // 465 => implicit TLS (SMTPS); 587/25 => STARTTLS. Derive from port so it
      // can't be misconfigured; fall back to the explicit flag for other ports.
      const secure = port === 465 ? true : (port === 587 || port === 25 ? false : !!s.secure);
      t = { host: s.host, port, secure,
        auth: s.user ? { user: s.user, pass: s.password } : undefined };
      if (!secure && port !== 25) t.requireTLS = true;
    }
  }
  t.connectionTimeout = 20000; t.greetingTimeout = 20000; t.socketTimeout = 25000;
  const transport = nodemailer.createTransport(t); transports.set(sig, transport);
  return transport;
}

function recipientsFor(eventKey, base, scope) {
  const r = (scope ? own(scope).emailRecipients : (db.settings && db.settings.emailRecipients)) || {};
  const extra = [(r.byEvent && r.byEvent[eventKey]) || "", r.globalCC || ""]
    .join(",").split(",").map(s => s.trim()).filter(Boolean);
  return [...new Set([...(Array.isArray(base) ? base : [base]).filter(Boolean), ...extra])];
}

function render(eventKey, lang, vars = {}, scope) {
  const tpl = ((scope ? own(scope).emailTemplates : (db.settings && db.settings.emailTemplates)) || {})[eventKey];
  if (!tpl) return null;
  const L = lang === "en" ? "En" : "Fr";
  const fill = s => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  return { subject: fill(tpl["subject" + L] || tpl.subjectFr), body: fill(tpl["body" + L] || tpl.bodyFr) };
}

async function send(to, subject, text, attachments, scope) {
  const c = cfg(scope);
  const t = build(c);
  if (!t) throw new Error("Configuration email désactivée ou incomplète");
  return t.sendMail({ from: c.from || "SGRHP <no-reply@localhost>", to: Array.isArray(to) ? to.join(",") : to, subject, text, attachments });
}
async function trySend(to, subject, text, scope) {
  try { if (!to || !to.length) return false; await send(to, subject, text, undefined, scope); return true; }
  catch (e) { console.error("[mailer] envoi échoué:", e.message); return false; }
}
/** Connection test for the system console: opens the SMTP session without sending. */
async function verify() {
  reset();
  const t = build(cfg());
  if (!t) throw new Error("Configuration email désactivée ou incomplète");
  if (t.options && t.options.sendmail) return true;
  return t.verify();
}
module.exports = { send, trySend, reset, cfg, recipientsFor, render, verify };
