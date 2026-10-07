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
const insurance = require("./insurance");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const REQ_DIR = path.join(__dirname, "..", "..", "uploads", "requests");
fs.mkdirSync(REQ_DIR, { recursive: true });
const reqUpload = multer({
  storage: multer.diskStorage({ destination: REQ_DIR, filename: (q, f, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${(f.originalname || "doc").replace(/[^\w.\-]/g, "_")}`) }),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const ATT_DIR = path.join(__dirname, "..", "..", "uploads", "attendance");
fs.mkdirSync(ATT_DIR, { recursive: true });
const attUpload = multer({
  storage: multer.diskStorage({ destination: ATT_DIR, filename: (q, f, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`) }),
  limits: { fileSize: 8 * 1024 * 1024 },
});
function attSelfieRequired(tid) { const t = (db.tenants || []).find(x => x.id === (tid || "t1")); return !!(t && t.attSelfieRequired); }

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
  // Platform maintenance: block the employee API while active (the public /maintenance status stays open).
  try {
    const ms = require("./tenants").maintenanceState();
    if (ms && ms.active) return res.status(503).json({ error: ms.message || "Application en maintenance", maintenance: ms });
  } catch (e) {}
  next();
}
function empName(e) { return `${(e && e.firstName) || ""} ${(e && e.lastName) || ""}`.trim(); }
function empPortfolio(e) { return (db.portfolios || []).find(p => p.id === (e && e.portfolioId)); }

/* ============================ MAINTENANCE (public, no auth) ============================ */
router.get("/maintenance", (req, res) => {
  try { res.json(require("./tenants").maintenanceState()); }
  catch (e) { res.json({ active: false, upcoming: false, message: "", scheduledStart: null, scheduledEnd: null }); }
});

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
  // Supervisor = explicit supervisorId, else the GPF managing this employee's portefeuille.
  let sup = e.supervisorId ? (db.users || []).find(u => u.id === e.supervisorId) : null;
  if (!sup) sup = (db.users || []).find(u => u.role === "GPF" && u.active !== false && Array.isArray(u.portfolioIds) && u.portfolioIds.includes(e.portfolioId));
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
    leave_balance_days: (function () { try { return require("./hr").leaveBalance(e).remaining; } catch (x) { return e.leaveBalance != null ? e.leaveBalance : null; } })(),
    latest_payslip: payslips[0] ? { id: payslips[0].id, period: payslips[0].period } : null,
    notifications_unread: notifs.filter(n => !n.read).length,
    selfie_required: attSelfieRequired(req.emp.tenantId),
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
router.post("/me/attendance/check-in", empAuth, attUpload.single("photo"), (req, res) => {
  if (attSelfieRequired(req.emp.tenantId) && !req.file) return res.status(200).json({ success: false, reason: "SELFIE_REQUIRED", message: "Un selfie est requis pour pointer." });
  const out = recordAttendance(req, "IN", req.body || {});
  if (out.reject) return res.status(200).json({ success: false, reason: out.reason, message: out.message });
  if (req.file && out.rec) out.rec.photo = req.file.filename;
  save();
  res.status(out.dedup ? 200 : 201).json(Object.assign({ success: true, deduplicated: !!out.dedup }, attOut(out.rec, req)));
});
router.post("/me/attendance/check-out", empAuth, attUpload.single("photo"), (req, res) => {
  if (attSelfieRequired(req.emp.tenantId) && !req.file) return res.status(200).json({ success: false, reason: "SELFIE_REQUIRED", message: "Un selfie est requis pour pointer." });
  const out = recordAttendance(req, "OUT", req.body || {});
  if (out.reject) return res.status(200).json({ success: false, reason: out.reason, message: out.message });
  if (req.file && out.rec) out.rec.photo = req.file.filename;
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

/* ============================ LEAVE (shared with web congés) ============================ */
function leaveDocStatus(doc) {
  const s = doc.status || "";
  if (s === "GENERATED" || s === "VALIDATED" || s === "APPROVED") return "APPROVED";
  if (s === "REJECTED" || s === "DRAFT") return "REJECTED";
  return "PENDING";
}
router.get("/me/leave", empAuth, (req, res) => {
  const e = empOf(req.emp.account) || {};
  let balance = null;
  try { balance = require("./hr").leaveBalance(e); } catch (x) {}
  const docs = (db.documents || []).filter(d => (d.tenantId || "t1") === req.emp.tenantId && d.type === "LEAVE" && d.refId === e.id)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  res.json({
    balance_days: balance ? balance.remaining : (e.leaveBalance != null ? e.leaveBalance : null),
    balance: balance ? { accrued: balance.accrued, taken: balance.taken, remaining: balance.remaining, annual: balance.annualEntitlement } : null,
    requests: docs.map(d => ({ id: d.id, type: (d.data && d.data.leaveType) || "Congé", start: (d.data && d.data.startDate) || "", end: (d.data && d.data.endDate) || "", days: (d.data && d.data.days) || 0, comment: (d.data && d.data.reason) || "", status: leaveDocStatus(d), created_at: d.createdAt })),
  });
});
router.post("/me/leave", empAuth, (req, res) => {
  const e = empOf(req.emp.account);
  if (!e) return res.status(404).json({ error: "Employé introuvable" });
  const b = req.body || {};
  let r;
  try { r = require("./hr").submitLeaveDoc(e, { leaveType: b.type || "Congé annuel", startDate: b.start, endDate: b.end, reason: b.comment }, { tenantId: req.emp.tenantId }); }
  catch (x) { return res.status(500).json({ error: "Service congés indisponible" }); }
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.status(201).json({ id: r.doc.id, status: "PENDING", days: r.doc.data.days });
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

/* ============================ ASSURANCE MALADIE ============================ */
router.get("/me/insurance", empAuth, (req, res) => {
  insurance.ensure();
  const e = empOf(req.emp.account) || {};
  const pf = empPortfolio(e);
  const ins = pf && pf.insurance;
  const company = ins && ins.companyId ? (db.insuranceCompanies || []).find(c => c.id === ins.companyId) : null;
  const deps = (db.dependents || []).filter(d => (d.tenantId || "t1") === req.emp.tenantId && d.employeeId === e.id);
  const activeChildren = deps.filter(d => d.relation === "CHILD" && d.status === "ACTIVE").length;
  res.json({
    covered: !!ins,
    company: company ? { name: company.name, phone: company.phone || "", email: company.email || "" } : null,
    coverage_pct: ins ? ins.coveragePct : null,
    free_children: ins ? (ins.freeChildren || 0) : 0,
    active_children: activeChildren,
    can_add_spouse: !!(ins && ins.eligSpouse),
    can_add_child: !!(ins && ins.eligChildren),
    dependents: deps.map(d => ({ id: d.id, relation: d.relation, first_name: d.firstName, last_name: d.lastName, birth_date: d.birthDate || "", birth_place: d.birthPlace || "", status: d.status, extra: !!d.extra, note: d.note || "" })),
  });
});
router.get("/me/insurance/network", empAuth, (req, res) => {
  insurance.ensure();
  const e = empOf(req.emp.account) || {};
  const pf = empPortfolio(e); const ins = pf && pf.insurance;
  const companyId = ins ? ins.companyId : null;
  let list = (db.insuranceNetwork || []).filter(n => (n.tenantId || "t1") === req.emp.tenantId);
  if (companyId) list = list.filter(n => n.companyId === companyId || !n.companyId);
  const q = (req.query.q || "").toString().toLowerCase();
  if (q) list = list.filter(n => (n.name || "").toLowerCase().includes(q) || (n.ville || "").toLowerCase().includes(q) || (n.address || "").toLowerCase().includes(q) || (n.region || "").toLowerCase().includes(q));
  list = list.sort((a, b) => String(a.region || "").localeCompare(String(b.region || "")) || String(a.ville || "").localeCompare(String(b.ville || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  res.json(list.slice(0, 2000).map(n => ({ id: n.id, region: n.region || "", ville: n.ville || "", type: n.type || "", name: n.name || "", category: n.category || "", address: n.address || "", phone: n.phone || "", lat: n.lat, lng: n.lng })));
});
router.get("/me/insurance/consumption", empAuth, (req, res) => {
  insurance.ensure();
  const e = empOf(req.emp.account) || {};
  const mat = (e.matricule || "").toLowerCase();
  let list = mat ? (db.insuranceConsumption || []).filter(x => (x.tenantId || "t1") === req.emp.tenantId && (x.matricule || "").toLowerCase() === mat) : [];
  list = list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const totals = list.reduce((s, x) => { s.amount += Number(x.amount) || 0; s.covered += Number(x.covered) || 0; s.ticket += Number(x.ticket) || 0; return s; }, { amount: 0, covered: 0, ticket: 0 });
  res.json({ totals, items: list.slice(0, 1000).map(x => ({ date: x.date || "", mode: x.mode || "", beneficiary: x.beneficiary || "", filiation: x.filiation || "", provider: x.provider || "", rubrique: x.rubrique || "", amount: x.amount || 0, rate: x.rate || "", covered: x.covered || 0, ticket: x.ticket || 0 })) });
});
router.post("/me/insurance/dependent-request", empAuth, insurance.depUpload.any(), (req, res) => {
  insurance.ensure();
  const e = empOf(req.emp.account) || {};
  const pf = empPortfolio(e); const ins = pf && pf.insurance;
  if (!ins) return res.status(400).json({ error: "Aucune couverture d'assurance active pour votre portefeuille." });
  const b = req.body || {};
  const relation = b.relation === "SPOUSE" ? "SPOUSE" : "CHILD";
  if (relation === "SPOUSE" && !ins.eligSpouse) return res.status(400).json({ error: "Le conjoint n'est pas éligible dans votre portefeuille." });
  if (relation === "CHILD" && !ins.eligChildren) return res.status(400).json({ error: "Les enfants ne sont pas éligibles dans votre portefeuille." });
  if (!b.firstName || !b.lastName) return res.status(400).json({ error: "Nom et prénom requis." });
  const docs = (req.files || []).map(f => ({ type: f.fieldname || "AUTRE", fileName: f.originalname, storedAs: f.filename }));
  const activeChildren = (db.dependents || []).filter(d => (d.tenantId || "t1") === req.emp.tenantId && d.employeeId === e.id && d.relation === "CHILD" && d.status === "ACTIVE").length;
  const extra = relation === "CHILD" && activeChildren >= (ins.freeChildren || 0);
  const d = stamp({ id: id("dep"), employeeId: e.id, relation, firstName: String(b.firstName).trim(), lastName: String(b.lastName).trim(), birthDate: b.birthDate || "", birthPlace: b.birthPlace || "", status: "PENDING", extra, source: "MOBILE", documents: docs, createdAt: now() }, { user: { tenantId: req.emp.tenantId } });
  db.dependents.push(d); save();
  res.status(201).json({ ok: true, id: d.id, status: "PENDING", extra });
});

/* ============================ DEMANDES (AVI / ACOMPTE) ============================ */
router.post("/me/requests/avi", empAuth, reqUpload.single("letter"), (req, res) => {
  db.empRequests = db.empRequests || [];
  if (!req.file) return res.status(400).json({ error: "La lettre de demande manuscrite (photo ou scan) est requise." });
  const b = req.body || {};
  const r = stamp({ id: id("ereq"), employeeId: req.emp.employeeId, type: "AVI", status: "PENDING",
    bankName: String(b.bankName || "").trim(), reason: String(b.reason || b.purpose || "").slice(0, 500),
    attachment: { fileName: req.file.originalname, storedAs: req.file.filename }, createdAt: now() }, { user: { tenantId: req.emp.tenantId } });
  db.empRequests.push(r); save();
  res.status(201).json({ ok: true, id: r.id, status: "PENDING" });
});
function acompteDeadlineDay(tid) { const t = (db.tenants || []).find(x => x.id === (tid || "t1")); const d = t && parseInt(t.acompteDeadlineDay, 10); return (d >= 1 && d <= 28) ? d : 12; }
router.get("/me/acompte-window", empAuth, (req, res) => {
  const dd = acompteDeadlineDay(req.emp.tenantId); const today = new Date().getDate();
  res.json({ deadline_day: dd, today, open: today <= dd, period: new Date().toISOString().slice(0, 7) });
});
router.post("/me/requests/acompte", empAuth, (req, res) => {
  db.empRequests = db.empRequests || [];
  const dd = acompteDeadlineDay(req.emp.tenantId);
  if (new Date().getDate() > dd) return res.status(400).json({ error: `Les acomptes ne sont acceptés que du 1er au ${dd} du mois. La période est fermée.` });
  const b = req.body || {};
  const amount = Math.round(Number(b.amount) || 0);
  if (!(amount > 0)) return res.status(400).json({ error: "Montant invalide." });
  const r = stamp({ id: id("ereq"), employeeId: req.emp.employeeId, type: "ACOMPTE", status: "PENDING",
    amount, period: new Date().toISOString().slice(0, 7), reason: String(b.reason || "").slice(0, 500), createdAt: now() }, { user: { tenantId: req.emp.tenantId } });
  db.empRequests.push(r); save();
  res.status(201).json({ ok: true, id: r.id, status: "PENDING" });
});
router.get("/me/requests", empAuth, (req, res) => {
  const list = (db.empRequests || []).filter(r => (r.tenantId || "t1") === req.emp.tenantId && r.employeeId === req.emp.employeeId)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  res.json(list.map(r => ({ id: r.id, type: r.type, status: r.status, amount: r.amount || null, reason: r.reason || "", bank_name: r.bankName || "", decision_note: r.decisionNote || "", created_at: r.createdAt, has_attachment: !!r.attachment })));
});

/* ============================ ENQUÊTES SALARIÉ ============================ */
router.get("/me/surveys", empAuth, (req, res) => {
  const list = (db.smqEvalForms || []).filter(f => (f.tenantId || "t1") === req.emp.tenantId && f.type === "employee" && f.active !== false);
  res.json(list.map(f => ({ id: f.id, token: f.token, title: f.title || "Enquête", intro: f.intro || "", scale_max: Number(f.scaleMax) || 5,
    questions: (f.questions || []).map(q => ({ id: q.id, label: q.label, kind: q.kind })) })));
});
router.post("/me/surveys/:token/respond", empAuth, (req, res) => {
  const f = (db.smqEvalForms || []).find(x => x.token === req.params.token && (x.tenantId || "t1") === req.emp.tenantId && x.type === "employee" && x.active !== false);
  if (!f) return res.status(404).json({ error: "Enquête introuvable ou clôturée" });
  const e = empOf(req.emp.account) || {};
  const b = req.body || {};
  const r = require("./smq").publicEvalSubmit(f.token, { answers: b.answers, comment: b.comment, targetName: b.targetName, respondentName: b.anonymous ? "" : empName(e) });
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.json({ ok: true });
});

/* ============================ ASTUCES RH ============================ */
router.get("/me/tips", empAuth, (req, res) => {
  const reads = new Set((db.hrTipReads || []).filter(r => (r.tenantId || "t1") === req.emp.tenantId && r.employeeId === req.emp.employeeId).map(r => r.tipId));
  const list = (db.hrTips || []).filter(t => (t.tenantId || "t1") === req.emp.tenantId && t.active !== false)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  res.json(list.map(t => ({ id: t.id, title: t.title, body: t.body, author: t.author || "", created_at: t.createdAt, read: reads.has(t.id) })));
});
router.post("/me/tips/:id/read", empAuth, (req, res) => {
  db.hrTipReads = db.hrTipReads || [];
  const tip = (db.hrTips || []).find(t => t.id === req.params.id && (t.tenantId || "t1") === req.emp.tenantId);
  if (!tip) return res.status(404).json({ error: "Astuce introuvable" });
  const exists = db.hrTipReads.find(r => (r.tenantId || "t1") === req.emp.tenantId && r.tipId === req.params.id && r.employeeId === req.emp.employeeId);
  if (!exists) { db.hrTipReads.push({ id: id("tipr"), tenantId: req.emp.tenantId, tipId: req.params.id, employeeId: req.emp.employeeId, at: now() }); save(); }
  res.json({ ok: true });
});

module.exports = router;
module.exports.empAuth = empAuth;
