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

/* Anciens modèles livrés par défaut (signés « - SGRHP ») : remplacés automatiquement par les nouveaux
 * messages, SAUF si la société les a personnalisés (sujet ou texte modifié). */
const OLD_DEFAULT_SUBJECTS = {
  submitted: "Nouveau document à valider : {{title}}", validated: "Document validé : {{title}}",
  rejected: "Document rejeté : {{title}}", slaWarning: "Alerte délai (36h) : {{title}}",
  slaBreach: "Dépassement de délai : {{title}}", expiry: "Alerte d'expiration : {{document}} - {{employee}}",
};
function templateFor(eventKey, scope) {
  const tpl = ((scope ? own(scope).emailTemplates : (db.settings && db.settings.emailTemplates)) || {})[eventKey];
  const isOld = tpl && tpl.subjectFr === OLD_DEFAULT_SUBJECTS[eventKey] && /- SGRHP\s*$/.test(String(tpl.bodyFr || ""));
  if (!tpl || isOld) { try { return require("./routes/settings").DEFAULTS.emailTemplates[eventKey] || tpl || null; } catch (e) { return tpl || null; } }
  return tpl;
}
const PORTAL_URL = () => process.env.PUBLIC_URL || "https://portal.mboketech.com";
/** Nom de la société (expéditeur affiché, signature). */
function companyName(scope) {
  try {
    const s = own(scope); const c = (s.branding && s.branding.company) || {};
    if (c.name) return c.name;
    const tid = require("./routes/settings").tenantOf(scope);
    const t = (db.tenants || []).find(x => x.id === tid);
    return (t && t.name) || "MBOKA Mon RH";
  } catch (e) { return "MBOKA Mon RH"; }
}
const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Mise en page HTML commune à tous les e-mails (en-tête société, corps lisible, bouton, pied). */
function htmlEmail(subject, text, scope) {
  const co = _esc(companyName(scope));
  const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => {
    if (/^-{5,}$/.test(p)) return '<hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0">';
    if (/^https?:\/\/\S+$/.test(p)) return `<p style="margin:22px 0"><a href="${_esc(p)}" style="background:#065f46;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">Ouvrir MBOKA Mon RH</a></p>`;
    return `<p style="margin:0 0 14px">${_esc(p).replace(/\n/g, "<br>")}</p>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f4;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
<tr><td style="background:#065f46;color:#ffffff;padding:16px 24px"><div style="font-size:16px;font-weight:600">${co}</div><div style="font-size:12px;opacity:.85">MBOKA Mon RH</div></td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.6"><div style="font-size:15px;font-weight:600;margin-bottom:16px">${_esc(subject)}</div>${blocks}</td></tr>
<tr><td style="padding:14px 24px;background:#f9fafb;color:#6b7280;font-size:12px;line-height:1.5">Message automatique envoyé par MBOKA Mon RH pour ${co}. Merci de ne pas répondre à cet e-mail.</td></tr>
</table></td></tr></table></body></html>`;
}
function textSignature(scope) { return `\n\n--\n${companyName(scope)} · MBOKA Mon RH\nMessage automatique, merci de ne pas répondre.`; }

function render(eventKey, lang, vars = {}, scope) {
  const tpl = templateFor(eventKey, scope);
  if (!tpl) return null;
  vars = Object.assign({ link: PORTAL_URL(), company: companyName(scope) }, vars);
  const L = lang === "en" ? "En" : "Fr";
  const fill = s => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  return { subject: fill(tpl["subject" + L] || tpl.subjectFr), body: fill(tpl["body" + L] || tpl.bodyFr) };
}

async function send(to, subject, text, attachments, scope, html) {
  const c = cfg(scope);
  const t = build(c);
  if (!t) throw new Error("Configuration email désactivée ou incomplète");
  const msg = { from: c.from || "MBOKA Mon RH <no-reply@localhost>", to: Array.isArray(to) ? to.join(",") : to, subject, text, attachments };
  if (html) msg.html = html;
  return t.sendMail(msg);
}
/** Notification e-mail : texte + version HTML mise en page, signature de la société ajoutée. */
async function trySend(to, subject, text, scope) {
  try {
    if (!to || !to.length) return false;
    await send(to, subject, String(text || "") + textSignature(scope), undefined, scope, htmlEmail(subject, text, scope));
    return true;
  }
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
module.exports = { send, trySend, reset, cfg, recipientsFor, render, verify, templateFor, htmlEmail, companyName, PORTAL_URL };
