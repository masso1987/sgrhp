/**
 * Outgoing email using the SMTP settings configured in the interface (§7.1).
 * Falls back silently when disabled so the workflow is never blocked by email.
 */
const nodemailer = require("nodemailer");
const { db } = require("./store");

let transport = null, signature = "";

function config() {
  return (db.settings && db.settings.smtp) || { enabled: false };
}
function reset() { transport = null; signature = ""; }

function build() {
  const c = config();
  if (!c.enabled || !c.host) return null;
  const sig = JSON.stringify([c.host, c.port, c.secure, c.user, c.password]);
  if (transport && sig === signature) return transport;
  transport = nodemailer.createTransport({
    host: c.host, port: Number(c.port) || 587, secure: !!c.secure,
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000,
  });
  signature = sig;
  return transport;
}

/** Throws on failure — used by the "send test" button. */
async function send(to, subject, text) {
  const t = build();
  if (!t) throw new Error("SMTP non configuré ou désactivé");
  return t.sendMail({ from: config().from || "SGRHP <no-reply@localhost>", to, subject, text });
}

/** Never throws — used by workflow notifications. */
async function trySend(to, subject, text) {
  try {
    if (!to) return false;
    await send(to, subject, text);
    return true;
  } catch (e) {
    console.error("[mailer] envoi échoué:", e.message);
    return false;
  }
}

module.exports = { send, trySend, reset, config };
