/**
 * §3.2 + §3.4 - Contract types (parameterizable, versioned), salary elements,
 * and the salary grid linking base salary to categories.
 */
const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { mine, stamp, tenantId } = require("../store");
const { audit } = require("../audit");

/* ---- Contract types: CDI/CDD + custom, with version history ---- */
router.get("/contract-types", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(mine(db.contractTypes, req)));

router.post("/contract-types", allow("ADM"), (req, res) => {
  const { name, fixedTerm } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (mine(db.contractTypes, req).find(t => t.name === name)) return res.status(409).json({ error: "Type exists" });
  const t = stamp({ id: id("ctt"), name, fixedTerm: !!fixedTerm, system: false,
    versions: [{ v: 1, at: new Date().toISOString(), by: req.user.id, changes: "created" }] }, req);
  db.contractTypes.push(t); save();
  audit(req.user, "CONFIG_CHANGED", "ContractType", t.id, { created: name, fixedTerm: !!fixedTerm });
  res.status(201).json(t);
});

router.put("/contract-types/:id", allow("ADM"), (req, res) => {
  const t = mine(db.contractTypes, req).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  const before = { name: t.name, fixedTerm: t.fixedTerm };
  if (req.body.name) t.name = req.body.name;
  if (req.body.fixedTerm !== undefined) t.fixedTerm = !!req.body.fixedTerm;
  t.versions.push({ v: t.versions.length + 1, at: new Date().toISOString(), by: req.user.id,
    changes: JSON.stringify({ before, after: { name: t.name, fixedTerm: t.fixedTerm } }) });
  save();
  audit(req.user, "CONFIG_CHANGED", "ContractType", t.id, { before, after: { name: t.name, fixedTerm: t.fixedTerm }, version: t.versions.length });
  res.json(t);
});

/* ---- Salary elements (ADM): selected by GPF at employee creation ---- */
router.get("/salary-elements", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.salaryElements, req)));

router.post("/salary-elements", allow("ADM"), (req, res) => {
  const { name, tag, rubriqueCode } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (mine(db.salaryElements, req).find(e => e.name === name)) return res.status(409).json({ error: "Element exists" });
  const e = stamp({ id: id("sel"), name, tag: tag || null, rubriqueCode: rubriqueCode || null }, req);
  db.salaryElements.push(e); save();
  audit(req.user, "CONFIG_CHANGED", "SalaryElement", e.id, { created: name, tag, rubriqueCode });
  res.status(201).json(e);
});

// Link a salary element to a Paie rubrique (drives the RH -> Paie bridge).
router.put("/salary-elements/:id", allow("ADM"), (req, res) => {
  const e = mine(db.salaryElements, req).find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Not found" });
  if (req.body.name) e.name = req.body.name;
  if (req.body.tag !== undefined) e.tag = req.body.tag || null;
  if (req.body.rubriqueCode !== undefined) e.rubriqueCode = req.body.rubriqueCode || null;
  save();
  audit(req.user, "CONFIG_CHANGED", "SalaryElement", e.id, { name: e.name, rubriqueCode: e.rubriqueCode });
  res.json(e);
});

router.delete("/salary-elements/:id", allow("ADM"), (req, res) => {
  const e = mine(db.salaryElements, req).find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Not found" });
  db.salaryElements = db.salaryElements.filter(x => x.id !== req.params.id); save();
  audit(req.user, "CONFIG_CHANGED", "SalaryElement", e.id, { deleted: e.name });
  res.json({ ok: true });
});

/* ---- Salary grid (barème): category -> base salary; editable GPF/CD/ADM ---- */
router.get("/salary-grid", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.salaryGrid, req)));

router.put("/salary-grid", allow("GPF", "CD", "ADM"), (req, res) => {
  const grid = req.body?.grid;
  if (!Array.isArray(grid)) return res.status(400).json({ error: "grid array required [{category, baseSalary}]" });
  const cats = mine(db.referentials, req).find(r => r.key === "categories")?.values || [];
  const bad = grid.filter(g => !cats.includes(g.category) || !(Number(g.baseSalary) > 0));
  if (bad.length) return res.status(400).json({ error: "Invalid rows (unknown category or salary <= 0): " + bad.map(b => b.category).join(",") });
  const tid = tenantId(req);
  const before = mine(db.salaryGrid, req);
  db.salaryGrid = db.salaryGrid.filter(g => (g.tenantId||"t1") !== tid)
    .concat(grid.map(g => ({ id: id("sg"), tenantId: tid, category: g.category, baseSalary: Number(g.baseSalary) })));
  save();
  audit(req.user, "CONFIG_CHANGED", "SalaryGrid", "grid", { before, after: mine(db.salaryGrid, req) });
  res.json(mine(db.salaryGrid, req));
});

/* ---- Conventions collectives: own salary figures, attachable to portfolios ---- */
router.get("/conventions", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json(mine(db.conventions, req)));

router.post("/conventions", allow("ADM"), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (mine(db.conventions, req).find(c => c.name === name)) return res.status(409).json({ error: "Convention exists" });
  const cats = mine(db.referentials, req).find(r => r.key === "categories")?.values || [];
  const cnv = stamp({ id: id("cnv"), name, grid: cats.map(cat => ({ category: cat, baseSalary: 0 })) }, req);
  db.conventions.push(cnv); save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { created: name });
  res.status(201).json(cnv);
});

router.put("/conventions/:id/grid", allow("GPF", "CD", "ADM"), (req, res) => {
  const cnv = mine(db.conventions, req).find(c => c.id === req.params.id);
  if (!cnv) return res.status(404).json({ error: "Not found" });
  const grid = req.body?.grid;
  if (!Array.isArray(grid)) return res.status(400).json({ error: "grid array required [{category,label,baseSalary}]" });
  // Free-form category codes (real conventions use codes like 6D, 11E...) + optional label.
  const rows = grid.filter(g => String(g.category || "").trim()).map(g => ({
    category: String(g.category).trim(), label: String(g.label || "").trim(), baseSalary: Number(g.baseSalary) || 0 }));
  const before = cnv.grid;
  cnv.grid = rows; save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { name: cnv.name, before, after: cnv.grid });
  res.json(cnv);
});

router.put("/conventions/:id", allow("ADM"), (req, res) => {
  const cnv = mine(db.conventions, req).find(c => c.id === req.params.id);
  if (!cnv) return res.status(404).json({ error: "Not found" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  if (mine(db.conventions, req).find(c => c.id !== cnv.id && c.name === name)) return res.status(409).json({ error: "Convention exists" });
  cnv.name = name; save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { renamed: name });
  res.json(cnv);
});

router.delete("/conventions/:id", allow("ADM"), (req, res) => {
  const cnv = mine(db.conventions, req).find(c => c.id === req.params.id);
  if (!cnv) return res.status(404).json({ error: "Not found" });
  const used = mine(db.portfolios, req).some(pf => pf.conventionId === cnv.id);
  if (used) return res.status(409).json({ error: "Convention rattachée à un portefeuille - détachez-la d'abord." });
  db.conventions = db.conventions.filter(c => c.id !== cnv.id); save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { deleted: cnv.name });
  res.json({ ok: true });
});

/* One-click: add the standard Cameroon collective agreements (idempotent by name, empty grids). */
const CMR_CONVENTIONS = [
  "Convention Collective Nationale du Commerce",
  "Convention Collective des Banques et Établissements Financiers",
  "Convention Collective Nationale des Assurances",
  "Convention Collective du Bâtiment et des Travaux Publics (BTP)",
  "Convention Collective des Industries de Transformation",
  "Convention Collective des Transports Routiers et Activités Auxiliaires",
  "Convention Collective des Auxiliaires de Transport (Transit / Consignation)",
  "Convention Collective des Entreprises de Gardiennage et de Sécurité Privée",
  "Convention Collective des Hôtels, Bars, Restaurants et Établissements assimilés",
  "Convention Collective des Professions du Pétrole",
  "Convention Collective des Entreprises de Télécommunications",
  "Convention Collective des Industries Alimentaires",
  "Convention Collective des Boulangeries et Pâtisseries",
  "Convention Collective des Cliniques et Établissements de Santé Privés",
  "Convention Collective des Auxiliaires Médicaux",
  "Convention Collective des Professions de l'Enseignement Privé Laïc",
  "Convention Collective Nationale des Hydrocarbures (Exploration, Production, Raffinage)",
  "Convention Collective Nationale des Transporteurs Maritimes, Transitaires et Auxiliaires de Transports",
];
/* Barème indicatif : grille catégorie (I-XII) x échelon (A-E), ancrée sur des points réels
 * (Commerce 6D=173 573, 12A~442 225 issus des fiches réelles) et des fourchettes sectorielles
 * publiées. Valeurs INDICATIVES et modifiables - à confirmer avec l'annexe officielle. */
const COMMERCE_BASE_A = { 1: 66480, 2: 78980, 3: 93830, 4: 111470, 5: 132430, 6: 157080, 7: 186610, 8: 221690, 9: 263370, 10: 312880, 11: 371700, 12: 441580 };
const ECH_FACTOR = { A: 1.0, B: 1.035, C: 1.07, D: 1.105, E: 1.14, F: 1.175 };
function sectorMultiplier(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("banque") || n.includes("financ")) return 1.6;
  if (n.includes("pétrole") || n.includes("petrole")) return 1.8;
  if (n.includes("assurance")) return 1.4;
  if (n.includes("télécom") || n.includes("telecom")) return 1.4;
  if (n.includes("santé") || n.includes("clinique") || n.includes("médic") || n.includes("medic")) return 1.1;
  if (n.includes("btp") || n.includes("bâtiment") || n.includes("batiment") || n.includes("travaux publics")) return 1.05;
  if (n.includes("industrie")) return 1.05;
  if (n.includes("hôtel") || n.includes("hotel") || n.includes("restaurant") || n.includes("bar")) return 0.9;
  if (n.includes("boulangerie") || n.includes("pâtisserie") || n.includes("patisserie")) return 0.9;
  if (n.includes("agricole") || n.includes("agriculture") || n.includes("plantation")) return 0.85;
  if (n.includes("gardiennage") || n.includes("sécurité") || n.includes("securite")) return 0.85;
  return 1.0; // Commerce et autres
}
/* Grille officielle CCN Commerce 2024 (Secteur Tertiaire II), effet 1er janvier 2024.
 * Catégories 1..12 x échelons A..F. Codes de catégorie en chiffres (ex. 5A, 10F). */
const COMMERCE_2024 = {
  1:  [60473, 62732, 64987, 67243, 69498, 71754],
  2:  [71754, 76362, 81016, 85673, 90280, 94935],
  3:  [93256, 101414, 109574, 117732, 125845, 133974],
  4:  [108600, 116550, 124500, 132451, 141180, 148350],
  5:  [124652, 131878, 139104, 146368, 153593, 160820],
  6:  [150355, 158082, 165846, 173573, 181373, 189063],
  7:  [156222, 168616, 180936, 193293, 205649, 218005],
  8:  [218005, 232548, 247092, 261598, 276143, 290723],
  9:  [245736, 267234, 288732, 310229, 331728, 353225],
  10: [290270, 305783, 320927, 336107, 351253, 366432],
  11: [366484, 381577, 396722, 412010, 427035, 442225],
  12: [442225, 457370, 472550, 487728, 502873, 518051],
};
const COMMERCE_PCT = { 1:30, 2:30, 3:30, 4:11, 5:11, 6:7.5, 7:7.5, 8:7.5, 9:4, 10:4, 11:4, 12:4 };
const ECHELONS = ["A", "B", "C", "D", "E", "F"];
function commerceGrid2024() {
  const rows = [];
  for (let c = 1; c <= 12; c++) ECHELONS.forEach((e, i) =>
    rows.push({ category: c + e, label: "Catégorie " + c + " échelon " + e, baseSalary: COMMERCE_2024[c][i], pct: COMMERCE_PCT[c] }));
  return rows;
}
/* Grille officielle CCN Hydrocarbures (Exploration/Production/Raffinage), GRILLE 2018 MAJOREE
 * (CAT I-VI +8%, VII-IX +7%, X-XII +6%). Catégories 1..12 x échelons A..F.
 * Source: annexe II de la convention (déposée 07/2023). Catégories 3 et 4 issues d'un OCR à
 * revérifier avec l'annexe papier. */
const HYDRO_2018 = {
  1:  [65936, 69017, 72100, 75125, 78214, 81289],
  2:  [81289, 84350, 87431, 90478, 93545, 96310],
  3:  [94917, 101555, 108177, 114808, 121424, 128056],
  4:  [121552, 132225, 142878, 153551, 164231, 174891],
  5:  [165744, 176503, 187283, 198048, 208806, 219573],
  6:  [211952, 226959, 241916, 256916, 271907, 286830],
  7:  [220217, 239936, 259641, 279346, 299051, 318762],
  8:  [318756, 336163, 353522, 370922, 388321, 405708],
  9:  [384303, 417240, 450163, 483101, 516051, 548988],
  10: [404291, 432589, 460881, 489178, 517502, 545787],
  11: [545787, 570058, 594291, 618563, 642827, 667075],
  12: [667075, 691339, 715599, 739839, 764103, 788343],
};
function hydroGrid() {
  const rows = [];
  for (let c = 1; c <= 12; c++) ECHELONS.forEach((e, i) =>
    rows.push({ category: c + e, label: "Catégorie " + c + " échelon " + e, baseSalary: HYDRO_2018[c][i] }));
  return rows;
}
const isHydro = (name) => /hydrocarbure|exploration|raffinage/i.test(String(name || ""));
/* Grille officielle CCN Hôtels, Restaurants, Cafés, Bars, Dancings et Activités Annexes
 * (Secteur Tertiaire II, Annexe I - grille de salaire de base harmonisée). Catégories 1..12 x échelons A..F.
 * Source: annexe I de la convention (grille harmonisée transcrite fidèlement du texte officiel). */
const HOTELS_2025 = {
  1:  [60000, 61500, 63000, 64500, 66000, 67500],
  2:  [69500, 71500, 73500, 75500, 77500, 79500],
  3:  [81880, 84260, 86640, 89020, 91400, 93780],
  4:  [97495, 101210, 104925, 108640, 112355, 118070],
  5:  [119695, 123320, 126945, 130570, 134195, 137820],
  6:  [142183, 146546, 150909, 155272, 159635, 163998],
  7:  [167198, 170398, 173598, 176798, 179998, 183198],
  8:  [192833, 202468, 212103, 221738, 231373, 241008],
  9:  [253258, 265508, 277758, 290008, 302258, 314508],
  10: [319508, 324508, 329508, 334508, 339508, 344508],
  11: [351658, 358788, 365928, 373068, 380208, 387348],
  12: [399068, 410788, 422508, 434228, 445948, 457668],
};
function hotelsGrid() {
  const rows = [];
  for (let c = 1; c <= 12; c++) ECHELONS.forEach((e, i) =>
    rows.push({ category: c + e, label: "Catégorie " + c + " échelon " + e, baseSalary: HOTELS_2025[c][i] }));
  return rows;
}
const isHotels = (name) => /h[oô]tel|restaurant|dancing|caf[eé]s? |\bbars?\b/i.test(String(name || ""));
function gridSourceFor(name) {
  if (isCommerce(name)) return "officiel 2024";
  if (isHotels(name)) return "officiel (annexe I harmonisée)";
  if (isHydro(name)) return "officiel 2018 majoré (cat. 3-4 à vérifier)";
  return "indicatif";
}
const isCommerce = (name) => /commerce/i.test(String(name || ""));
function genGridForName(name) {
  if (isCommerce(name)) return commerceGrid2024();
  if (isHydro(name)) return hydroGrid();
  if (isHotels(name)) return hotelsGrid();
  const mult = sectorMultiplier(name); const rows = [];
  for (let c = 1; c <= 12; c++) for (const e of ECHELONS)
    rows.push({ category: c + e, label: "Catégorie " + c + " échelon " + e, baseSalary: Math.round(COMMERCE_2024[c][0] * ECH_FACTOR[e] * mult / 10) * 10 });
  return rows;
}
const isDefaultGrid = (grid) => Array.isArray(grid) && grid.length > 0 && grid.every(g => /^[A-E][1-3]$/.test(String(g.category || "")));

router.post("/conventions/:id/prefill-grid", allow("ADM"), (req, res) => {
  const cnv = mine(db.conventions, req).find(c => c.id === req.params.id);
  if (!cnv) return res.status(404).json({ error: "Not found" });
  cnv.grid = genGridForName(cnv.name); cnv.gridSource = gridSourceFor(cnv.name); save();
  audit(req.user, "CONFIG_CHANGED", "Convention", cnv.id, { prefillGrid: cnv.name });
  res.json(cnv);
});
router.post("/conventions/prefill-all", allow("ADM"), (req, res) => {
  const force = !!(req.body || {}).force; let filled = 0;
  for (const c of mine(db.conventions, req)) {
    if (force || !Array.isArray(c.grid) || !c.grid.length || isDefaultGrid(c.grid)) {
      c.grid = genGridForName(c.name); c.gridSource = gridSourceFor(c.name); filled++;
    }
  }
  if (filled) save();
  audit(req.user, "CONFIG_CHANGED", "Convention", "prefill-all", { filled, force });
  res.json({ filled, total: mine(db.conventions, req).length });
});

router.post("/conventions/seed-cameroon", allow("ADM"), (req, res) => {
  const have = new Set(mine(db.conventions, req).map(c => c.name));
  let added = 0;
  for (const name of CMR_CONVENTIONS) if (!have.has(name)) {
    db.conventions.push(stamp({ id: id("cnv"), name, grid: [] }, req)); added++;
  }
  if (added) save();
  audit(req.user, "CONFIG_CHANGED", "Convention", "seed", { added });
  res.json({ added, total: mine(db.conventions, req).length });
});

module.exports = router;
