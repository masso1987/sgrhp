/**
 * SGRHP - Stock BTP (module « btp ») : matériaux de construction, entrepôts et chantiers,
 * grand livre des mouvements de stock, demandes de matériel, livraisons et consommations.
 *
 * Indépendant du module « stock » (gestion commerciale / EPI), qui reste inchangé.
 *
 * Règles d'inventaire :
 *  - le stock d'un matériau dans un entrepôt est la somme des mouvements du grand livre
 *    (btpMovements) ; il n'existe pas de quantité « en dur » modifiable ;
 *  - un mouvement validé n'est jamais supprimé ni modifié : une erreur se corrige par une
 *    contre-passation (type « annulation ») ou un ajustement ;
 *  - une opération (transfert, livraison…) est validée en entier ou pas du tout, et le stock
 *    ne peut pas devenir négatif ;
 *  - une clé client (clientKey) empêche d'enregistrer deux fois la même opération ;
 *  - valorisation au coût unitaire moyen pondéré (CUMP), recalculé à chaque entrée achetée.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

const COLS = ["btpCategories", "btpMaterials", "btpWarehouses", "btpProjects", "btpMovements", "btpRequests", "btpDeliveries"];
const col = (k) => db[k] || (db[k] = []);
COLS.forEach(col);

const READ = ["ADM", "CD", "RJ", "GPF", "RS"];
const WRITE = ["ADM", "CD", "GPF", "RS"];
const CONFIG = ["ADM", "CD", "RS"];
const APPROVE = ["ADM", "CD"];

const Q = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const str = (v, n = 200) => String(v == null ? "" : v).trim().slice(0, n);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

const UNITS = [
  { code: "PCS", label: "Pièce" }, { code: "KG", label: "Kilogramme" }, { code: "T", label: "Tonne" },
  { code: "SAC", label: "Sac" }, { code: "M3", label: "Mètre cube" }, { code: "M2", label: "Mètre carré" },
  { code: "ML", label: "Mètre linéaire" }, { code: "L", label: "Litre" }, { code: "ROUL", label: "Rouleau" },
  { code: "CART", label: "Carton" }, { code: "PAL", label: "Palette" },
];
const UNIT_CODES = UNITS.map(u => u.code);
const DEFAULT_CATEGORIES = ["Ciment", "Sable", "Gravier", "Acier & ferraillage", "Briques & parpaings", "Couverture",
  "Plomberie", "Électricité", "Peinture & finitions", "Bois & menuiserie", "Équipements de sécurité", "Consommables"];
const WH_TYPES = { central: "Entrepôt central", secondaire: "Entrepôt secondaire", chantier: "Magasin de chantier", temporaire: "Stockage temporaire", depot: "Dépôt matériel" };
const PROJECT_STATUS = { brouillon: "Brouillon", planifie: "Planifié", actif: "Actif", suspendu: "Suspendu", termine: "Terminé", annule: "Annulé" };
const MOVE_TYPES = {
  initial: "Stock initial", reception: "Réception achat", transfert: "Transfert", livraison: "Livraison chantier",
  consommation: "Consommation", retour: "Retour au magasin", retour_fournisseur: "Retour fournisseur",
  ajustement: "Ajustement", endommage: "Matériel endommagé", perte: "Perte / manquant", annulation: "Contre-passation",
};
const REQ_STATUS = { brouillon: "Brouillon", soumise: "Soumise", approuvee: "Approuvée", partielle: "Partiellement approuvée",
  rejetee: "Rejetée", livraison_partielle: "Partiellement livrée", livree: "Livrée", annulee: "Annulée" };

function seed(req) {
  const tid = req.user.tenantId || "t1";
  if (!col("btpCategories").some(c => (c.tenantId || "t1") === tid)) {
    for (const name of DEFAULT_CATEGORIES) col("btpCategories").push({ id: id("btc"), tenantId: tid, name, createdAt: new Date().toISOString() });
    save();
  }
}
// Sequential reference per tenant, year and prefix: MAT-0001, CH-2026-0001, MVT-2026-00001…
function nextRef(req, collection, prefix, width = 4, yearly = true) {
  const head = yearly ? `${prefix}-${new Date().getFullYear()}-` : `${prefix}-`;
  const used = mine(col(collection), req).map(x => String(x.ref || "")).filter(r => r.startsWith(head)).map(r => parseInt(r.slice(head.length), 10) || 0);
  return head + String((used.length ? Math.max(...used) : 0) + 1).padStart(width, "0");
}
const findMine = (collection, req, rid) => rid ? mine(col(collection), req).find(x => x.id === rid) : null;
const matName = (req, mid) => (findMine("btpMaterials", req, mid) || {}).name || "";
const whName = (req, wid) => (findMine("btpWarehouses", req, wid) || {}).name || "";
const projName = (req, pid) => (findMine("btpProjects", req, pid) || {}).name || "";

/* ============================ Soldes (calculés depuis le grand livre) ============================ */
function balances(req) {
  const by = new Map();      // `${materialId}|${warehouseId}` -> qty
  for (const m of mine(col("btpMovements"), req)) {
    const k = m.materialId + "|" + m.warehouseId;
    by.set(k, Q((by.get(k) || 0) + m.qty));
  }
  return by;
}
const qtyAt = (bal, mid, wid) => bal.get(mid + "|" + wid) || 0;
function totalQty(bal, mid) { let t = 0; for (const [k, v] of bal) if (k.startsWith(mid + "|")) t += v; return Q(t); }
function stockState(m, qty) {
  if (qty <= 0) return "rupture";
  const lim = Number(m.reorderLevel) || Number(m.minStock) || 0;
  return lim && qty <= lim ? "bas" : "ok";
}

/* ============================ Moteur de mouvements ============================
 * post() valide TOUTE l'opération avant d'écrire quoi que ce soit : tout est synchrone,
 * donc aucune autre requête ne peut s'intercaler (pas de double déduction possible). */
function post(req, op) {
  const tid = req.user.tenantId || "t1";
  if (op.clientKey) {
    const dup = mine(col("btpMovements"), req).find(m => m.clientKey === op.clientKey);
    if (dup) return { duplicate: true, ref: dup.ref };
  }
  if (!op.lines.length) return { error: "Aucune ligne valide (matériau + quantité)." };
  const bal = balances(req);
  const delta = new Map();
  for (const l of op.lines) {
    const m = findMine("btpMaterials", req, l.materialId);
    if (!m) return { error: "Matériau introuvable." };
    if (m.active === false && l.qty > 0 && op.type !== "annulation") return { error: `Le matériau « ${m.name} » est désactivé.` };
    const w = findMine("btpWarehouses", req, l.warehouseId);
    if (!w) return { error: "Entrepôt introuvable." };
    if (w.active === false && op.type !== "annulation") return { error: `L'entrepôt « ${w.name} » est désactivé.` };
    if (!(Math.abs(l.qty) > 0) || Math.abs(l.qty) > 1e9) return { error: `Quantité invalide pour « ${m.name} ».` };
    const k = l.materialId + "|" + l.warehouseId;
    delta.set(k, Q((delta.get(k) || 0) + l.qty));
  }
  for (const [k, d] of delta) {
    const [mid, wid] = k.split("|"); const after = Q(qtyAt(bal, mid, wid) + d);
    if (after < 0) return { error: `Stock insuffisant : « ${matName(req, mid)} » à « ${whName(req, wid)} » (disponible ${qtyAt(bal, mid, wid)}, demandé ${Q(-d)}).` };
  }
  const ref = nextRef(req, "btpMovements", "MVT", 5);
  const at = new Date().toISOString();
  const recs = [];
  for (const l of op.lines) {
    const m = findMine("btpMaterials", req, l.materialId);
    let unitCost = R2(m.avgCost || m.purchasePrice || 0);
    // Entrée achetée : nouveau coût moyen pondéré sur la quantité totale de l'entreprise.
    if ((op.type === "reception" || op.type === "initial") && l.qty > 0) {
      const cost = l.unitCost != null && l.unitCost !== "" ? R2(l.unitCost) : R2(m.purchasePrice || 0);
      const q0 = Math.max(0, totalQty(bal, m.id));
      m.avgCost = q0 + l.qty > 0 ? R2((q0 * R2(m.avgCost || 0) + l.qty * cost) / (q0 + l.qty)) : cost;
      if (op.type === "reception" && cost) m.purchasePrice = cost;
      unitCost = cost;
      bal.set(m.id + "|" + l.warehouseId, Q(qtyAt(bal, m.id, l.warehouseId) + l.qty));
    } else if (l.unitCost != null && op.type === "annulation") unitCost = R2(l.unitCost);
    recs.push({ id: id("bmv"), tenantId: tid, ref, type: op.type, date: op.date, materialId: m.id, warehouseId: l.warehouseId,
      qty: Q(l.qty), unit: m.unit, unitCost, value: R2(Q(l.qty) * unitCost), projectId: op.projectId || l.projectId || "",
      reason: op.reason || "", activity: op.activity || "", supplierId: op.supplierId || "", docRef: op.docRef || "",
      sourceType: op.sourceType || "", sourceId: op.sourceId || "", reversalOf: op.reversalOf || "",
      clientKey: op.clientKey || "", createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: at });
  }
  col("btpMovements").push(...recs);
  save();
  audit(req.user, "BTP_STOCK_" + op.type.toUpperCase(), "BtpMovement", ref, { lines: recs.length, projectId: op.projectId || "" });
  lowStockAlerts(req, recs);
  return { ref, movements: recs };
}
function lowStockAlerts(req, recs) {
  const outs = [...new Set(recs.filter(r => r.qty < 0).map(r => r.materialId))];
  if (!outs.length) return;
  const bal = balances(req);
  for (const mid of outs) {
    const m = findMine("btpMaterials", req, mid); const q = totalQty(bal, mid);
    const st = stockState(m, q);
    if (st !== "ok") try {
      require("../notify").toRolesTenant(["ADM", "CD"], req.user.tenantId || "t1",
        st === "rupture" ? `Rupture de stock : ${m.name}` : `Stock bas : ${m.name}`,
        `Stock restant de « ${m.name} » : ${q} ${m.unit} (seuil ${m.reorderLevel || m.minStock || 0}).`, null);
    } catch (e) {}
  }
}

/* ============================ Référentiels ============================ */
router.get("/meta", allow(...READ), (req, res) => res.json({ units: UNITS, warehouseTypes: WH_TYPES, projectStatus: PROJECT_STATUS, movementTypes: MOVE_TYPES, requestStatus: REQ_STATUS }));

router.get("/categories", allow(...READ), (req, res) => { seed(req); res.json(mine(col("btpCategories"), req).slice().sort((a, b) => a.name.localeCompare(b.name, "fr"))); });
router.post("/categories", allow(...CONFIG), (req, res) => {
  const name = str((req.body || {}).name, 80); if (!name) return bad(res, "Nom obligatoire");
  if (mine(col("btpCategories"), req).some(c => c.name.toLowerCase() === name.toLowerCase())) return bad(res, "Cette catégorie existe déjà", 409);
  const c = stamp({ id: id("btc"), name, createdAt: new Date().toISOString() }, req); col("btpCategories").push(c); save();
  audit(req.user, "CREATED", "BtpCategory", c.id, { name }); res.status(201).json(c);
});
router.put("/categories/:id", allow(...CONFIG), (req, res) => {
  const c = findMine("btpCategories", req, req.params.id); if (!c) return bad(res, "Catégorie introuvable", 404);
  const name = str((req.body || {}).name, 80); if (!name) return bad(res, "Nom obligatoire");
  c.name = name; save(); res.json(c);
});
router.delete("/categories/:id", allow(...CONFIG), (req, res) => {
  const c = findMine("btpCategories", req, req.params.id); if (!c) return bad(res, "Catégorie introuvable", 404);
  if (mine(col("btpMaterials"), req).some(m => m.categoryId === c.id)) return bad(res, "Catégorie utilisée par des matériaux : impossible de la supprimer");
  col("btpCategories").splice(col("btpCategories").indexOf(c), 1); save(); audit(req.user, "DELETED", "BtpCategory", c.id, {}); res.json({ ok: true });
});

/* ============================ Matériaux ============================ */
const MAT_TEXT = { name: 120, description: 600, barcode: 60, supplierId: 40, categoryId: 40 };
function materialOut(req, m, bal) {
  const qty = totalQty(bal, m.id);
  return Object.assign({}, m, { qty, value: R2(qty * (m.avgCost || 0)), state: stockState(m, qty),
    categoryName: (findMine("btpCategories", req, m.categoryId) || {}).name || "",
    supplierName: (mine(db.stockContacts || [], req).find(c => c.id === m.supplierId) || {}).name || "" });
}
function applyMaterial(req, m, b) {
  for (const [k, n] of Object.entries(MAT_TEXT)) if (b[k] !== undefined) m[k] = str(b[k], n);
  if (b.unit !== undefined) { if (!UNIT_CODES.includes(b.unit)) return "Unité inconnue"; m.unit = b.unit; }
  if (b.purchaseUnit !== undefined) { if (b.purchaseUnit && !UNIT_CODES.includes(b.purchaseUnit)) return "Unité d'achat inconnue"; m.purchaseUnit = b.purchaseUnit || m.unit; }
  if (b.conversion !== undefined) { const c = Number(b.conversion); if (!(c > 0 && c <= 1e6)) return "Facteur de conversion invalide (nombre > 0)"; m.conversion = Q(c); }
  for (const k of ["minStock", "maxStock", "reorderLevel"]) if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= 0)) return "Seuils invalides (nombre ≥ 0)"; m[k] = Q(v); }
  if (b.purchasePrice !== undefined) { const v = Number(b.purchasePrice); if (!(v >= 0)) return "Prix d'achat invalide"; m.purchasePrice = R2(v); }
  if (b.vatRate !== undefined) { const v = Number(b.vatRate); if (!(v >= 0 && v <= 100)) return "Taux de TVA invalide"; m.vatRate = R2(v); }
  if (b.active !== undefined) m.active = !!b.active;
  if (m.categoryId && !findMine("btpCategories", req, m.categoryId)) return "Catégorie introuvable";
  if (m.maxStock && m.minStock && m.maxStock < m.minStock) return "Le stock maximum doit être supérieur au minimum";
  return null;
}
router.get("/materials", allow(...READ), (req, res) => {
  seed(req); const bal = balances(req);
  res.json(mine(col("btpMaterials"), req).map(m => materialOut(req, m, bal)).sort((a, b) => a.name.localeCompare(b.name, "fr")));
});
router.post("/materials", allow(...CONFIG), (req, res) => {
  const b = req.body || {};
  if (!str(b.name)) return bad(res, "Nom du matériau obligatoire");
  const ref = str(b.ref, 40) || nextRef(req, "btpMaterials", "MAT", 4, false);
  if (mine(col("btpMaterials"), req).some(m => m.ref.toLowerCase() === ref.toLowerCase())) return bad(res, "Cette référence existe déjà", 409);
  const m = stamp({ id: id("btm"), ref, unit: "PCS", purchaseUnit: "", conversion: 1, minStock: 0, maxStock: 0, reorderLevel: 0,
    purchasePrice: 0, avgCost: 0, vatRate: 19.25, active: true, createdAt: new Date().toISOString(), createdBy: req.user.id }, req);
  const err = applyMaterial(req, m, b); if (err) return bad(res, err);
  if (!m.purchaseUnit) m.purchaseUnit = m.unit;
  m.avgCost = m.purchasePrice || 0;
  col("btpMaterials").push(m); save(); audit(req.user, "CREATED", "BtpMaterial", m.id, { ref: m.ref, name: m.name });
  res.status(201).json(materialOut(req, m, balances(req)));
});
router.put("/materials/:id", allow(...CONFIG), (req, res) => {
  const m = findMine("btpMaterials", req, req.params.id); if (!m) return bad(res, "Matériau introuvable", 404);
  const b = Object.assign({}, req.body || {});
  // Unité de stock et coût moyen ne changent pas une fois des mouvements enregistrés (cohérence du stock).
  const used = mine(col("btpMovements"), req).some(x => x.materialId === m.id);
  if (used && b.unit !== undefined && b.unit !== m.unit) return bad(res, "Unité de stock non modifiable : ce matériau a déjà des mouvements");
  if (b.ref !== undefined) {
    const ref = str(b.ref, 40); if (!ref) return bad(res, "Référence obligatoire");
    if (mine(col("btpMaterials"), req).some(x => x.id !== m.id && x.ref.toLowerCase() === ref.toLowerCase())) return bad(res, "Cette référence existe déjà", 409);
    m.ref = ref;
  }
  const before = JSON.stringify(m);
  const err = applyMaterial(req, m, b); if (err) { Object.assign(m, JSON.parse(before)); return bad(res, err); }
  save(); audit(req.user, "UPDATED", "BtpMaterial", m.id, {}); res.json(materialOut(req, m, balances(req)));
});
router.get("/materials/:id/stock", allow(...READ), (req, res) => {
  const m = findMine("btpMaterials", req, req.params.id); if (!m) return bad(res, "Matériau introuvable", 404);
  const bal = balances(req);
  res.json(mine(col("btpWarehouses"), req).map(w => ({ warehouseId: w.id, warehouse: w.name, type: w.type, qty: qtyAt(bal, m.id, w.id) })).filter(x => x.qty));
});

/* ============================ Entrepôts ============================ */
function applyWarehouse(req, w, b) {
  for (const [k, n] of Object.entries({ name: 120, address: 300, manager: 120, phone: 40, email: 120 })) if (b[k] !== undefined) w[k] = str(b[k], n);
  if (b.type !== undefined) { if (!WH_TYPES[b.type]) return "Type d'entrepôt inconnu"; w.type = b.type; }
  if (b.capacity !== undefined) { const v = Number(b.capacity); if (!(v >= 0)) return "Capacité invalide"; w.capacity = Q(v); }
  if (b.projectId !== undefined) { if (b.projectId && !findMine("btpProjects", req, b.projectId)) return "Chantier introuvable"; w.projectId = b.projectId || ""; }
  if (b.active !== undefined) w.active = !!b.active;
  return w.name ? null : "Nom de l'entrepôt obligatoire";
}
router.get("/warehouses", allow(...READ), (req, res) => {
  const bal = balances(req); const mats = mine(col("btpMaterials"), req);
  res.json(mine(col("btpWarehouses"), req).map(w => {
    let value = 0, lines = 0;
    for (const m of mats) { const q = qtyAt(bal, m.id, w.id); if (q) { lines++; value += q * (m.avgCost || 0); } }
    return Object.assign({}, w, { typeLabel: WH_TYPES[w.type] || w.type, projectName: projName(req, w.projectId), materials: lines, value: R2(value) });
  }).sort((a, b) => a.name.localeCompare(b.name, "fr")));
});
router.post("/warehouses", allow(...CONFIG), (req, res) => {
  const w = stamp({ id: id("btw"), ref: str((req.body || {}).ref, 40) || nextRef(req, "btpWarehouses", "ENT", 3, false), type: "central", active: true, createdAt: new Date().toISOString() }, req);
  const err = applyWarehouse(req, w, req.body || {}); if (err) return bad(res, err);
  col("btpWarehouses").push(w); save(); audit(req.user, "CREATED", "BtpWarehouse", w.id, { name: w.name }); res.status(201).json(w);
});
router.put("/warehouses/:id", allow(...CONFIG), (req, res) => {
  const w = findMine("btpWarehouses", req, req.params.id); if (!w) return bad(res, "Entrepôt introuvable", 404);
  const before = JSON.stringify(w); const err = applyWarehouse(req, w, req.body || {});
  if (err) { Object.assign(w, JSON.parse(before)); return bad(res, err); }
  if ((req.body || {}).active === false) {
    const bal = balances(req);
    if (mine(col("btpMaterials"), req).some(m => qtyAt(bal, m.id, w.id) > 0)) { w.active = true; return bad(res, "Videz d'abord le stock de cet entrepôt (transfert) avant de le désactiver"); }
  }
  save(); audit(req.user, "UPDATED", "BtpWarehouse", w.id, {}); res.json(w);
});
router.get("/warehouses/:id/stock", allow(...READ), (req, res) => {
  const w = findMine("btpWarehouses", req, req.params.id); if (!w) return bad(res, "Entrepôt introuvable", 404);
  const bal = balances(req);
  res.json(mine(col("btpMaterials"), req).map(m => { const q = qtyAt(bal, m.id, w.id); return { materialId: m.id, ref: m.ref, name: m.name, unit: m.unit, qty: q, avgCost: m.avgCost || 0, value: R2(q * (m.avgCost || 0)) }; }).filter(x => x.qty));
});

/* ============================ Chantiers ============================ */
function applyProject(req, p, b) {
  for (const [k, n] of Object.entries({ name: 160, client: 160, description: 1000, location: 300, manager: 120 })) if (b[k] !== undefined) p[k] = str(b[k], n);
  for (const k of ["startDate", "endDate", "actualEndDate"]) if (b[k] !== undefined) { if (b[k] && !isDate(b[k])) return "Date invalide"; p[k] = b[k] || ""; }
  if (b.budget !== undefined) { const v = Number(b.budget); if (!(v >= 0)) return "Budget invalide"; p.budget = R2(v); }
  if (b.status !== undefined) { if (!PROJECT_STATUS[b.status]) return "Statut inconnu"; p.status = b.status; }
  if (p.startDate && p.endDate && p.endDate < p.startDate) return "La date de fin doit suivre la date de début";
  return p.name ? null : "Nom du chantier obligatoire";
}
function projectSummary(req, p) {
  const mv = mine(col("btpMovements"), req).filter(m => m.projectId === p.id);
  const sum = (types, sign) => R2(mv.filter(m => types.includes(m.type) && Math.sign(m.qty) === sign).reduce((s, m) => s + Math.abs(m.value), 0));
  const delivered = sum(["livraison"], 1), consumed = sum(["consommation"], -1), returned = sum(["retour"], -1);
  const wasted = R2(mv.filter(m => (m.type === "endommage" || m.type === "perte") && m.qty < 0).reduce((s, m) => s + Math.abs(m.value), 0));
  const pending = mine(col("btpRequests"), req).filter(r => r.projectId === p.id && ["soumise", "approuvee", "partielle", "livraison_partielle"].includes(r.status)).length;
  return { delivered, consumed, returned, wasted, materialCost: R2(consumed + wasted), pendingRequests: pending,
    budgetUsed: p.budget ? Math.round((consumed + wasted) / p.budget * 1000) / 10 : null };
}
router.get("/projects", allow(...READ), (req, res) => {
  res.json(mine(col("btpProjects"), req).map(p => Object.assign({}, p, { statusLabel: PROJECT_STATUS[p.status] || p.status,
    siteWarehouse: whName(req, p.siteWarehouseId) }, projectSummary(req, p))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
});
router.post("/projects", allow(...CONFIG), (req, res) => {
  const b = req.body || {};
  const p = stamp({ id: id("btp"), ref: str(b.ref, 40) || nextRef(req, "btpProjects", "CH"), status: "planifie", budget: 0, createdAt: new Date().toISOString(), createdBy: req.user.id }, req);
  const err = applyProject(req, p, b); if (err) return bad(res, err);
  col("btpProjects").push(p);
  if (b.createSiteWarehouse !== false) {   // un chantier a son propre magasin de stock
    const w = stamp({ id: id("btw"), ref: nextRef(req, "btpWarehouses", "ENT", 3, false), name: "Magasin " + p.name, type: "chantier",
      address: p.location || "", manager: p.manager || "", projectId: p.id, active: true, createdAt: new Date().toISOString() }, req);
    col("btpWarehouses").push(w); p.siteWarehouseId = w.id;
  }
  save(); audit(req.user, "CREATED", "BtpProject", p.id, { ref: p.ref, name: p.name }); res.status(201).json(p);
});
router.put("/projects/:id", allow(...CONFIG), (req, res) => {
  const p = findMine("btpProjects", req, req.params.id); if (!p) return bad(res, "Chantier introuvable", 404);
  const before = JSON.stringify(p); const err = applyProject(req, p, req.body || {});
  if (err) { Object.assign(p, JSON.parse(before)); return bad(res, err); }
  save(); audit(req.user, "UPDATED", "BtpProject", p.id, {}); res.json(p);
});
router.get("/projects/:id/summary", allow(...READ), (req, res) => {
  const p = findMine("btpProjects", req, req.params.id); if (!p) return bad(res, "Chantier introuvable", 404);
  const mv = mine(col("btpMovements"), req).filter(m => m.projectId === p.id);
  const bal = balances(req);
  const byMat = {};
  for (const m of mv) {
    const r = byMat[m.materialId] = byMat[m.materialId] || { materialId: m.materialId, name: matName(req, m.materialId), unit: m.unit, delivered: 0, consumed: 0, returned: 0, wasted: 0, cost: 0 };
    if (m.type === "livraison" && m.qty > 0) r.delivered = Q(r.delivered + m.qty);
    if (m.type === "consommation") { r.consumed = Q(r.consumed - m.qty); r.cost = R2(r.cost - m.value); }
    if (m.type === "retour" && m.qty < 0) r.returned = Q(r.returned - m.qty);
    if ((m.type === "endommage" || m.type === "perte") && m.qty < 0) { r.wasted = Q(r.wasted - m.qty); r.cost = R2(r.cost - m.value); }
  }
  const lines = Object.values(byMat).map(r => Object.assign(r, { onSite: p.siteWarehouseId ? qtyAt(bal, r.materialId, p.siteWarehouseId) : 0 }));
  const requests = mine(col("btpRequests"), req).filter(r => r.projectId === p.id).map(r => ({ id: r.id, ref: r.ref, status: r.status, statusLabel: REQ_STATUS[r.status], neededBy: r.neededBy }));
  res.json(Object.assign({}, p, projectSummary(req, p), { siteWarehouse: whName(req, p.siteWarehouseId), materials: lines, requests }));
});

/* ============================ Mouvements ============================ */
// Convertit une quantité saisie en unité d'achat vers l'unité de stock.
function toStockQty(req, l) {
  const m = findMine("btpMaterials", req, l.materialId); const q = Q(l.qty);
  return m && l.inPurchaseUnit && m.conversion > 0 ? Q(q * m.conversion) : q;
}
function buildLines(req, b) {
  const lines = []; const t = b.type;
  const src = b.warehouseId, dst = b.toWarehouseId;
  for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 200)) {
    const q = toStockQty(req, l); if (!l.materialId || !q) continue;
    const cost = l.inPurchaseUnit && l.unitCost != null ? R2(Number(l.unitCost) / ((findMine("btpMaterials", req, l.materialId) || {}).conversion || 1)) : l.unitCost;
    if (t === "initial" || t === "reception") lines.push({ materialId: l.materialId, warehouseId: src, qty: Math.abs(q), unitCost: cost });
    else if (t === "transfert" || t === "retour") lines.push({ materialId: l.materialId, warehouseId: src, qty: -Math.abs(q) }, { materialId: l.materialId, warehouseId: dst, qty: Math.abs(q) });
    else if (t === "ajustement") lines.push({ materialId: l.materialId, warehouseId: src, qty: q });
    else lines.push({ materialId: l.materialId, warehouseId: src, qty: -Math.abs(q) });   // consommation, retour_fournisseur, endommage, perte
  }
  return lines;
}
router.get("/movements", allow(...READ), (req, res) => {
  const f = req.query || {};
  let list = mine(col("btpMovements"), req);
  if (f.type) list = list.filter(m => m.type === f.type);
  if (f.projectId) list = list.filter(m => m.projectId === f.projectId);
  if (f.warehouseId) list = list.filter(m => m.warehouseId === f.warehouseId);
  if (f.materialId) list = list.filter(m => m.materialId === f.materialId);
  if (f.from) list = list.filter(m => m.date >= f.from);
  if (f.to) list = list.filter(m => m.date <= f.to);
  const reversed = new Set(mine(col("btpMovements"), req).filter(m => m.reversalOf).map(m => m.reversalOf));
  res.json(list.slice().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)).slice(0, Math.min(2000, Number(f.limit) || 500))
    .map(m => Object.assign({}, m, { typeLabel: MOVE_TYPES[m.type], material: matName(req, m.materialId), warehouse: whName(req, m.warehouseId),
      project: projName(req, m.projectId), reversed: reversed.has(m.ref) })));
});
router.post("/movements", allow(...WRITE), (req, res) => {
  const b = req.body || {}; const t = b.type;
  if (!MOVE_TYPES[t] || t === "livraison" || t === "annulation") return bad(res, t === "livraison" ? "Les livraisons chantier se font depuis « Livraisons » (bon de livraison)." : "Type de mouvement invalide");
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide (pas de date future)");
  if (!findMine("btpWarehouses", req, b.warehouseId)) return bad(res, "Entrepôt obligatoire");
  if ((t === "transfert" || t === "retour") && (!findMine("btpWarehouses", req, b.toWarehouseId) || b.toWarehouseId === b.warehouseId)) return bad(res, "Entrepôt de destination obligatoire et différent de l'origine");
  if (t === "consommation" && !findMine("btpProjects", req, b.projectId)) return bad(res, "Chantier obligatoire pour une consommation");
  if (b.projectId && !findMine("btpProjects", req, b.projectId)) return bad(res, "Chantier introuvable");
  if (["ajustement", "endommage", "perte"].includes(t) && !str(b.reason)) return bad(res, "Motif obligatoire pour ce type de mouvement");
  const r = post(req, { type: t, date, projectId: b.projectId || "", reason: str(b.reason, 500), activity: str(b.activity, 160),
    supplierId: str(b.supplierId, 40), docRef: str(b.docRef, 80), clientKey: str(b.clientKey, 80), lines: buildLines(req, b) });
  if (r.error) return bad(res, r.error);
  if (r.duplicate) return res.status(200).json({ ok: true, duplicate: true, ref: r.ref });
  res.status(201).json({ ok: true, ref: r.ref, lines: r.movements.length });
});
// Contre-passation d'une opération entière (jamais de suppression).
router.post("/movements/:ref/reverse", allow(...CONFIG), (req, res) => {
  const reason = str((req.body || {}).reason, 500); if (!reason) return bad(res, "Motif de la contre-passation obligatoire");
  const orig = mine(col("btpMovements"), req).filter(m => m.ref === req.params.ref && m.type !== "annulation");
  if (!orig.length) return bad(res, "Opération introuvable", 404);
  if (mine(col("btpMovements"), req).some(m => m.reversalOf === req.params.ref)) return bad(res, "Cette opération a déjà été contre-passée", 409);
  const r = post(req, { type: "annulation", date: today(), projectId: orig[0].projectId, reason, reversalOf: req.params.ref,
    sourceType: orig[0].sourceType, sourceId: orig[0].sourceId, lines: orig.map(m => ({ materialId: m.materialId, warehouseId: m.warehouseId, qty: -m.qty, unitCost: m.unitCost })) });
  if (r.error) return bad(res, r.error);
  if (orig[0].sourceType === "delivery") {
    const d = findMine("btpDeliveries", req, orig[0].sourceId);
    if (d) { d.status = "annulee"; d.cancelReason = reason; const rq = findMine("btpRequests", req, d.requestId); if (rq) refreshRequest(req, rq, "Livraison " + d.ref + " annulée"); save(); }
  }
  res.status(201).json({ ok: true, ref: r.ref });
});

/* ============================ Demandes de matériel ============================ */
function deliveredFor(req, rq) {
  const out = {};
  for (const d of mine(col("btpDeliveries"), req).filter(d => d.requestId === rq.id && d.status !== "annulee"))
    for (const l of d.lines) out[l.materialId] = Q((out[l.materialId] || 0) + l.qty);
  return out;
}
function refreshRequest(req, rq, note) {
  if (!["approuvee", "partielle", "livraison_partielle", "livree"].includes(rq.status)) return;
  const del = deliveredFor(req, rq);
  const lines = rq.lines.filter(l => l.approvedQty > 0);
  const all = lines.length && lines.every(l => (del[l.materialId] || 0) >= l.approvedQty);
  const any = lines.some(l => (del[l.materialId] || 0) > 0);
  const st = all ? "livree" : any ? "livraison_partielle" : (rq.lines.every(l => l.approvedQty >= l.qty) ? "approuvee" : "partielle");
  if (st !== rq.status) { rq.status = st; rq.history.push({ at: new Date().toISOString(), by: "Système", action: REQ_STATUS[st], note: note || "" }); }
}
function requestOut(req, rq) {
  const del = deliveredFor(req, rq);
  return Object.assign({}, rq, { statusLabel: REQ_STATUS[rq.status], project: projName(req, rq.projectId), warehouse: whName(req, rq.warehouseId),
    lines: rq.lines.map(l => Object.assign({}, l, { material: matName(req, l.materialId), unit: (findMine("btpMaterials", req, l.materialId) || {}).unit || "", delivered: del[l.materialId] || 0 })) });
}
const canSeeAll = (req) => ["ADM", "CD", "RJ", "RS"].includes(req.user.role);
router.get("/requests", allow(...READ), (req, res) => {
  let list = mine(col("btpRequests"), req);
  if (!canSeeAll(req)) list = list.filter(r => r.createdBy === req.user.id);
  if (req.query.status) list = list.filter(r => r.status === req.query.status);
  if (req.query.projectId) list = list.filter(r => r.projectId === req.query.projectId);
  res.json(list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(r => requestOut(req, r)));
});
router.post("/requests", allow(...READ), (req, res) => {
  const b = req.body || {};
  if (!findMine("btpProjects", req, b.projectId)) return bad(res, "Chantier obligatoire");
  if (!findMine("btpWarehouses", req, b.warehouseId)) return bad(res, "Entrepôt fournisseur obligatoire");
  if (b.neededBy && !isDate(b.neededBy)) return bad(res, "Date souhaitée invalide");
  const seen = new Set(); const lines = [];
  for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 100)) {
    const q = Q(l.qty); if (!findMine("btpMaterials", req, l.materialId) || !(q > 0) || seen.has(l.materialId)) continue;
    seen.add(l.materialId); lines.push({ materialId: l.materialId, qty: q, approvedQty: 0 });
  }
  if (!lines.length) return bad(res, "Ajoutez au moins un matériau avec une quantité");
  const rq = stamp({ id: id("btr"), ref: nextRef(req, "btpRequests", "DM"), projectId: b.projectId, warehouseId: b.warehouseId,
    neededBy: b.neededBy || "", priority: ["basse", "normale", "haute", "urgente"].includes(b.priority) ? b.priority : "normale",
    reason: str(b.reason, 1000), lines, status: "brouillon", createdBy: req.user.id, createdByName: req.user.fullName || "",
    createdAt: new Date().toISOString(), history: [{ at: new Date().toISOString(), by: req.user.fullName || "", action: "Créée" }] }, req);
  col("btpRequests").push(rq);
  if (b.submit) submitRequest(req, rq);
  save(); audit(req.user, "CREATED", "BtpRequest", rq.id, { ref: rq.ref }); res.status(201).json(requestOut(req, rq));
});
function submitRequest(req, rq) {
  rq.status = "soumise"; rq.submittedAt = new Date().toISOString();
  rq.history.push({ at: rq.submittedAt, by: req.user.fullName || "", action: "Soumise" });
  try { require("../notify").toRolesTenant(["ADM", "CD"], req.user.tenantId || "t1", `Demande de matériel ${rq.ref} à valider`,
    `${req.user.fullName || "Un utilisateur"} demande du matériel pour le chantier « ${projName(req, rq.projectId)} ».`, rq.id); } catch (e) {}
}
const ownRequest = (req, rid) => { const r = findMine("btpRequests", req, rid); return r && (canSeeAll(req) || r.createdBy === req.user.id) ? r : null; };
router.post("/requests/:id/submit", allow(...READ), (req, res) => {
  const rq = ownRequest(req, req.params.id); if (!rq) return bad(res, "Demande introuvable", 404);
  if (rq.status !== "brouillon") return bad(res, "Seul un brouillon peut être soumis");
  submitRequest(req, rq); save(); res.json(requestOut(req, rq));
});
router.post("/requests/:id/approve", allow(...APPROVE), (req, res) => {
  const rq = findMine("btpRequests", req, req.params.id); if (!rq) return bad(res, "Demande introuvable", 404);
  if (rq.status !== "soumise") return bad(res, "Seule une demande soumise peut être approuvée");
  const given = {}; for (const l of ((req.body || {}).lines || [])) given[l.materialId] = Q(l.approvedQty);
  for (const l of rq.lines) {
    const a = given[l.materialId] !== undefined ? given[l.materialId] : l.qty;
    if (!(a >= 0) || a > l.qty) return bad(res, `Quantité approuvée invalide pour « ${matName(req, l.materialId)} » (0 à ${l.qty})`);
    l.approvedQty = a;
  }
  if (!rq.lines.some(l => l.approvedQty > 0)) return bad(res, "Approuvez au moins une quantité, ou rejetez la demande");
  rq.status = rq.lines.every(l => l.approvedQty === l.qty) ? "approuvee" : "partielle";
  rq.approvedBy = req.user.id; rq.approvedAt = new Date().toISOString();
  rq.history.push({ at: rq.approvedAt, by: req.user.fullName || "", action: REQ_STATUS[rq.status], note: str((req.body || {}).note, 500) });
  save(); audit(req.user, "APPROVED", "BtpRequest", rq.id, { status: rq.status });
  try { require("../notify").toUser(rq.createdBy, `Demande ${rq.ref} : ${REQ_STATUS[rq.status].toLowerCase()}`, `Votre demande de matériel pour « ${projName(req, rq.projectId)} » a été ${REQ_STATUS[rq.status].toLowerCase()}.`, rq.id); } catch (e) {}
  res.json(requestOut(req, rq));
});
router.post("/requests/:id/reject", allow(...APPROVE), (req, res) => {
  const rq = findMine("btpRequests", req, req.params.id); if (!rq) return bad(res, "Demande introuvable", 404);
  if (rq.status !== "soumise") return bad(res, "Seule une demande soumise peut être rejetée");
  const note = str((req.body || {}).note, 500); if (!note) return bad(res, "Motif du rejet obligatoire");
  rq.status = "rejetee"; rq.history.push({ at: new Date().toISOString(), by: req.user.fullName || "", action: "Rejetée", note });
  save(); audit(req.user, "REJECTED", "BtpRequest", rq.id, { note });
  try { require("../notify").toUser(rq.createdBy, `Demande ${rq.ref} rejetée`, `Motif : ${note}`, rq.id); } catch (e) {}
  res.json(requestOut(req, rq));
});
router.post("/requests/:id/cancel", allow(...READ), (req, res) => {
  const rq = ownRequest(req, req.params.id); if (!rq) return bad(res, "Demande introuvable", 404);
  if (!["brouillon", "soumise", "approuvee", "partielle"].includes(rq.status)) return bad(res, "Cette demande ne peut plus être annulée");
  rq.status = "annulee"; rq.history.push({ at: new Date().toISOString(), by: req.user.fullName || "", action: "Annulée", note: str((req.body || {}).note, 500) });
  save(); audit(req.user, "CANCELLED", "BtpRequest", rq.id, {}); res.json(requestOut(req, rq));
});

/* ============================ Livraisons chantier (bons de livraison) ============================ */
router.get("/deliveries", allow(...READ), (req, res) => {
  let list = mine(col("btpDeliveries"), req);
  if (req.query.projectId) list = list.filter(d => d.projectId === req.query.projectId);
  res.json(list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(d => Object.assign({}, d, {
    project: projName(req, d.projectId), from: whName(req, d.fromWarehouseId), to: whName(req, d.toWarehouseId),
    request: (findMine("btpRequests", req, d.requestId) || {}).ref || "",
    lines: d.lines.map(l => Object.assign({}, l, { material: matName(req, l.materialId), unit: (findMine("btpMaterials", req, l.materialId) || {}).unit || "" })) })));
});
router.post("/deliveries", allow(...WRITE), (req, res) => {
  const b = req.body || {};
  const p = findMine("btpProjects", req, b.projectId); if (!p) return bad(res, "Chantier obligatoire");
  const from = findMine("btpWarehouses", req, b.fromWarehouseId); if (!from) return bad(res, "Entrepôt d'expédition obligatoire");
  const toId = b.toWarehouseId || p.siteWarehouseId;
  if (!findMine("btpWarehouses", req, toId) || toId === from.id) return bad(res, "Magasin de chantier de destination obligatoire et différent de l'expédition");
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide (pas de date future)");
  if (b.clientKey) { const dup = mine(col("btpDeliveries"), req).find(d => d.clientKey === b.clientKey); if (dup) return res.json(Object.assign({ duplicate: true }, dup)); }
  const seen = new Set(); const lines = [];
  for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 200)) {
    const q = Q(l.qty); if (!findMine("btpMaterials", req, l.materialId) || !(q > 0) || seen.has(l.materialId)) continue;
    seen.add(l.materialId); lines.push({ materialId: l.materialId, qty: q });
  }
  if (!lines.length) return bad(res, "Ajoutez au moins un matériau avec une quantité");
  let rq = null;
  if (b.requestId) {
    rq = findMine("btpRequests", req, b.requestId); if (!rq) return bad(res, "Demande introuvable");
    if (!["approuvee", "partielle", "livraison_partielle"].includes(rq.status)) return bad(res, "La demande doit être approuvée avant livraison");
    if (rq.projectId !== p.id) return bad(res, "La demande concerne un autre chantier");
    const del = deliveredFor(req, rq);
    for (const l of lines) {
      const rl = rq.lines.find(x => x.materialId === l.materialId);
      const left = rl ? Q(rl.approvedQty - (del[l.materialId] || 0)) : 0;
      if (l.qty > left) return bad(res, `« ${matName(req, l.materialId)} » : au plus ${left} restant à livrer sur cette demande`);
    }
  }
  const d = stamp({ id: id("btd"), ref: nextRef(req, "btpDeliveries", "BL"), projectId: p.id, requestId: rq ? rq.id : "",
    fromWarehouseId: from.id, toWarehouseId: toId, date, lines, receivedBy: str(b.receivedBy, 120), carrier: str(b.carrier, 120),
    note: str(b.note, 1000), status: "livree", clientKey: str(b.clientKey, 80), createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: new Date().toISOString() }, req);
  const r = post(req, { type: "livraison", date, projectId: p.id, reason: "Bon de livraison " + d.ref, docRef: d.ref, sourceType: "delivery", sourceId: d.id,
    lines: lines.flatMap(l => [{ materialId: l.materialId, warehouseId: from.id, qty: -l.qty }, { materialId: l.materialId, warehouseId: toId, qty: l.qty }]) });
  if (r.error) return bad(res, r.error);
  d.movementRef = r.ref; col("btpDeliveries").push(d);
  if (rq) refreshRequest(req, rq, "Livraison " + d.ref);
  save(); audit(req.user, "CREATED", "BtpDelivery", d.id, { ref: d.ref, projectId: p.id });
  res.status(201).json(d);
});
router.get("/deliveries/:id/pdf", allow(...READ), (req, res) => {
  const d = findMine("btpDeliveries", req, req.params.id); if (!d) return bad(res, "Bon de livraison introuvable", 404);
  const PDFDocument = require("pdfkit");
  const brand = require("./settings").settings(req).branding || {}; const co = brand.company || {};
  const tenant = (db.tenants || []).find(t => t.id === (req.user.tenantId || "t1")) || {};
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${d.ref}.pdf"`);
  doc.pipe(res);
  const fr = s => s ? s.split("-").reverse().join("/") : "";
  doc.font("Helvetica-Bold").fontSize(13).text(co.name || tenant.name || "", 40, 40);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text([co.address, co.city].filter(Boolean).join(" - "), 40, 58);
  doc.fillColor("#0f766e").font("Helvetica-Bold").fontSize(18).text("BON DE LIVRAISON", 300, 40, { width: 255, align: "right" });
  doc.fillColor("#000").font("Helvetica").fontSize(10).text(`N° ${d.ref}`, 300, 64, { width: 255, align: "right" }).text(`Date : ${fr(d.date)}`, 300, 78, { width: 255, align: "right" });
  doc.moveTo(40, 100).lineTo(555, 100).strokeColor("#0f766e").stroke();
  const p = findMine("btpProjects", req, d.projectId) || {};
  const info = [["Chantier", `${p.ref || ""} - ${p.name || ""}`], ["Expédié de", whName(req, d.fromWarehouseId)], ["Livré à", whName(req, d.toWarehouseId)],
    ["Demande", (findMine("btpRequests", req, d.requestId) || {}).ref || "-"], ["Transporteur", d.carrier || "-"]];
  let y = 112; for (const [k, v] of info) { doc.font("Helvetica-Bold").fontSize(10).text(k + " :", 40, y, { width: 100 }); doc.font("Helvetica").text(v, 140, y, { width: 415 }); y += 16; }
  y += 8; doc.rect(40, y, 515, 20).fill("#0f766e"); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10);
  doc.text("Référence", 46, y + 6, { width: 90 }).text("Désignation", 140, y + 6, { width: 260 }).text("Unité", 400, y + 6, { width: 50 }).text("Quantité", 455, y + 6, { width: 94, align: "right" });
  y += 24; doc.fillColor("#000").font("Helvetica");
  for (const l of d.lines) {
    const m = findMine("btpMaterials", req, l.materialId) || {};
    if (y > 720) { doc.addPage(); y = 40; }
    doc.text(m.ref || "", 46, y, { width: 90 }).text(m.name || "", 140, y, { width: 260 }).text(m.unit || "", 400, y, { width: 50 }).text(String(l.qty).replace(".", ","), 455, y, { width: 94, align: "right" });
    y += 18; doc.moveTo(40, y - 4).lineTo(555, y - 4).strokeColor("#e5e7eb").stroke();
  }
  if (d.note) { y += 8; doc.font("Helvetica-Oblique").fontSize(9).text("Observations : " + d.note, 40, y, { width: 515 }); y = doc.y + 6; }
  if (d.status === "annulee") { doc.fillColor("#b91c1c").font("Helvetica-Bold").fontSize(14).text("ANNULÉ - " + (d.cancelReason || ""), 40, y + 6); doc.fillColor("#000"); y = doc.y + 6; }
  y = Math.max(y + 30, 640);
  doc.font("Helvetica-Bold").fontSize(10).text("Expéditeur", 40, y, { width: 240 }).text("Réceptionnaire" + (d.receivedBy ? " : " + d.receivedBy : ""), 315, y, { width: 240 });
  doc.rect(40, y + 16, 240, 60).strokeColor("#9ca3af").stroke(); doc.rect(315, y + 16, 240, 60).stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Nom, date et signature", 44, y + 64).text("Nom, date et signature", 319, y + 64);
  doc.end();
});

/* ============================ Tableau de bord ============================ */
router.get("/dashboard", allow(...READ), (req, res) => {
  const bal = balances(req); const mats = mine(col("btpMaterials"), req); const whs = mine(col("btpWarehouses"), req);
  const projects = mine(col("btpProjects"), req); const mv = mine(col("btpMovements"), req);
  const month = today().slice(0, 7);
  let value = 0, low = 0, out = 0;
  const lowList = [];
  for (const m of mats.filter(m => m.active !== false)) {
    const q = totalQty(bal, m.id); value += q * (m.avgCost || 0);
    const st = stockState(m, q); if (st === "bas") low++; if (st === "rupture") out++;
    if (st !== "ok") lowList.push({ id: m.id, ref: m.ref, name: m.name, unit: m.unit, qty: q, threshold: m.reorderLevel || m.minStock || 0, state: st });
  }
  const consumedMonth = R2(mv.filter(m => m.type === "consommation" && m.date.startsWith(month)).reduce((s, m) => s - m.value, 0));
  const byWarehouse = whs.filter(w => w.active !== false).map(w => ({ name: w.name, value: R2(mats.reduce((s, m) => s + qtyAt(bal, m.id, w.id) * (m.avgCost || 0), 0)) }))
    .filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  const byCategory = {}; for (const m of mats) { const c = (findMine("btpCategories", req, m.categoryId) || {}).name || "Sans catégorie"; byCategory[c] = R2((byCategory[c] || 0) + totalQty(bal, m.id) * (m.avgCost || 0)); }
  const months = []; const d0 = new Date(); d0.setDate(1);
  for (let i = 5; i >= 0; i--) { const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1); months.push(d.toISOString().slice(0, 7)); }
  const monthly = months.map(mo => ({ month: mo,
    in: R2(mv.filter(m => m.date.startsWith(mo) && (m.type === "reception" || m.type === "initial")).reduce((s, m) => s + m.value, 0)),
    out: R2(mv.filter(m => m.date.startsWith(mo) && ["consommation", "endommage", "perte", "retour_fournisseur"].includes(m.type)).reduce((s, m) => s - m.value, 0)) }));
  const projectsOut = projects.filter(p => !["annule", "brouillon"].includes(p.status)).map(p => Object.assign({ name: p.name, budget: p.budget || 0, status: p.status }, projectSummary(req, p)));
  const topConsumed = {}; for (const m of mv.filter(m => m.type === "consommation")) topConsumed[m.materialId] = R2((topConsumed[m.materialId] || 0) - m.value);
  res.json({
    kpis: { materials: mats.filter(m => m.active !== false).length, stockValue: R2(value), warehouses: whs.filter(w => w.active !== false).length,
      activeProjects: projects.filter(p => p.status === "actif").length,
      pendingRequests: mine(col("btpRequests"), req).filter(r => r.status === "soumise").length,
      toDeliver: mine(col("btpRequests"), req).filter(r => ["approuvee", "partielle", "livraison_partielle"].includes(r.status)).length,
      lowStock: low, outOfStock: out, consumedMonth },
    byWarehouse, byCategory: Object.entries(byCategory).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    monthly, projects: projectsOut.sort((a, b) => b.materialCost - a.materialCost).slice(0, 8),
    topConsumed: Object.entries(topConsumed).map(([mid, v]) => ({ name: matName(req, mid), value: v })).sort((a, b) => b.value - a.value).slice(0, 5),
    lowList: lowList.sort((a, b) => a.qty - b.qty).slice(0, 10),
  });
});

/* ============================ Exports Excel ============================ */
function sendXlsx(res, name, sheets) {
  const XLSX = require("xlsx"); const wb = XLSX.utils.book_new();
  for (const [title, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), title.slice(0, 31));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
router.get("/export/stock.xlsx", allow(...READ), (req, res) => {
  const bal = balances(req); const mats = mine(col("btpMaterials"), req); let whs = mine(col("btpWarehouses"), req);
  if (req.query.warehouseId) whs = whs.filter(w => w.id === req.query.warehouseId);
  const rows = [["Entrepôt", "Référence", "Matériau", "Catégorie", "Unité", "Quantité", "CUMP", "Valeur"]];
  for (const w of whs) for (const m of mats) { const q = qtyAt(bal, m.id, w.id); if (q) rows.push([w.name, m.ref, m.name, (findMine("btpCategories", req, m.categoryId) || {}).name || "", m.unit, q, m.avgCost || 0, R2(q * (m.avgCost || 0))]); }
  const tot = [["Référence", "Matériau", "Unité", "Stock total", "Seuil de réappro.", "État", "CUMP", "Valeur"]];
  for (const m of mats) { const q = totalQty(bal, m.id); tot.push([m.ref, m.name, m.unit, q, m.reorderLevel || m.minStock || 0, { ok: "OK", bas: "Stock bas", rupture: "Rupture" }[stockState(m, q)], m.avgCost || 0, R2(q * (m.avgCost || 0))]); }
  sendXlsx(res, "stock-btp-" + today(), [["Stock par entrepôt", rows], ["Stock total", tot]]);
});
router.get("/export/movements.xlsx", allow(...READ), (req, res) => {
  const f = req.query || {}; let list = mine(col("btpMovements"), req);
  if (f.projectId) list = list.filter(m => m.projectId === f.projectId);
  if (f.warehouseId) list = list.filter(m => m.warehouseId === f.warehouseId);
  if (f.type) list = list.filter(m => m.type === f.type);
  if (f.from) list = list.filter(m => m.date >= f.from);
  if (f.to) list = list.filter(m => m.date <= f.to);
  const rows = [["Date", "Opération", "Type", "Matériau", "Entrepôt", "Chantier", "Quantité", "Unité", "Coût unitaire", "Valeur", "Motif", "Saisi par"]];
  for (const m of list.slice().sort((a, b) => a.date.localeCompare(b.date)))
    rows.push([m.date, m.ref, MOVE_TYPES[m.type], matName(req, m.materialId), whName(req, m.warehouseId), projName(req, m.projectId), m.qty, m.unit, m.unitCost, m.value, m.reason, m.createdByName]);
  sendXlsx(res, "mouvements-btp-" + today(), [["Mouvements", rows]]);
});

module.exports = router;
