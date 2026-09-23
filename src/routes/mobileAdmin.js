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
const now = () => new Date().toISOString();

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
router.get("/sites", allow("GPF", "ADM", "CD", "RJ"), (req, res) => {
  res.json(mine(db.sites, req).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(s => Object.assign({}, s,
    { assigned: mine(db.siteAssignments, req).filter(x => x.siteId === s.id).length })));
});
router.post("/sites", allow("GPF", "ADM"), (req, res) => {
  const b = req.body || {};
  if (!b.name || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lng))) return res.status(400).json({ error: "Nom, latitude et longitude requis" });
  const s = stamp({ id: id("site"), name: String(b.name), lat: Number(b.lat), lng: Number(b.lng), radiusM: Number(b.radiusM) || 100, active: b.active !== false, createdAt: now() }, req);
  db.sites.push(s); save(); audit(req.user, "CREATED", "Site", s.id, { name: s.name });
  res.status(201).json(s);
});
router.put("/sites/:id", allow("GPF", "ADM"), (req, res) => {
  const s = mine(db.sites, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Site introuvable" });
  const b = req.body || {};
  if (b.name != null) s.name = String(b.name);
  if (b.lat != null && Number.isFinite(Number(b.lat))) s.lat = Number(b.lat);
  if (b.lng != null && Number.isFinite(Number(b.lng))) s.lng = Number(b.lng);
  if (b.radiusM != null) s.radiusM = Number(b.radiusM) || 100;
  if (b.active != null) s.active = !!b.active;
  save(); res.json(s);
});
router.delete("/sites/:id", allow("GPF", "ADM"), (req, res) => {
  const s = mine(db.sites, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Introuvable" });
  db.sites.splice(db.sites.indexOf(s), 1);
  db.siteAssignments = db.siteAssignments.filter(a => a.siteId !== s.id);
  save(); res.json({ ok: true });
});
router.post("/sites/:id/assign", allow("GPF", "ADM"), (req, res) => {
  const s = mine(db.sites, req).find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: "Site introuvable" });
  const eid = req.body && req.body.employeeId; if (!eid) return res.status(400).json({ error: "employeeId requis" });
  if (mine(db.siteAssignments, req).some(a => a.siteId === s.id && a.employeeId === eid)) return res.json({ ok: true });
  db.siteAssignments.push(stamp({ id: id("sasg"), siteId: s.id, employeeId: eid, createdAt: now() }, req)); save();
  res.json({ ok: true });
});
router.delete("/sites/:id/assign/:eid", allow("GPF", "ADM"), (req, res) => {
  db.siteAssignments = db.siteAssignments.filter(a => !((a.tenantId || "t1") === (req.user.tenantId || "t1") && a.siteId === req.params.id && a.employeeId === req.params.eid));
  save(); res.json({ ok: true });
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
      server_ts: a.serverTs, client_ts: a.clientTs, site: s.name || "", lat: a.lat, lng: a.lng, accuracy: a.accuracy, distance_m: a.distanceM,
      status: a.status, exception_reason: a.exceptionReason || null, resolved: !!a.resolved }; }));
});
router.post("/attendance/:id/resolve", allow("GPF", "ADM", "CD"), (req, res) => {
  const a = mine(db.attendance, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  a.resolved = true; a.resolvedBy = req.user.id; a.resolvedAt = now(); a.resolveNote = String((req.body && req.body.note) || "").slice(0, 240);
  if (req.body && req.body.markNormal) a.status = "NORMAL";
  save(); audit(req.user, "RESOLVED", "Attendance", a.id, { reason: a.exceptionReason });
  res.json({ ok: true });
});

module.exports = router;
