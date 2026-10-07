/**
 * Push notifications via Firebase Cloud Messaging (FCM).
 *
 * Fully optional and self-disabling: if no Firebase service account is configured
 * (FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS env pointing to the
 * JSON key), every call is a safe no-op — the app runs normally without push.
 *
 * Device tokens are collected by POST /api/v1/devices/register (empDevices.fcmToken).
 */
let admin = null, inited = false, enabled = false;

function init() {
  if (inited) return enabled;
  inited = true;
  try {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!saPath) { console.log("[push] FCM not configured (no service account) — notifications disabled."); return (enabled = false); }
    admin = require("firebase-admin");
    const sa = require(require("path").resolve(saPath));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    enabled = true;
    console.log("[push] FCM enabled.");
  } catch (e) {
    console.warn("[push] disabled:", e.message);
    enabled = false;
  }
  return enabled;
}

function tokensFor(db, tenantId, employeeIds) {
  const set = employeeIds ? new Set(employeeIds) : null;
  return [...new Set((db.empDevices || [])
    .filter(d => (d.tenantId || "t1") === (tenantId || "t1") && d.fcmToken && (!set || set.has(d.employeeId)))
    .map(d => d.fcmToken))];
}

/** Send a notification to specific employees (employeeIds=null => all employees of the tenant). */
async function send(db, tenantId, employeeIds, title, body, data) {
  try {
    if (!init()) return false;
    const tokens = tokensFor(db, tenantId, employeeIds);
    if (!tokens.length) return false;
    const message = {
      notification: { title: String(title || ""), body: String(body || "") },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
      tokens,
    };
    const res = await admin.messaging().sendEachForMulticast(message);
    return res.successCount;
  } catch (e) {
    console.warn("[push] send failed:", e.message);
    return false;
  }
}

module.exports = { init, send };
