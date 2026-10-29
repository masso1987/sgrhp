/**
 * Product analytics (PostHog) - optional, configured by the platform super-admin.
 *
 * Config lives in db.platform.posthog (editable from the system console) with env
 * fallbacks POSTHOG_KEY / POSTHOG_HOST. The project API key (phc_...) is a public
 * write-only key by design, so it is safe to hand to the browser.
 *
 * Server events go straight to the PostHog capture endpoint with fetch (no SDK),
 * fire-and-forget: analytics can never slow down or break a request.
 */
const { db } = require("./store");

const DEFAULTS = {
  enabled: false, apiKey: "", host: "https://eu.i.posthog.com",
  autocapture: true, capturePageviews: true, sessionRecording: false,
  identifyUsers: true, sendEmail: false, serverEvents: true,
};
const status = { lastSendAt: null, lastError: null, sent: 0, failed: 0 };

function cfg() {
  if (!db.platform) db.platform = {};
  const c = Object.assign({}, DEFAULTS, db.platform.posthog || {});
  if (!c.apiKey && process.env.POSTHOG_KEY) { c.apiKey = process.env.POSTHOG_KEY; if (db.platform.posthog === undefined) c.enabled = true; }
  if (process.env.POSTHOG_HOST && !(db.platform.posthog && db.platform.posthog.host)) c.host = process.env.POSTHOG_HOST;
  c.host = String(c.host || DEFAULTS.host).replace(/\/+$/, "");
  return c;
}
const active = () => { const c = cfg(); return c.enabled && !!c.apiKey && /^https?:\/\//.test(c.host); };

/** Static assets host: PostHog Cloud serves the JS from <region>-assets.i.posthog.com. */
function assetsHost(host) {
  const m = /^(https?:\/\/)(us|eu)\.i\.posthog\.com$/.exec(host || "");
  return m ? `${m[1]}${m[2]}-assets.i.posthog.com` : host;
}

/** Origins the browser must be allowed to reach (Content-Security-Policy). */
function cspOrigins() {
  if (!active()) return [];
  const c = cfg();
  return [...new Set([c.host, assetsHost(c.host)])];
}

/** What the SPA receives (public endpoint) - nothing unless enabled. */
function publicConfig() {
  if (!active()) return { enabled: false };
  const c = cfg();
  return { enabled: true, apiKey: c.apiKey, host: c.host, assetsHost: assetsHost(c.host),
    autocapture: !!c.autocapture, capturePageviews: !!c.capturePageviews,
    sessionRecording: !!c.sessionRecording, identifyUsers: !!c.identifyUsers, sendEmail: !!c.sendEmail };
}

function capture(distinctId, event, properties) {
  if (!active() || !cfg().serverEvents || !distinctId) return;
  const c = cfg();
  const body = JSON.stringify({ api_key: c.apiKey, event, distinct_id: String(distinctId),
    properties: Object.assign({ $lib: "sgrhp-server" }, properties || {}), timestamp: new Date().toISOString() });
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
  fetch(c.host + "/capture/", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctl.signal })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); status.sent++; status.lastSendAt = new Date().toISOString(); status.lastError = null; })
    .catch(e => { status.failed++; status.lastError = e.message; })
    .finally(() => clearTimeout(tm));
}

/** Synchronous round-trip used by the « Tester » button. */
async function test(distinctId) {
  const c = cfg();
  if (!c.apiKey) throw new Error("Clé de projet PostHog manquante");
  const r = await fetch(c.host + "/capture/", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: c.apiKey, event: "sgrhp_connection_test", distinct_id: String(distinctId || "sgrhp-platform"),
      properties: { $lib: "sgrhp-server" } }) });
  if (!r.ok) throw new Error("PostHog a répondu HTTP " + r.status);
  status.sent++; status.lastSendAt = new Date().toISOString(); status.lastError = null;
  return true;
}

function save(input) {
  const b = input || {};
  const cur = cfg();
  const next = {};
  for (const k of Object.keys(DEFAULTS)) next[k] = b[k] === undefined ? cur[k] : b[k];
  for (const k of ["enabled", "autocapture", "capturePageviews", "sessionRecording", "identifyUsers", "sendEmail", "serverEvents"]) next[k] = !!next[k];
  next.apiKey = String(next.apiKey || "").trim();
  next.host = String(next.host || DEFAULTS.host).trim().replace(/\/+$/, "");
  if (next.host && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(next.host)) throw new Error("Hôte PostHog invalide (ex. https://eu.i.posthog.com)");
  if (next.enabled && !next.apiKey) throw new Error("Renseignez la clé de projet (phc_...) pour activer PostHog");
  if (!db.platform) db.platform = {};
  db.platform.posthog = next;
  return next;
}

module.exports = { cfg, active, publicConfig, cspOrigins, capture, test, save, status, assetsHost };
