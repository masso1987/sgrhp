/**
 * Fiche de Prix — simulateur de coût de mise à disposition (staffing) -> prix client.
 * Chaîne : éléments de salaire -> brut -> provisions (congés=1/12, fin contrat=brut*35%/12)
 * -> sous-total 1 -> charges patronales (16,2%) -> frais fixes -> total 2 (contributions)
 * -> marge admin (15%) -> HT -> TVA (19,25%) -> TTC. Tous les taux sont configurables.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");
if (!db.fichesPrix) db.fichesPrix = [];

const DEFAULT_PARAMS = {
  chargesPatronalesPct: 16.2, margePct: 15, tvaPct: 19.25,
  provisionCongesDiv: 12, provisionFinContratPct: 35,
  fraisFixes: [
    { label: "Frais d'assurance", amount: 10000 },
    { label: "Frais de communication mensuel", amount: 20000 },
    { label: "Indemnité de déplacement", amount: 0 },
    { label: "Visite médicale", amount: 8000 },
  ],
};
const DEFAULT_ELEMENTS = ["Salaire de base", "Sursalaire", "Prime d'ancienneté",
  "Indemnité de logement", "Indemnité de transport", "Prime de risque",
  "Prime de documentation", "Prime de salissure"];

const N = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
function compute(f) {
  const els = f.elements || [];
  const brut = els.reduce((s, e) => s + N(e.amount), 0);
  const p = Object.assign({}, DEFAULT_PARAMS, f.params || {});
  const provConges = p.provisionCongesDiv ? brut / N(p.provisionCongesDiv) : 0;
  const provFin = brut * (N(p.provisionFinContratPct) / 100) / 12;
  const sousTotal1 = brut + provConges + provFin;
  const chargesPatronales = sousTotal1 * (N(p.chargesPatronalesPct) / 100);
  const fraisFixes = (p.fraisFixes || []).reduce((s, x) => s + N(x.amount), 0);
  const total2 = sousTotal1 + chargesPatronales + fraisFixes;
  const marge = total2 * (N(p.margePct) / 100);
  const ht = total2 + marge;
  const tva = ht * (N(p.tvaPct) / 100);
  const ttc = ht + tva;
  const r = (x) => Math.round(x * 100) / 100;
  return { brut: r(brut), provConges: r(provConges), provFin: r(provFin), sousTotal1: r(sousTotal1),
    chargesPatronales: r(chargesPatronales), fraisFixes: r(fraisFixes), total2: r(total2),
    marge: r(marge), ht: r(ht), tva: r(tva), ttc: r(ttc) };
}

/* Nombre entier -> lettres (français), pour la ligne "montant en toutes lettres". */
function frWords(n) {
  n = Math.round(Math.abs(Number(n) || 0));
  if (n === 0) return "zéro";
  const u = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
    "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const t = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "", "quatre-vingt", ""];
  function b100(x) {
    if (x < 20) return u[x];
    const d = Math.floor(x / 10), r = x % 10;
    if (d === 7 || d === 9) { const base = d === 7 ? "soixante" : "quatre-vingt"; return base + "-" + u[10 + r]; }
    let w = t[d];
    if (r === 0) { if (d === 8) w += "s"; }
    else if (r === 1 && d >= 2 && d <= 6) w += " et un";
    else w += "-" + u[r];
    return w;
  }
  function b1000(x) {
    const c = Math.floor(x / 100), r = x % 100; let w = "";
    if (c > 0) { w += (c > 1 ? u[c] + " " : "") + "cent"; if (c > 1 && r === 0) w += "s"; }
    if (r > 0) w += (w ? " " : "") + b100(r);
    return w;
  }
  const groups = []; let x = n;
  while (x > 0) { groups.push(x % 1000); x = Math.floor(x / 1000); }
  const out = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]; if (g === 0) continue;
    if (i === 1) out.push((g === 1 ? "" : b1000(g) + " ") + "mille");
    else if (i === 0) out.push(b1000(g));
    else { const name = i === 2 ? "million" : "milliard"; out.push(b1000(g) + " " + name + (g > 1 ? "s" : "")); }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

router.get("/defaults", allow("GPF", "CD", "RJ", "ADM"), (req, res) => res.json({ params: DEFAULT_PARAMS, elements: DEFAULT_ELEMENTS }));

router.get("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) =>
  res.json(mine(db.fichesPrix, req).map(f => ({ ...f, computed: compute(f) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))));

router.get("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const c = compute(f);
  res.json({ ...f, computed: c, ttcWords: (frWords(Math.round(c.ttc)) + " francs CFA").replace(/^./, s => s.toUpperCase()) });
});

router.post("/", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const b = req.body || {};
  const f = stamp({
    id: id("fp"), ref: "FP-" + Date.now().toString(36).toUpperCase(),
    title: b.title || "Simulation", client: b.client || "", employeeName: b.employeeName || "",
    hiringDate: b.hiringDate || "", conventionId: b.conventionId || "", conventionName: b.conventionName || "",
    category: b.category || "", elements: Array.isArray(b.elements) ? b.elements : [],
    params: b.params || JSON.parse(JSON.stringify(DEFAULT_PARAMS)),
    createdAt: new Date().toISOString(), createdBy: req.user.id,
  }, req);
  db.fichesPrix.push(f); save();
  audit(req.user, "CREATED", "FichePrix", f.id, { title: f.title });
  res.status(201).json({ ...f, computed: compute(f) });
});

router.put("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {};
  ["title", "client", "employeeName", "hiringDate", "conventionId", "conventionName", "category"].forEach(k => { if (b[k] !== undefined) f[k] = b[k]; });
  if (Array.isArray(b.elements)) f.elements = b.elements;
  if (b.params) f.params = b.params;
  f.updatedAt = new Date().toISOString(); save();
  audit(req.user, "UPDATED", "FichePrix", f.id, {});
  res.json({ ...f, computed: compute(f) });
});

router.delete("/:id", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  db.fichesPrix = db.fichesPrix.filter(x => x.id !== f.id); save();
  audit(req.user, "DELETED", "FichePrix", f.id, {});
  res.json({ ok: true });
});

router.get("/:id/export", allow("GPF", "CD", "RJ", "ADM"), (req, res) => {
  let XLSX; try { XLSX = require("xlsx"); } catch (e) { return res.status(500).json({ error: "Module Excel indisponible" }); }
  const f = mine(db.fichesPrix, req).find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "Introuvable" });
  const c = compute(f);
  const aoa = [];
  aoa.push(["FICHE DE PRIX / SIMULATION"]);
  aoa.push([f.title || ""]);
  aoa.push(["Client", f.client || ""]);
  aoa.push(["Salarié / candidat", f.employeeName || ""]);
  aoa.push(["Convention", f.conventionName || ""]);
  aoa.push(["Catégorie", f.category || ""]);
  aoa.push(["Date d'embauche", f.hiringDate || ""]);
  aoa.push([]);
  aoa.push(["ÉLÉMENTS DE SALAIRE", "Montant (XAF)"]);
  (f.elements || []).forEach(e => aoa.push([e.label || "", N(e.amount)]));
  aoa.push(["SALAIRE BRUT", c.brut]);
  aoa.push(["Provision congés (1/12)", c.provConges]);
  aoa.push(["Provision fin de contrat", c.provFin]);
  aoa.push(["SOUS-TOTAL 1", c.sousTotal1]);
  const p = Object.assign({}, DEFAULT_PARAMS, f.params || {});
  aoa.push(["Charges patronales (" + p.chargesPatronalesPct + "%)", c.chargesPatronales]);
  (p.fraisFixes || []).forEach(x => aoa.push([x.label || "Frais", N(x.amount)]));
  aoa.push(["TOTAL 2 (contributions employeur)", c.total2]);
  aoa.push(["Charges administratives + marge (" + p.margePct + "%)", c.marge]);
  aoa.push(["MONTANT HT", c.ht]);
  aoa.push(["TVA (" + p.tvaPct + "%)", c.tva]);
  aoa.push(["MONTANT TTC", c.ttc]);
  aoa.push([]);
  aoa.push(["Arrêté à la somme de", (frWords(Math.round(c.ttc)) + " francs CFA").replace(/^./, s => s.toUpperCase())]);
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 42 }, { wch: 18 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Fiche de prix");
  res.setHeader("Content-Disposition", 'attachment; filename="fiche_prix.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

module.exports = router;
