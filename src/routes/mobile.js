/**
 * SGRHP — Mobile employee API (/api/v1). Employee self-service for the HR Employee
 * Portal Android/iOS app: auth (JWT + rotating refresh), profile, sites/geofence,
 * GPS attendance (server-authoritative timestamp, idempotent, offline sync), leave
 * requests, payslips, notifications. Employees are provisioned by HR (see mobileAdmin).
 */
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { db, save, id, mine, stamp } = require("../store");
const { hash, verifyPw, SECRET } = require("../auth");

const ACCESS_TTL = "30m";
const REFRESH_DAYS = 30;
const now = () => new Date().toISOString();
const R2 = (n) => Math.round(Number(n) || 0);

/* ---------- helpers ---------- */
function empScoped(col, tenantId) { return (db[col] || []).filter(x => (x.tenantId || "t1") === tenantId); }
function accountByLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  return (db.empAccounts || []).find(a => String(a.login || "").toLowerCase() === l && a.active !== false);
}
function empOf(account) { return (db.employees || []).find(e => e.id === account.employeeId); }
function tenantOf(tid) { return (db.tenants || []).find(t => t.id === (tid || "t1")) || { id: tid, name: "" }; }
function signAccess(account) {
  return jwt.sign({ accountId: account.id, employeeId: account.employeeId, tenantId: account.tenantId || "t1", kind: "employee" }, SECRET, { expiresIn: ACCESS_TTL });
}
function newRefresh(account, deviceId) {
  const token = crypto.randomBytes(32).toString("hex");
  const rec = stamp({ id: id("sess"), accountId: account.id, employeeId: account.employeeId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    deviceId: deviceId || "", createdAt: now(), expiresAt: new Date(Date.now() + REFRESH_DAYS * 864e5).toISOString(), revoked: false }, { user: { tenantId: account.tenantId } });
  db.empSessions.push(rec); return token;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
/* Employee auth middleware */
function empAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: "Jeton manquant" });
  let p; try { p = jwt.verify(tok, SECRET); } catch (e) { return res.status(401).json({ error: "Session expirée" }); }
  if (p.kind !== "employee") return res.status(403).json({ error: "Jeton non valide pour l'application employé" });
  const account = (db.empAccounts || []).find(a => a.id === p.accountId && a.active !== false);
  if (!account) return res.status(401).json({ error: "Compte introuvable" });
  req.emp = { accountId: account.id, employeeId: account.employeeId, tenantId: account.tenantId || "t1", account };
  next();
}
function empName(e) { return `${(e && e.firstName) || ""} ${(e && e.lastName) || ""}`.trim(); }

/* ============================ AUTH ============================ */
router.post("/auth/login", (req, res) => {
  const { login, password, deviceId } = req.body || {};
  const account = accountByLogin(login);
  if (!account || !verifyPw(password || "", account.password || "")) return res.status(401).json({ error: "Identifiants incorrects" });
  const emp = empOf(account);
  const access = signAccess(account);
  const refresh = newRefresh(account, deviceId);
  save();
  res.json({ access_token: access, refresh_token: refresh, must_change_password: !!account.mustChangePwd,
    employee: { id: account.employeeId, name: empName(emp), matricule: (emp && emp.matricule) || "", company: tenantOf(account.tenantId).name } });
});
router.post("/auth/refresh", (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: "refresh_token requis" });
  const th = crypto.createHash("sha256").update(refresh_token).digest("hex");
  const sess = (db.empSessions || []).find(s => s.tokenHash === th && !s.revoked);
  if (!sess || new Date(sess.expiresAt) < new Date()) return res.status(401).json({ error: "Session expirée, reconnectez-vous" });
  const account = (db.empAccounts || []).find(a => a.id === sess.accountId && a.active !== false);
  if (!account) return res.status(401).json({ error: "Compte introuvable" });
  // rotate
  sess.revoked = true;
  const refresh = newRefresh(account, sess.deviceId);
  save();
  res.json({ access_token: signAccess(account), refresh_token: refresh });
});
router.post("/auth/logout", empAuth, (req, res) => {
  for (const s of (db.empSessions || [])) if (s.accountId === req.emp.accountId && !s.revoked) s.revoked = true;
  save(); res.json({ ok: true });
});
router.post("/auth/password", empAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const a = req.emp.account;
  if (!a.mustChangePwd && !verifyPw(current_password || "", a.password || "")) return res.status(400).json({ error: "Mot de passe actuel incorrect" });
  if (String(new_password || "").length < 6) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères" });
  a.password = hash(new_password); a.mustChangePwd = false; save();
  res.json({ ok: true });
});

/* ============================ ME / DASHBOARD ============================ */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function attToday(req) {
  const t = todayStr();
  return empScoped("attendance", req.emp.tenantId).filter(a => a.employeeId === req.emp.employeeId && (a.serverTs || "").slice(0, 10) === t).sort((x, y) => (x.serverTs || "").localeCompare(y.serverTs || ""));
}
router.get("/me", empAuth, (req, res) => {
  const e = empOf(req.emp.account) || {};
  const t = tenantOf(req.emp.tenantId);
  const sup = (db.users || []).find(u => u.id === e.supervisorId);
  res.json({
    id: e.id, name: empName(e), matricule: e.matricule || "", position: (e.contract && e.contract.jobTitle) || (e.contract && e.contract.category) || "",
    department: (e.contract && e.contract.department) || "", company: t.name, companyLogo: t.branding && t.branding.appLogo || null,
    email: e.email || "", phone: e.phone || e.mobile || "", supervisor: sup ? (sup.fullName || "") : "",
    photo: e.photo || null,
  });
});
router.get("/me/dashboard", empAuth, (req, res) => {
  const e = empOf(req.emp.account) || {};
  const at = attToday(req);
  const lastIn = [...at].reverse().find(a => a.type === "IN");
  const lastOut = [...at].reverse().find(a => a.type === "OUT");
  const checkedIn = lastIn && (!lastOut || lastIn.serverTs > lastOut.serverTs);
  const payslips = mine(db.payslips, { user: { tenantId: req.emp.tenantId } }).filter(p => p.employeeId === req.emp.employeeId).sort((a, b) => (b.period || "").localeCompare(a.period || ""));
  const notifs = empScoped("notifications", req.emp.tenantId).filter(n => n.employeeId === req.emp.employeeId || !n.employeeId);
  res.json({
    greeting_name: (e.firstName || empName(e) || "").split(" ")[0],
    today: {
      status: checkedIn ? "CHECKED_IN" : (lastOut ? "CHECKED_OUT" : "NOT_CHECKED_IN"),
      check_in: lastIn ? lastIn.serverTs : null, check_out: lastOut ? lastOut.serverTs : null,
      site: lastIn ? (empScoped("sites", req.emp.tenantId).find(s => s.id === lastIn.siteId) || {}).name || "" : "",
    },
    leave_balance_days: e.leaveBalance != null ? e.leaveBalance : (e.solde_conge != null ? e.solde_conge : null),
    latest_payslip: payslips[0] ? { id: payslips[0].id, period: payslips[0].period } : null,
    notifications_unread: notifs.filter(n => !n.read).length,
  });
});

/* ============================ SITES / GEOFENCE ============================ */
router.get("/me/sites", empAuth, (req, res) => {
  const assigned = empScoped("siteAssignments", req.emp.tenantId).filter(a => a.employeeId === req.emp.employeeId).map(a => a.siteId);
  let sites = empScoped("sites", req.emp.tenantId).filter(s => s.active !== false);
  if (assigned.length) sites = sites.filter(s => assigned.includes(s.id));
  res.json(sites.map(s => ({ id: s.id, name: s.name, latitude: s.lat, longitude: s.lng, radius_m: s.radiusM || 100 })));
});

/* ============================ ATTENDANCE ============================ */
function platformAttCfg() { const p = db.platform || {}; return { accuracyMaxM: p.attAccuracyMaxM || 50, outsidePolicy: p.attOutsidePolicy || "EXCEPTION" }; }
function recordAttendance(req, type, body) {
  const cfg = platformAttCfg();
  const uuid = String(body.attendance_uuid || body.uuid || "").trim();
  // Idempotency: same uuid -> return the existing record.
  if (uuid) { const dup = empScoped("attendance", req.emp.tenantId).find(a => a.uuid === uuid); if (dup) return { dedup: true, rec: dup }; }
  const lat = Number(body.latitude), lng = Number(body.longitude), acc = Number(body.accuracy);
  const sites = empScoped("sites", req.emp.tenantId).filter(s => s.active !== false);
  let site = sites.find(s => s.id === body.site_id) || null;
  // distance to chosen (or nearest) site
  let distance = null, nearest = site;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    if (!site && sites.length) { let best = Infinity; for (const s of sites) { const d = haversine(lat, lng, s.lat, s.lng); if (d < best) { best = d; nearest = s; } } site = nearest; distance = best; }
    else if (site) distance = haversine(lat, lng, site.lat, site.lng);
  }
  const radius = site ? (site.radiusM || site.radiusM || 100) : 100;
  let status = "NORMAL", reason = "";
  if (!site) { status = "EXCEPTION"; reason = "NO_SITE"; }
  else if (Number.isFinite(acc) && acc > cfg.accuracyMaxM) { status = "EXCEPTION"; reason = "LOW_ACCURACY"; }
  else if (distance != null && distance > radius) {
    if (cfg.outsidePolicy === "BLOCK") return { reject: true, reason: "OUTSIDE_GEOFENCE", message: "Vous êtes en dehors de votre zone de travail autorisée." };
    status = "EXCEPTION"; reason = "OUTSIDE_GEOFENCE";
  }
  // check-in/out ordering sanity
  const at = attToday(req);
  const lastIn = [...at].reverse().find(a => a.type === "IN"), lastOut = [...at].reverse().find(a => a.type === "OUT");
  const checkedIn = lastIn && (!lastOut || lastIn.serverTs > lastOut.serverTs);
  if (type === "OUT" && !checkedIn) { status = "EXCEPTION"; reason = reason || "CHECKOUT_WITHOUT_CHECKIN"; }
  if (type === "IN" && checkedIn) { status = "EXCEPTION"; reason = reason || "DUPLICATE_CHECKIN"; }
  const rec = stamp({ id: id("att"), uuid: uuid || id("att"), employeeId: req.emp.employeeId, siteId: site ? site.id : "",
    type, serverTs: now(), clientTs: body.client_timestamp || null, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
    accuracy: Number.isFinite(acc) ? acc : null, distanceM: distance != null ? R2(distance) : null,
    deviceId: body.device_id || "", appVersion: body.app_version || "", status, exceptionReason: reason, createdAt: now() }, { user: { tenantId: req.emp.tenantId } });
  db.attendance.push(rec);
  return { rec, site };
}
function attOut(a, req) {
  const s = empScoped("sites", req.emp.tenantId).find(x => x.id === a.siteId);
  return { attendance_id: a.id, uuid: a.uuid, type: a.type, server_timestamp: a.serverTs, client_timestamp: a.clientTs,
    status: a.status === "NORMAL" ? (a.type === "IN" ? "CHECKED_IN" : "CHECKED_OUT") : a.status, exception_reason: a.exceptionReason || null,
    site: s ? { id: s.id, name: s.name } : null, accuracy: a.accuracy, distance_m: a.distanceM };
}
router.post("/me/attendance/check-in", empAuth, (req, res) => {
  const out = recordAttendance(req, "IN", req.body || {});
  if (out.reject) return res.status(200).json({ success: false, reason: out.reason, message: out.message });
  save();
  res.status(out.dedup ? 200 : 201).json(Object.assign({ success: true, deduplicated: !!out.dedup }, attOut(out.rec, req)));
});
router.post("/me/attendance/check-out", empAuth, (req, res) => {
  const out = recordAttendance(req, "OUT", req.body || {});
  if (out.reject) return res.status(200).json({ success: false, reason: out.reason, message: out.message });
  save();
  res.status(out.dedup ? 200 : 201).json(Object.assign({ success: true, deduplicated: !!out.dedup }, attOut(out.rec, req)));
});
router.get("/me/attendance", empAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(100, Number(req.query.size) || 30);
  const all = empScoped("attendance", req.emp.tenantId).filter(a => a.employeeId === req.emp.employeeId).sort((x, y) => (y.serverTs || "").localeCompare(x.serverTs || ""));
  // group by day into in/out pairs
  const byDay = {};
  for (const a of all) { const d = (a.serverTs || "").slice(0, 10); (byDay[d] = byDay[d] || []).push(a); }
  const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a));
  const slice = days.slice((page - 1) * size, page * size).map(d => {
    const list = byDay[d].sort((x, y) => (x.serverTs || "").localeCompare(y.serverTs || ""));
    const cin = list.find(a => a.type === "IN"), cout = [...list].reverse().find(a => a.type === "OUT");
    let dur = null; if (cin && cout) dur = Math.max(0, new Date(cout.serverTs) - new Date(cin.serverTs));
    const site = empScoped("sites", req.emp.tenantId).find(s => s.id === (cin || list[0]).siteId);
    const anyExc = list.some(a => a.status === "EXCEPTION");
    return { date: d, check_in: cin ? cin.serverTs : null, check_out: cout ? cout.serverTs : null,
      site: site ? site.name : "", duration_ms: dur, status: anyExc ? "EXCEPTION" : "NORMAL",
      exception_reason: (list.find(a => a.exceptionReason) || {}).exceptionReason || null };
  });
  res.json({ page, size, total_days: days.length, days: slice });
});
/* Batch offline sync (idempotent by uuid) */
router.post("/me/sync", empAuth, (req, res) => {
  const items = Array.isArray(req.body && req.body.attendance) ? req.body.attendance : [];
  const results = [];
  for (const it of items) {
    const type = (it.type || "IN").toUpperCase() === "OUT" ? "OUT" : "IN";
    const out = recordAttendance(req, type, it);
    if (out.reject) results.push({ uuid: it.attendance_uuid || it.uuid, success: false, reason: out.reason });
    else results.push(Object.assign({ success: true, deduplicated: !!out.dedup }, attOut(out.rec, req)));
  }
  save();
  res.json({ synced: results.filter(r => r.success).length, results });
});

/* ============================ LEAVE ============================ */
router.get("/me/leave", empAuth, (req, res) => {
  const e = empOf(req.emp.account) || {};
  const list = empScoped("leaveRequests", req.emp.tenantId).filter(l => l.employeeId === req.emp.employeeId).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json({ balance_days: e.leaveBalance != null ? e.leaveBalance : (e.solde_conge != null ? e.solde_conge : null),
    requests: list.map(l => ({ id: l.id, type: l.type, start: l.start, end: l.end, days: l.days, comment: l.comment || "", status: l.status, created_at: l.createdAt })) });
});
router.post("/me/leave", empAuth, (req, res) => {
  const b = req.body || {};
  if (!b.start || !b.end) return res.status(400).json({ error: "Dates de début et de fin requises" });
  const days = Math.max(1, Math.round((new Date(b.end) - new Date(b.start)) / 864e5) + 1);
  const rec = stamp({ id: id("lvr"), employeeId: req.emp.employeeId, type: b.type || "Congé annuel",
    start: b.start, end: b.end, days, comment: String(b.comment || "").slice(0, 500), status: "PENDING", createdAt: now() }, { user: { tenantId: req.emp.tenantId } });
  db.leaveRequests.push(rec); save();
  res.status(201).json({ id: rec.id, status: rec.status, days });
});

/* ============================ PAYSLIPS ============================ */
router.get("/me/payslips", empAuth, (req, res) => {
  const list = mine(db.payslips, { user: { tenantId: req.emp.tenantId } }).filter(p => p.employeeId === req.emp.employeeId && p.status === "CLOSED")
    .sort((a, b) => (b.period || "").localeCompare(a.period || ""));
  res.json(list.map(p => ({ id: p.id, period: p.period, net: p.result && p.result.totals ? R2(p.result.totals.netAPayer) : null, available: true })));
});
router.get("/me/payslips/:id/pdf", empAuth, (req, res) => {
  const p = mine(db.payslips, { user: { tenantId: req.emp.tenantId } }).find(x => x.id === req.params.id && x.employeeId === req.emp.employeeId);
  if (!p) return res.status(404).json({ error: "Bulletin introuvable" });
  // Reuse the payroll payslip PDF generator via internal require
  try {
    const emp = empOf(req.emp.account); const tenant = tenantOf(req.emp.tenantId);
    const pay = require("./payroll");
    if (pay && typeof pay.payslipBuffer === "function") {
      return pay.payslipBuffer(p, emp, tenant).then(buf => {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="Bulletin_${p.period}.pdf"`);
        res.end(buf);
      }).catch(() => res.status(500).json({ error: "Erreur PDF" }));
    }
  } catch (e) {}
  res.status(501).json({ error: "Génération PDF indisponible" });
});

/* ============================ NOTIFICATIONS ============================ */
router.get("/me/notifications", empAuth, (req, res) => {
  const list = empScoped("notifications", req.emp.tenantId).filter(n => n.employeeId === req.emp.employeeId || !n.employeeId)
    .sort((a, b) => (b.createdAt || b.at || "").localeCompare(a.createdAt || a.at || "")).slice(0, 100);
  res.json(list.map(n => ({ id: n.id, title: n.title || n.type || "Notification", body: n.body || n.message || "", type: n.type || "SYSTEM", read: !!n.read, created_at: n.createdAt || n.at })));
});
router.post("/me/notifications/read-all", empAuth, (req, res) => {
  for (const n of empScoped("notifications", req.emp.tenantId)) if (n.employeeId === req.emp.employeeId) n.read = true;
  save(); res.json({ ok: true });
});

/* ============================ DEVICE REGISTRATION ============================ */
router.post("/devices/register", empAuth, (req, res) => {
  const b = req.body || {};
  let d = empScoped("empDevices", req.emp.tenantId).find(x => x.employeeId === req.emp.employeeId && x.deviceId === b.device_id);
  if (!d) { d = stamp({ id: id("dev"), employeeId: req.emp.employeeId, deviceId: b.device_id || "", createdAt: now() }, { user: { tenantId: req.emp.tenantId } }); db.empDevices.push(d); }
  d.fcmToken = b.fcm_token || d.fcmToken; d.os = b.os || d.os; d.appVersion = b.app_version || d.appVersion; d.lastSeen = now();
  save(); res.json({ ok: true, device_id: d.deviceId });
});

module.exports = router;
module.exports.empAuth = empAuth;
