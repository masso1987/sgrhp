/**
 * SGRHP — Mobile admin API (staff side). Under /api (staff JWT). Lets HR provision
 * employee app accounts, configure work sites & geofences, assign employees to sites,
 * and review GPS attendance & exceptions from the mobile app.
 */
const router = require("express").Router();
const crypto = require("crypto");
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
const { hash } = require("../auth");
const path = require("path");
const now = () => new Date().toISOString();
const REQ_DIR = path.join(__dirname, "..", "..", "uploads", "requests");
const ATT_DIR = path.join(__dirname, "..", "..", "uploads", "attendance");

/* ---- Work schedule (per portefeuille) + pointage treatment ---- */
const DEFAULT_SCHEDULE = { startTime: "08:00", endTime: "17:30", breakMinutes: 90, dailyHours: 8, paysOvertime: false };
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN || 60); // WAT (UTC+1) by default
function hmToMin(s) { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "")); return m ? (Number(m[1]) * 60 + Number(m[2])) : 0; }
function localMinOfDay(iso) { const d = new Date(new Date(iso).getTime() + TZ_OFFSET_MIN * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function schedOf(pf) {
  const w = (pf && pf.workSchedule) || {};
  return {
    startTime: w.startTime || DEFAULT_SCHEDULE.startTime,
    endTime: w.endTime || DEFAULT_SCHEDULE.endTime,
    breakMinutes: w.breakMinutes != null ? w.breakMinutes : DEFAULT_SCHEDULE.breakMinutes,
    dailyHours: w.dailyHours != null ? w.dailyHours : DEFAULT_SCHEDULE.dailyHours,
    paysOvertime: !!w.paysOvertime,
  };
}

/* ---------------- Employee app-account provisioning ---------------- */
router.get("/employees/:eid/app-account", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const acc = mine(db.empAccounts, req).find(a => a.employeeId === req.params.eid);
  if (!acc) return res.json({ provisioned: false });
  res.json({ provisioned: true, login: acc.login, active: acc.active !== false, mustChangePwd: !!acc.mustChangePwd, createdAt: acc.createdAt });
});
router.post("/employees/:eid/app-account", allow("GPF", "ADM"), (req, res) => {
  const emp = mine(db.employees, req).find(e => e.id === req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employé introuvable" });
  if (mine(db.empAccounts, req).some(a => a.employeeId === emp.id)) return res.status(409).json({ error: "Compte déjà provisionné" });
  const login = (req.body && req.body.login) || emp.matricule || emp.email || ("EMP" + emp.id.slice(-5));
  if (mine(db.empAccounts, req).some(a => String(a.login).toLowerCase() === String(login).toLowerCase())) return res.status(409).json({ error: "Cet identifiant existe déjà" });
  const tempPwd = (req.body && req.body.password) || crypto.randomBytes(4).toString("hex"); // 8 hex chars
  const acc = stamp({ id: id("acc"), employeeId: emp.id, login: String(login), password: hash(tempPwd), mustChangePwd: true, active: true, createdBy: req.user.id, createdAt: now() }, req);
  db.empAccounts.push(acc); save();
  audit(req.user, "PROVISIONED", "EmpAccount", acc.id, { employeeId: emp.id, login: acc.login });
  res.status(201).json({ ok: true, login: acc.login, temporary_password: tempPwd, note: "Communiquez ces identifiants à l'employé. Il devra changer le mot de passe à la première connexion." });
});
router.post("/employees/:eid/app-account/reset", allow("GPF", "ADM"), (req, res) => {
  const acc = mine(db.empAccounts, req).find(a => a.employeeId === req.params.eid);
  if (!acc) return res.status(404).json({ error: "Compte non provisionné" });
  const tempPwd = crypto.randomBytes(4).toString("hex");
  acc.password = hash(tempPwd); acc.mustChangePwd = true; acc.active = true;
  for (const s of (db.empSessions || [])) if (s.accountId === acc.id) s.revoked = true; // revoke sessions
  save(); audit(req.user, "RESET_PWD", "EmpAccount", acc.id, {});
  res.json({ ok: true, login: acc.login, temporary_password: tempPwd });
});
router.delete("/employees/:eid/app-account", allow("GPF", "ADM"), (req, res) => {
  const acc = mine(db.empAccounts, req).find(a => a.employeeId === req.params.eid);
  if (!acc) return res.status(404).json({ error: "Compte non provisionné" });
  acc.active = false; for (const s of (db.empSessions || [])) if (s.accountId === acc.id) s.revoked = true;
  save(); audit(req.user, "DEACTIVATED", "EmpAccount", acc.id, {});
  res.json({ ok: true });
});

/* ---------------- Sites & geofences ---------------- */
router.get("/sites", allow("ADM"), (req, res) => {
  res.json(mine(db.sites, req).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(s => Object.assign({}, s,
    { assigned: mine(db.siteAssignments, req).filter(x => x.siteId === s.id).length })));
});
router.post("/sites", allow("ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.name || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lng))) return res.status(400).json({ error: "Nom, latitude et longitude requis" });
  const s = stamp({ id: id("site"), name: String(b.name), lat: Number(b.lat), lng: Number(b.lng), radiusM: Number(b.radiusM) || 100, active: b.active !== false, createdAt: now() }, req);
  db.sites.push(s); save(); audit(req.user, "CREATED", "Site", s.id, { name: s.name });
  res.status(201).json(s);
});
router.put("/sites/:id", allow("ADM"), (req, res) => {
  const s = mine(db.sites, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Site introuvable" });
  const b = req.body || {};
  if (b.name != null) s.name = String(b.name);
  if (b.lat != null && Number.isFinite(Number(b.lat))) s.lat = Number(b.lat);
  if (b.lng != null && Number.isFinite(Number(b.lng))) s.lng = Number(b.lng);
  if (b.radiusM != null) s.radiusM = Number(b.radiusM) || 100;
  if (b.active != null) s.active = !!b.active;
  save(); res.json(s);
});
router.delete("/sites/:id", allow("ADM"), (req, res) => {
  const s = mine(db.sites, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Introuvable" });
  db.sites.splice(db.sites.indexOf(s), 1);
  db.siteAssignments = db.siteAssignments.filter(a => a.siteId !== s.id);
  save(); res.json({ ok: true });
});
router.post("/sites/:id/assign", allow("ADM"), (req, res) => {
  const s = mine(db.sites, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Site introuvable" });
  const eid = req.body && req.body.employeeId; if (!eid) return res.status(400).json({ error: "employeeId requis" });
  if (mine(db.siteAssignments, req).some(a => a.siteId === s.id && a.employeeId === eid)) return res.json({ ok: true });
  db.siteAssignments.push(stamp({ id: id("sasg"), siteId: s.id, employeeId: eid, createdAt: now() }, req)); save();
  res.json({ ok: true });
});
router.delete("/sites/:id/assign/:eid", allow("ADM"), (req, res) => {
  db.siteAssignments = db.siteAssignments.filter(a => !((a.tenantId || "t1") === (req.user.tenantId || "t1") && a.siteId === req.params.id && a.employeeId === req.params.eid));
  save(); res.json({ ok: true });
});
/* Employees assigned to a site (for the web assignment manager). */
router.get("/sites/:id/assignments", allow("ADM"), (req, res) => {
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  const list = mine(db.siteAssignments, req).filter(a => a.siteId === req.params.id).map(a => {
    const e = empById[a.employeeId] || {};
    return { employeeId: a.employeeId, name: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "" };
  });
  res.json(list);
});

/* ---------------- Attendance selfie config + photo ---------------- */
router.get("/attendance-config", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const t = (db.tenants || []).find(x => x.id === (req.user.tenantId || "t1"));
  res.json({ selfieRequired: !!(t && t.attSelfieRequired) });
});
router.put("/attendance-config", allow("ADM"), (req, res) => {
  const t = (db.tenants || []).find(x => x.id === (req.user.tenantId || "t1"));
  if (!t) return res.status(404).json({ error: "Organisation introuvable" });
  t.attSelfieRequired = !!(req.body && req.body.selfieRequired); save();
  audit(req.user, "CONFIG_CHANGED", "Tenant", t.id, { attSelfieRequired: t.attSelfieRequired });
  res.json({ selfieRequired: t.attSelfieRequired });
});
router.get("/attendance/:id/photo", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const a = mine(db.attendance, req).find(x => x.id === req.params.id);
  if (!a || !a.photo) return res.status(404).json({ error: "Aucune photo" });
  res.sendFile(path.join(ATT_DIR, a.photo));
});

/* ---------------- Attendance review ---------------- */
router.get("/attendance/review", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const { from, to, status } = req.query;
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  const siteById = {}; mine(db.sites, req).forEach(s => { siteById[s.id] = s; });
  let list = mine(db.attendance, req);
  if (from) list = list.filter(a => (a.serverTs || "") >= from);
  if (to) list = list.filter(a => (a.serverTs || "") <= to + "T23:59:59");
  if (status) list = list.filter(a => a.status === status);
  list = list.sort((a, b) => (b.serverTs || "").localeCompare(a.serverTs || "")).slice(0, 500);
  res.json(list.map(a => { const e = empById[a.employeeId] || {}; const s = siteById[a.siteId] || {};
    return { id: a.id, employee: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "", type: a.type,
      server_ts: a.serverTs, received_ts: a.receivedTs || a.serverTs, client_ts: a.clientTs,
      time_source: a.timeSource || "SERVER", time_flag: a.timeFlag || null,
      site: s.name || "", lat: a.lat, lng: a.lng, accuracy: a.accuracy, distance_m: a.distanceM,
      status: a.status, exception_reason: a.exceptionReason || null, resolved: !!a.resolved, has_photo: !!a.photo }; }));
});
router.post("/attendance/:id/resolve", allow("GPF", "ADM", "CD"), (req, res) => {
  const a = mine(db.attendance, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  a.resolved = true; a.resolvedBy = req.user.id; a.resolvedAt = now(); a.resolveNote = String((req.body && req.body.note) || "").slice(0, 240);
  if (req.body && req.body.markNormal) a.status = "NORMAL";
  save(); audit(req.user, "RESOLVED", "Attendance", a.id, { reason: a.exceptionReason });
  res.json({ ok: true });
});
/* Edit / delete a raw pointage (GPF/ADM) — traced in the audit log. */
router.put("/attendance/:id", allow("GPF", "ADM", "CD"), (req, res) => {
  const a = mine(db.attendance, req).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Pointage introuvable" });
  const b = req.body || {};
  if (b.serverTs) { const d = new Date(b.serverTs); if (isNaN(d)) return res.status(400).json({ error: "Horodatage invalide" }); a.serverTs = d.toISOString(); }
  if (b.type && ["IN", "OUT"].includes(b.type)) a.type = b.type;
  if (b.status && ["NORMAL", "EXCEPTION"].includes(b.status)) a.status = b.status;
  a.editedBy = req.user.id; a.editedAt = now();
  save(); audit(req.user, "EDITED", "Attendance", a.id, { serverTs: a.serverTs, type: a.type });
  res.json({ ok: true });
});
router.delete("/attendance/:id", allow("GPF", "ADM", "CD"), (req, res) => {
  const a = mine(db.attendance, req).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Pointage introuvable" });
  db.attendance = db.attendance.filter(x => !((x.tenantId || "t1") === (req.user.tenantId || "t1") && x.id === req.params.id));
  save(); audit(req.user, "DELETED", "Attendance", a.id, {});
  res.json({ ok: true });
});

/* ---------------- Employee requests (AVI / acompte) from the mobile app ---------------- */
router.get("/emp-requests", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  const status = req.query.status;
  let list = (db.empRequests || []).filter(r => (r.tenantId || "t1") === (req.user.tenantId || "t1"));
  if (status) list = list.filter(r => r.status === status);
  if (req.query.type) list = list.filter(r => r.type === req.query.type);
  list = list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  res.json(list.map(r => { const e = empById[r.employeeId] || {};
    return { id: r.id, type: r.type, status: r.status, amount: r.amount || null, reason: r.reason || "", bankName: r.bankName || "",
      decisionNote: r.decisionNote || "", createdAt: r.createdAt, hasAttachment: !!r.attachment,
      employee: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "" }; }));
});
router.get("/emp-requests/:id/attachment", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const r = (db.empRequests || []).find(x => (x.tenantId || "t1") === (req.user.tenantId || "t1") && x.id === req.params.id);
  if (!r || !r.attachment) return res.status(404).json({ error: "Pièce introuvable" });
  res.download(path.join(REQ_DIR, r.attachment.storedAs), r.attachment.fileName);
});
router.post("/emp-requests/:id/handle", allow("GPF", "ADM", "CD"), (req, res) => {
  const r = (db.empRequests || []).find(x => (x.tenantId || "t1") === (req.user.tenantId || "t1") && x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Introuvable" });
  r.status = "HANDLED"; r.handledBy = req.user.id; r.handledAt = now(); r.decisionNote = String((req.body && req.body.note) || "").slice(0, 300);
  save(); audit(req.user, "HANDLED", "EmpRequest", r.id, { type: r.type });
  try { require("../push").send(db, req.user.tenantId, [r.employeeId], "Demande traitée", `Votre demande (${r.type === "AVI" ? "AVI" : "acompte"}) a été traitée.`, { type: "request", id: r.id }).catch(() => {}); } catch (e) {}
  res.json({ ok: true });
});
router.post("/emp-requests/:id/reject", allow("GPF", "ADM", "CD"), (req, res) => {
  const r = (db.empRequests || []).find(x => (x.tenantId || "t1") === (req.user.tenantId || "t1") && x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Introuvable" });
  r.status = "REJECTED"; r.handledBy = req.user.id; r.handledAt = now(); r.decisionNote = String((req.body && req.body.note) || "").slice(0, 300);
  save(); audit(req.user, "REJECTED", "EmpRequest", r.id, { type: r.type });
  try { require("../push").send(db, req.user.tenantId, [r.employeeId], "Demande rejetée", `Votre demande (${r.type === "AVI" ? "AVI" : "acompte"}) a été rejetée.`, { type: "request", id: r.id }).catch(() => {}); } catch (e) {}
  res.json({ ok: true });
});

/* ---------------- Astuces RH (HR tips feed for the mobile app) ---------------- */
router.get("/hr-tips", allow("GPF", "ADM", "CD", "RJ", "RQ", "UI"), (req, res) => {
  db.hrTips = db.hrTips || [];
  const readsByTip = {}; (db.hrTipReads || []).filter(r => (r.tenantId || "t1") === (req.user.tenantId || "t1")).forEach(r => { readsByTip[r.tipId] = (readsByTip[r.tipId] || 0) + 1; });
  res.json(mine(db.hrTips, req).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map(t => Object.assign({}, t, { readCount: readsByTip[t.id] || 0 })));
});
/* Who has opened a given astuce (GPF/RQ/ADM). */
router.get("/hr-tips/:id/reads", allow("GPF", "ADM", "RQ"), (req, res) => {
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  const list = (db.hrTipReads || []).filter(r => (r.tenantId || "t1") === (req.user.tenantId || "t1") && r.tipId === req.params.id)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  res.json(list.map(r => { const e = empById[r.employeeId] || {}; return { employee: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "", at: r.at }; }));
});
/* Acompte window (deadline day of month) — per tenant, admin-configurable. */
router.get("/acompte-config", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const t = (db.tenants || []).find(x => x.id === (req.user.tenantId || "t1"));
  const d = t && parseInt(t.acompteDeadlineDay, 10);
  res.json({ deadlineDay: (d >= 1 && d <= 28) ? d : 12 });
});
router.put("/acompte-config", allow("ADM"), (req, res) => {
  const t = (db.tenants || []).find(x => x.id === (req.user.tenantId || "t1"));
  if (!t) return res.status(404).json({ error: "Organisation introuvable" });
  const d = parseInt(req.body && req.body.deadlineDay, 10);
  if (!(d >= 1 && d <= 28)) return res.status(400).json({ error: "Le jour limite doit être compris entre 1 et 28." });
  t.acompteDeadlineDay = d; save(); audit(req.user, "CONFIG_CHANGED", "Tenant", t.id, { acompteDeadlineDay: d });
  res.json({ deadlineDay: d });
});
router.post("/hr-tips", allow("GPF", "ADM", "RQ"), (req, res) => {
  db.hrTips = db.hrTips || [];
  const b = req.body || {};
  if (!b.title || !b.body) return res.status(400).json({ error: "Titre et contenu requis." });
  const t = stamp({ id: id("tip"), title: String(b.title).slice(0, 160), body: String(b.body).slice(0, 8000), active: b.active !== false, author: req.user.fullName || req.user.email || "", createdAt: now() }, req);
  db.hrTips.push(t); save(); audit(req.user, "CREATED", "HrTip", t.id, {});
  if (t.active) try { require("../push").send(db, req.user.tenantId, null, "Nouvelle astuce RH", t.title, { type: "tip", id: t.id }).catch(() => {}); } catch (e) {}
  res.status(201).json(t);
});
router.put("/hr-tips/:id", allow("GPF", "ADM", "RQ"), (req, res) => {
  const t = mine(db.hrTips, req).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  if (b.title != null) t.title = String(b.title).slice(0, 160);
  if (b.body != null) t.body = String(b.body).slice(0, 8000);
  if (b.active != null) t.active = !!b.active;
  save(); res.json(t);
});
router.delete("/hr-tips/:id", allow("GPF", "ADM", "RQ"), (req, res) => {
  db.hrTips = (db.hrTips || []).filter(x => !((x.tenantId || "t1") === (req.user.tenantId || "t1") && x.id === req.params.id));
  save(); res.json({ ok: true });
});

/* ---------------- Work schedules (per portefeuille) ---------------- */
router.get("/work-schedules", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  res.json(mine(db.portfolios, req).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"))
    .map(p => Object.assign({ portfolioId: p.id, portfolioName: p.name }, schedOf(p))));
});
router.put("/work-schedules/:pid", allow("ADM"), (req, res) => {
  const p = mine(db.portfolios, req).find(x => x.id === req.params.pid);
  if (!p) return res.status(404).json({ error: "Portefeuille introuvable" });
  const b = req.body || {}; const w = p.workSchedule || {};
  if (b.startTime != null) w.startTime = String(b.startTime).slice(0, 5);
  if (b.endTime != null) w.endTime = String(b.endTime).slice(0, 5);
  if (b.breakMinutes != null) w.breakMinutes = Math.max(0, parseInt(b.breakMinutes, 10) || 0);
  if (b.dailyHours != null) w.dailyHours = Math.max(1, Math.min(24, Number(b.dailyHours) || 8));
  if (b.paysOvertime != null) w.paysOvertime = !!b.paysOvertime;
  p.workSchedule = w; save(); audit(req.user, "CONFIG_CHANGED", "Portfolio", p.id, { workSchedule: w });
  res.json(Object.assign({ portfolioId: p.id, portfolioName: p.name }, schedOf(p)));
});

/* ---------------- Pointage treatment: monthly presence per employee ----------------
 * A day counts as present only with a check-IN and a check-OUT. Early arrival adds no
 * hours (clamped to scheduled start); the break is deducted; overtime = hours past the
 * scheduled end, counted only for portefeuilles flagged paysOvertime. Read-only report
 * (GPF reviews/exports for the bordereau); does NOT write payroll. */
router.get("/attendance/treatment", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  const period = String(req.query.period || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "Période requise (AAAA-MM)." });
  const pfById = {}; mine(db.portfolios, req).forEach(p => { pfById[p.id] = p; });
  const empById = {}; mine(db.employees, req).forEach(e => { empById[e.id] = e; });
  const list = mine(db.attendance, req).filter(a => (a.serverTs || "").slice(0, 7) === period);
  const byEmp = {};
  for (const a of list) { const d = (a.serverTs || "").slice(0, 10); byEmp[a.employeeId] = byEmp[a.employeeId] || {}; (byEmp[a.employeeId][d] = byEmp[a.employeeId][d] || []).push(a); }
  const out = [];
  for (const eid of Object.keys(byEmp)) {
    const e = empById[eid] || {}; const sch = schedOf(pfById[e.portfolioId]);
    const sStart = hmToMin(sch.startTime), sEnd = hmToMin(sch.endTime);
    let presentDays = 0, incompleteDays = 0, exceptionDays = 0, workedMin = 0, otMin = 0;
    const days = byEmp[eid];
    for (const d of Object.keys(days)) {
      const punches = days[d].sort((x, y) => (x.serverTs || "").localeCompare(y.serverTs || ""));
      const cin = punches.find(p => p.type === "IN"); const cout = [...punches].reverse().find(p => p.type === "OUT");
      if (punches.some(p => p.status === "EXCEPTION" && !p.resolved)) exceptionDays++;
      if (cin && cout) {
        presentDays++;
        const inMin = localMinOfDay(cin.serverTs), outMin = localMinOfDay(cout.serverTs);
        const effStart = Math.max(inMin, sStart);
        if (sch.paysOvertime) {
          const net = Math.max(0, outMin - effStart - sch.breakMinutes);
          const reg = Math.min(net, sch.dailyHours * 60); const ot = Math.max(0, net - sch.dailyHours * 60);
          workedMin += reg + ot; otMin += ot;
        } else {
          const effEnd = Math.min(outMin, sEnd);
          workedMin += Math.max(0, effEnd - effStart - sch.breakMinutes);
        }
      } else { incompleteDays++; }
    }
    out.push({ employeeId: eid, employee: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "",
      portfolio: (pfById[e.portfolioId] || {}).name || "", paysOvertime: sch.paysOvertime,
      presentDays, incompleteDays, exceptionDays,
      workedHours: Math.round(workedMin / 6) / 10, otHours: Math.round(otMin / 6) / 10 });
  }
  out.sort((a, b) => String(a.employee).localeCompare(String(b.employee), "fr"));
  res.json({ period, scheduleDefault: DEFAULT_SCHEDULE, items: out });
});

/* ---------------- Generic Excel export (from a displayed table) ---------------- */
router.post("/export-xlsx", allow("GPF", "ADM", "CD", "RJ", "RQ", "UI", "SADM"), (req, res) => {
  const XLSX = require("xlsx");
  const b = req.body || {};
  const headers = Array.isArray(b.headers) ? b.headers : [];
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const name = String(b.filename || "export").replace(/[^\w.\-]/g, "_").slice(0, 60) || "export";
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), String(b.sheet || "Données").replace(/[^\w ]/g, "").slice(0, 28) || "Donnees");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

module.exports = router;
