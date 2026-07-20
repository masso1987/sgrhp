/**
 * M5 — Career & Performance (§6).
 * 6.1 Career plans (preferences, potential matrix, career paths, trainings) + predictive matching
 * 6.2 OKR, 360° evaluations, digital interviews with e-signature, regular check-ins
 * 6.3 Succession plans (key positions, successor readiness)
 */
const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine } = require("../store");
const { audit } = require("../audit");
const notify = require("../notify");

const emp = (eid, req) => mine(db.employees, req).find(e => e.id === eid);
const need = (res, cond, msg, code = 400) => { if (!cond) { res.status(code).json({ error: msg }); return true; } return false; };

/* ================= 6.1 Career plans ================= */
router.get("/plans/:employeeId", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  res.json(mine(db.careerPlans, req).find(p => p.employeeId === req.params.employeeId) || null);
});

router.put("/plans/:employeeId", allow("GPF", "CD", "ADM"), (req, res) => {
  if (need(res, emp(req.params.employeeId, req), "Employee not found", 404)) return;
  const { preferredPositions, preferredLocations, availability, potential, careerPathId, trainings } = req.body || {};
  if (potential !== undefined && !(potential >= 1 && potential <= 9))
    return res.status(400).json({ error: "potential must be 1..9 (potential matrix box)" });
  if (careerPathId && !mine(db.careerPaths, req).find(c => c.id === careerPathId))
    return res.status(400).json({ error: "Unknown career path" });
  let p = mine(db.careerPlans, req).find(x => x.employeeId === req.params.employeeId);
  if (!p) { p = { id: id("cp"), tenantId: req.user.tenantId || "t1", employeeId: req.params.employeeId }; db.careerPlans.push(p); }
  Object.assign(p, {
    preferredPositions: preferredPositions ?? p.preferredPositions ?? [],
    preferredLocations: preferredLocations ?? p.preferredLocations ?? [],
    availability: availability ?? p.availability ?? "",
    potential: potential ?? p.potential ?? null,
    careerPathId: careerPathId ?? p.careerPathId ?? null,
    trainings: trainings ?? p.trainings ?? [],
    updatedAt: new Date().toISOString(), updatedBy: req.user.id });
  save();
  audit(req.user, "UPDATED", "CareerPlan", p.id, { employeeId: p.employeeId });
  res.json(p);
});

/* Career paths (templates) — ADM */
router.get("/paths", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.careerPaths, req)));
router.post("/paths", allow("ADM"), (req, res) => {
  const { name, stages } = req.body || {};
  if (need(res, name && Array.isArray(stages) && stages.length >= 2, "name and >=2 stages required")) return;
  const c = { id: id("path"), tenantId: req.user.tenantId || "t1", name, stages };
  db.careerPaths.push(c); save();
  audit(req.user, "CONFIG_CHANGED", "CareerPath", c.id, { created: name });
  res.status(201).json(c);
});

/* Predictive matching: employees vs key positions (§6.1) */
router.get("/matching", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const out = [];
  for (const sp of mine(db.successionPlans, req)) {
    for (const e of mine(db.employees, req)) {
      const plan = mine(db.careerPlans, req).find(p => p.employeeId === e.id);
      let score = 0;
      const pos = (plan?.preferredPositions || []).map(s => s.toLowerCase());
      if (pos.some(p => sp.keyPosition.toLowerCase().includes(p) || p.includes(sp.keyPosition.toLowerCase()))) score += 45;
      if (plan?.potential) score += plan.potential * 4;                      // up to 36
      const fiche = mine(db.fichesPoste, req).find(f => sp.keyPosition.toLowerCase().includes(f.title.toLowerCase()));
      if (fiche && e.contract?.category) score += 8;
      const okr = mine(db.okrs, req).filter(o => o.employeeId === e.id);
      const avg = okr.length ? okr.reduce((s, o) => s + o.keyResults.reduce((a, k) => a + (k.progress || 0), 0) / Math.max(1, o.keyResults.length), 0) / okr.length : 0;
      score += Math.round(avg * 0.11);                                        // up to 11
      if (score >= 40) out.push({ keyPosition: sp.keyPosition, employeeId: e.id,
        employee: `${e.firstName} ${e.lastName}`, score: Math.min(99, score) });
    }
  }
  res.json(out.sort((a, b) => b.score - a.score).slice(0, 20));
});

/* ================= 6.2 OKR ================= */
router.get("/okr/:employeeId", allow("GPF", "CD", "RJ", "ADM"), (req, res) =>
  res.json(mine(db.okrs, req).filter(o => o.employeeId === req.params.employeeId)));

router.post("/okr/:employeeId", allow("GPF", "CD", "ADM"), (req, res) => {
  if (need(res, emp(req.params.employeeId, req), "Employee not found", 404)) return;
  const { period, objective, keyResults } = req.body || {};
  if (need(res, period && objective, "period and objective required")) return;
  if (need(res, Array.isArray(keyResults) && keyResults.length, "at least one key result required")) return;
  const o = { id: id("okr"), tenantId: req.user.tenantId || "t1", employeeId: req.params.employeeId, period, objective,
    keyResults: keyResults.map(k => ({ title: k.title, target: k.target || "", progress: 0 })),
    createdBy: req.user.id, createdAt: new Date().toISOString() };
  db.okrs.push(o); save();
  audit(req.user, "CREATED", "OKR", o.id, { objective, period });
  res.status(201).json(o);
});

router.put("/okr/:okrId/progress", allow("GPF", "CD", "ADM"), (req, res) => {
  const o = mine(db.okrs, req).find(x => x.id === req.params.okrId);
  if (need(res, o, "OKR not found", 404)) return;
  const { updates } = req.body || {}; // [{index, progress}]
  for (const u of updates || []) {
    if (o.keyResults[u.index] && u.progress >= 0 && u.progress <= 100)
      o.keyResults[u.index].progress = Number(u.progress);
  }
  save();
  audit(req.user, "UPDATED", "OKR", o.id, { updates });
  res.json(o);
});

/* ================= 6.2 360° evaluations ================= */
router.get("/eval360", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.evaluations360, req)));

router.post("/eval360", allow("CD", "ADM"), (req, res) => {
  const { employeeId, name, criteria, evaluators } = req.body || {};
  if (need(res, emp(employeeId, req), "Employee not found", 404)) return;
  if (need(res, Array.isArray(criteria) && criteria.length, "criteria list required")) return;
  const roles = ["manager", "peer", "subordinate", "self"];
  if (need(res, Array.isArray(evaluators) && evaluators.length && evaluators.every(e => roles.includes(e.role)),
    `evaluators required, roles: ${roles.join("/")}`)) return;
  const ev = { id: id("e360"), tenantId: req.user.tenantId || "t1", employeeId, name: name || "Évaluation 360°",
    criteria, evaluators: evaluators.map(e => ({ name: e.name, role: e.role, scores: null, comment: null, submittedAt: null })),
    status: "OPEN", createdBy: req.user.id, createdAt: new Date().toISOString() };
  db.evaluations360.push(ev); save();
  audit(req.user, "CREATED", "Eval360", ev.id, { employeeId, evaluators: evaluators.length });
  res.status(201).json(ev);
});

router.post("/eval360/:id/submit", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const ev = mine(db.evaluations360, req).find(x => x.id === req.params.id);
  if (need(res, ev, "Not found", 404)) return;
  const { evaluatorIndex, scores, comment } = req.body || {};
  const evr = ev.evaluators[evaluatorIndex];
  if (need(res, evr, "Unknown evaluator index")) return;
  if (need(res, Array.isArray(scores) && scores.length === ev.criteria.length &&
    scores.every(s => s >= 1 && s <= 5), `scores: one value 1..5 per criterion (${ev.criteria.length})`)) return;
  evr.scores = scores; evr.comment = comment || ""; evr.submittedAt = new Date().toISOString();
  if (ev.evaluators.every(e => e.submittedAt)) ev.status = "COMPLETE";
  save();
  audit(req.user, "UPDATED", "Eval360", ev.id, { evaluator: evr.name, complete: ev.status === "COMPLETE" });
  res.json(consolidate(ev));
});

function consolidate(ev) {
  const done = ev.evaluators.filter(e => e.scores);
  const byCriterion = ev.criteria.map((c, i) => ({
    criterion: c,
    average: done.length ? Math.round(done.reduce((s, e) => s + e.scores[i], 0) / done.length * 10) / 10 : null }));
  const overall = done.length
    ? Math.round(byCriterion.reduce((s, c) => s + c.average, 0) / byCriterion.length * 10) / 10 : null;
  return { ...ev, consolidated: { byCriterion, overall, submitted: done.length, total: ev.evaluators.length } };
}
router.get("/eval360/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const ev = mine(db.evaluations360, req).find(x => x.id === req.params.id);
  if (need(res, ev, "Not found", 404)) return;
  res.json(consolidate(ev));
});

/* ================= 6.2 Check-ins & digital interviews ================= */
router.get("/checkins/:employeeId", allow("GPF", "CD", "RJ", "ADM"), (req, res) =>
  res.json(mine(db.checkins, req).filter(c => c.employeeId === req.params.employeeId)));

router.post("/checkins/:employeeId", allow("GPF", "CD", "ADM"), (req, res) => {
  if (need(res, emp(req.params.employeeId, req), "Employee not found", 404)) return;
  const c = { id: id("chk"), tenantId: req.user.tenantId || "t1", employeeId: req.params.employeeId,
    date: req.body?.date || new Date().toISOString().slice(0, 10),
    notes: req.body?.notes || "", nextDate: req.body?.nextDate || null,
    managerId: req.user.id, managerName: req.user.fullName };
  db.checkins.push(c); save();
  audit(req.user, "CREATED", "CheckIn", c.id, { employeeId: c.employeeId });
  res.status(201).json(c);
});

router.get("/interviews/:employeeId", allow("GPF", "CD", "RJ", "ADM"), (req, res) =>
  res.json(mine(db.interviews, req).filter(i => i.employeeId === req.params.employeeId)));

router.post("/interviews/:employeeId", allow("CD", "ADM"), (req, res) => {
  if (need(res, emp(req.params.employeeId, req), "Employee not found", 404)) return;
  const { type, date, summary } = req.body || {};
  if (need(res, ["Entretien annuel", "Entretien professionnel"].includes(type),
    "type: Entretien annuel | Entretien professionnel")) return;
  const it = { id: id("itv"), tenantId: req.user.tenantId || "t1", employeeId: req.params.employeeId, type,
    date: date || new Date().toISOString().slice(0, 10), summary: summary || "",
    signatures: { manager: null, employee: null }, status: "DRAFT",
    createdBy: req.user.id, createdAt: new Date().toISOString() };
  db.interviews.push(it); save();
  audit(req.user, "CREATED", "Interview", it.id, { type });
  res.status(201).json(it);
});

// E-signature (§6.2.3): identity + timestamp recorded, archived, audited
router.post("/interviews/:id/sign", allow("GPF", "CD", "ADM"), (req, res) => {
  const it = mine(db.interviews, req).find(x => x.id === req.params.id);
  if (need(res, it, "Not found", 404)) return;
  const { as, signedName } = req.body || {};
  if (need(res, ["manager", "employee"].includes(as), "as: manager | employee")) return;
  if (it.signatures[as]) return res.status(409).json({ error: `Already signed by ${as}` });
  if (need(res, signedName && signedName.trim().length >= 3, "signedName required (min 3 chars)")) return;
  it.signatures[as] = { name: signedName.trim(), byUser: req.user.id, at: new Date().toISOString() };
  if (it.signatures.manager && it.signatures.employee) it.status = "SIGNED_ARCHIVED";
  save();
  audit(req.user, "SIGNED", "Interview", it.id, { as, signedName });
  res.json(it);
});

/* ================= 6.3 Succession plans ================= */
router.get("/succession", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.successionPlans, req)));

router.post("/succession", allow("CD", "ADM"), (req, res) => {
  const { keyPosition, criticality, riskOfDeparture } = req.body || {};
  if (need(res, keyPosition, "keyPosition required")) return;
  if (need(res, ["LOW", "MEDIUM", "HIGH"].includes(criticality), "criticality: LOW|MEDIUM|HIGH")) return;
  const sp = { id: id("sp"), tenantId: req.user.tenantId || "t1", keyPosition, criticality,
    riskOfDeparture: riskOfDeparture || "MEDIUM", successors: [],
    createdBy: req.user.id, createdAt: new Date().toISOString() };
  db.successionPlans.push(sp); save();
  audit(req.user, "CREATED", "SuccessionPlan", sp.id, { keyPosition, criticality });
  res.status(201).json(sp);
});

router.post("/succession/:id/successors", allow("CD", "ADM"), (req, res) => {
  const sp = mine(db.successionPlans, req).find(x => x.id === req.params.id);
  if (need(res, sp, "Not found", 404)) return;
  const { employeeId, readiness } = req.body || {};
  if (need(res, emp(employeeId, req), "Employee not found", 404)) return;
  if (need(res, ["READY_NOW", "READY_1_2Y", "TO_DEVELOP"].includes(readiness),
    "readiness: READY_NOW | READY_1_2Y | TO_DEVELOP")) return;
  sp.successors = sp.successors.filter(s => s.employeeId !== employeeId);
  sp.successors.push({ employeeId, readiness, addedBy: req.user.id, at: new Date().toISOString() });
  save();
  audit(req.user, "UPDATED", "SuccessionPlan", sp.id, { employeeId, readiness });
  res.json(sp);
});

module.exports = router;
