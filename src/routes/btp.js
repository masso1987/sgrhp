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

const COLS = ["btpCategories", "btpMaterials", "btpWarehouses", "btpProjects", "btpMovements", "btpRequests", "btpDeliveries",
  "btpBrands", "btpPOs", "btpPurchases", "btpPayments", "btpSupplierReturns", "btpExpenses", "btpExpenseCats", "btpAccounts", "btpAccountEntries", "btpNotifTemplates", "stockContacts"];
const col = (k) => db[k] || (db[k] = []);
COLS.forEach(col);

const READ = ["ADM", "CD", "RJ", "GPF", "RS"];
const WRITE = ["ADM", "CD", "GPF", "RS"];
const CONFIG = ["ADM", "CD", "RS"];
const APPROVE = ["ADM", "CD"];

const Q = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const R2 = (n) => Math.round(Number((Number(n) || 0).toFixed(6)) * 100) / 100;   // toFixed first: 28321.875 rounds to .88, not .87
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
  ajustement: "Ajustement", endommage: "Matériel endommagé", perte: "Perte / manquant", dotation: "Dotation EPI", annulation: "Contre-passation",
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
      clientKey: op.clientKey || "", employeeId: op.employeeId || "", createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: at });
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
    if (st !== "ok") btpNotify(req, "low_stock", { state: st === "rupture" ? "Rupture de stock" : "Stock bas", material: m.name, qty: q, unit: m.unit, threshold: m.reorderLevel || m.minStock || 0 }, {});
  }
}

/* ============================ Modèles de notification ============================ */
const NOTIF_DEFAULTS = {
  request_submitted: { label: "Demande de matériel soumise (aux responsables)", subject: "Demande de matériel {{ref}} à valider", body: "{{user}} demande du matériel pour le chantier « {{chantier}} »." },
  request_decided: { label: "Demande approuvée (au demandeur)", subject: "Demande {{ref}} : {{status}}", body: "Votre demande de matériel pour « {{chantier}} » a été {{status}}." },
  request_rejected: { label: "Demande rejetée (au demandeur)", subject: "Demande {{ref}} rejetée", body: "Votre demande pour « {{chantier}} » a été rejetée. Motif : {{note}}" },
  delivery_done: { label: "Livraison effectuée (au demandeur)", subject: "Livraison {{ref}} - {{chantier}}", body: "Le bon de livraison {{ref}} a été validé ({{lines}} ligne(s)), réceptionné par {{receiver}}." },
  low_stock: { label: "Stock bas ou rupture (aux responsables)", subject: "{{state}} : {{material}}", body: "Stock restant de « {{material}} » : {{qty}} {{unit}} (seuil {{threshold}})." },
  po_received: { label: "Commande fournisseur reçue (aux responsables)", subject: "Commande {{ref}} : {{status}}", body: "La commande {{ref}} du fournisseur {{supplier}} est {{status}}." },
};
function notifTemplate(req, key) {
  const t = mine(col("btpNotifTemplates"), req).find(x => x.key === key);
  return Object.assign({ key, enabled: true }, NOTIF_DEFAULTS[key], t ? { subject: t.subject, body: t.body, enabled: t.enabled !== false, custom: true } : {});
}
// to: { userId } for one user, otherwise the company's ADM and CD.
function btpNotify(req, key, vars, to) {
  const t = notifTemplate(req, key); if (!t.enabled) return;
  const fill = s => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] != null ? String(vars[k]) : "");
  try {
    const n = require("../notify");
    if (to.userId) n.toUser(to.userId, fill(t.subject), fill(t.body), to.ref || null);
    else n.toRolesTenant(["ADM", "CD"], req.user.tenantId || "t1", fill(t.subject), fill(t.body), to.ref || null);
  } catch (e) {}
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
const MAT_TEXT = { name: 120, description: 600, barcode: 60, supplierId: 40, categoryId: 40, brandId: 40 };
function materialOut(req, m, bal) {
  const qty = totalQty(bal, m.id);
  return Object.assign({}, m, { qty, value: R2(qty * (m.avgCost || 0)), state: stockState(m, qty),
    categoryName: (findMine("btpCategories", req, m.categoryId) || {}).name || "", brandName: (findMine("btpBrands", req, m.brandId) || {}).name || "",
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
  if (m.brandId && !findMine("btpBrands", req, m.brandId)) return "Marque introuvable";
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
  for (const [k, n] of Object.entries({ name: 160, client: 160, clientId: 40, description: 1000, location: 300, manager: 120 })) if (b[k] !== undefined) p[k] = str(b[k], n);
  for (const k of ["startDate", "endDate", "actualEndDate"]) if (b[k] !== undefined) { if (b[k] && !isDate(b[k])) return "Date invalide"; p[k] = b[k] || ""; }
  if (b.budget !== undefined) { const v = Number(b.budget); if (!(v >= 0)) return "Budget invalide"; p.budget = R2(v); }
  if (b.status !== undefined) { if (!PROJECT_STATUS[b.status]) return "Statut inconnu"; p.status = b.status; }
  if (p.clientId && !mine(col("stockContacts"), req).some(c => c.id === p.clientId && c.type === "client")) return "Client introuvable";
  if (p.startDate && p.endDate && p.endDate < p.startDate) return "La date de fin doit suivre la date de début";
  return p.name ? null : "Nom du chantier obligatoire";
}
const reversedRefs = (req) => new Set(mine(col("btpMovements"), req).filter(m => m.reversalOf).map(m => m.reversalOf));
// Coût d'un chantier = matériaux consommés + casse/pertes + EPI distribués + dépenses (hors opérations contre-passées).
function projectSummary(req, p) {
  const rev = reversedRefs(req);
  const mv = mine(col("btpMovements"), req).filter(m => m.projectId === p.id && !rev.has(m.ref) && m.type !== "annulation");
  const sum = (types, sign) => R2(mv.filter(m => types.includes(m.type) && Math.sign(m.qty) === sign).reduce((s, m) => s + Math.abs(m.value), 0));
  const delivered = sum(["livraison"], 1), consumed = sum(["consommation"], -1), returned = sum(["retour"], -1);
  const wasted = sum(["endommage", "perte"], -1), epi = sum(["dotation"], -1);
  const expenses = R2(mine(col("btpExpenses"), req).filter(e => e.projectId === p.id).reduce((s, e) => s + (e.amount || 0), 0));
  const pending = mine(col("btpRequests"), req).filter(r => r.projectId === p.id && ["soumise", "approuvee", "partielle", "livraison_partielle"].includes(r.status)).length;
  const materialCost = R2(consumed + wasted + epi), totalCost = R2(materialCost + expenses);
  return { delivered, consumed, returned, wasted, epi, expenses, materialCost, totalCost, pendingRequests: pending,
    clientName: (mine(col("stockContacts"), req).find(c => c.id === p.clientId) || {}).name || p.client || "",
    budgetUsed: p.budget ? Math.round(totalCost / p.budget * 1000) / 10 : null };
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
  const rev = reversedRefs(req);
  const mv = mine(col("btpMovements"), req).filter(m => m.projectId === p.id && !rev.has(m.ref) && m.type !== "annulation");
  const bal = balances(req);
  const byMat = {};
  for (const m of mv) {
    const r = byMat[m.materialId] = byMat[m.materialId] || { materialId: m.materialId, name: matName(req, m.materialId), unit: m.unit, delivered: 0, consumed: 0, returned: 0, wasted: 0, cost: 0 };
    if (m.type === "livraison" && m.qty > 0) r.delivered = Q(r.delivered + m.qty);
    if (m.type === "consommation") { r.consumed = Q(r.consumed - m.qty); r.cost = R2(r.cost - m.value); }
    if (m.type === "retour" && m.qty < 0) r.returned = Q(r.returned - m.qty);
    if ((m.type === "endommage" || m.type === "perte") && m.qty < 0) { r.wasted = Q(r.wasted - m.qty); r.cost = R2(r.cost - m.value); }
    if (m.type === "dotation" && m.qty < 0) { r.epi = Q((r.epi || 0) - m.qty); r.cost = R2(r.cost - m.value); }
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
  const blocked = reverseBlocked(req, orig[0]); if (blocked) return bad(res, blocked);
  const r = post(req, { type: "annulation", date: today(), projectId: orig[0].projectId, reason, reversalOf: req.params.ref,
    sourceType: orig[0].sourceType, sourceId: orig[0].sourceId, lines: orig.map(m => ({ materialId: m.materialId, warehouseId: m.warehouseId, qty: -m.qty, unitCost: m.unitCost })) });
  if (r.error) return bad(res, r.error);
  afterReverse(req, orig[0], reason);
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
  btpNotify(req, "request_submitted", { ref: rq.ref, user: req.user.fullName || "Un utilisateur", chantier: projName(req, rq.projectId) }, { ref: rq.id });
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
  btpNotify(req, "request_decided", { ref: rq.ref, status: REQ_STATUS[rq.status].toLowerCase(), chantier: projName(req, rq.projectId) }, { userId: rq.createdBy, ref: rq.id });
  res.json(requestOut(req, rq));
});
router.post("/requests/:id/reject", allow(...APPROVE), (req, res) => {
  const rq = findMine("btpRequests", req, req.params.id); if (!rq) return bad(res, "Demande introuvable", 404);
  if (rq.status !== "soumise") return bad(res, "Seule une demande soumise peut être rejetée");
  const note = str((req.body || {}).note, 500); if (!note) return bad(res, "Motif du rejet obligatoire");
  rq.status = "rejetee"; rq.history.push({ at: new Date().toISOString(), by: req.user.fullName || "", action: "Rejetée", note });
  save(); audit(req.user, "REJECTED", "BtpRequest", rq.id, { note });
  btpNotify(req, "request_rejected", { ref: rq.ref, note, chantier: projName(req, rq.projectId) }, { userId: rq.createdBy, ref: rq.id });
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
  if (rq) btpNotify(req, "delivery_done", { ref: d.ref, chantier: p.name, lines: lines.length, receiver: d.receivedBy || "-" }, { userId: rq.createdBy, ref: rq.id });
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
  const projects = mine(col("btpProjects"), req); const rev = reversedRefs(req); const mv = mine(col("btpMovements"), req).filter(m => !rev.has(m.ref) && m.type !== "annulation");
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
      lowStock: low, outOfStock: out, consumedMonth,
      openPOs: mine(col("btpPOs"), req).filter(p => ["envoye", "partiel"].includes(p.status)).length,
      payables: R2(mine(col("btpPurchases"), req).filter(p => p.status !== "annulee").reduce((s, p) => s + Math.max(0, purchaseOut(req, p).due), 0)) },
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

/* ============================ Tiers : fournisseurs & clients (partagés avec le module Stock) ============================
 * Mêmes fiches que Stock › Fournisseurs / Clients (collection stockContacts), utilisables même
 * quand la société n'a que le module BTP. */
const CONTACT_TEXT = { name: 160, contactId: 20, entityType: 20, mobile: 40, altPhone: 40, email: 120, taxId: 40, rccm: 60,
  paymentTerms: 60, address1: 200, city: 80, country: 80, contactPerson: 120, bankInfo: 300, note: 1000 };
function nextContactRef(req, type) {
  const pre = type === "client" ? "CLI" : "FRN"; const used = new Set(mine(col("stockContacts"), req).map(c => c.contactId));
  let n = mine(col("stockContacts"), req).filter(c => (c.type || "fournisseur") === type).length + 1, cid;
  do { cid = pre + String(n).padStart(4, "0"); n++; } while (used.has(cid));
  return cid;
}
function contactRoutes(path, type) {
  const list = (req) => mine(col("stockContacts"), req).filter(c => (c.type || "fournisseur") === type);
  router.get("/" + path, allow(...READ), (req, res) => res.json(list(req).map(c => Object.assign({}, c, type === "fournisseur" ? { balance: supplierStatement(req, c).balance } : {}))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "fr"))));
  router.post("/" + path, allow(...WRITE), (req, res) => {
    const b = req.body || {}; if (!str(b.name)) return bad(res, "Nom obligatoire");
    const cid = str(b.contactId, 20) || nextContactRef(req, type);
    if (mine(col("stockContacts"), req).some(c => c.contactId === cid)) return bad(res, "Identifiant déjà utilisé : " + cid, 409);
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim())) return bad(res, "Email invalide");
    const c = stamp({ id: id("ctc"), type, createdAt: new Date().toISOString() }, req);
    for (const [k, n] of Object.entries(CONTACT_TEXT)) if (b[k] !== undefined) c[k] = str(b[k], n);
    c.contactId = cid; c.openingBalance = R2(b.openingBalance);
    col("stockContacts").push(c); save(); audit(req.user, "CREATED", "StockContact", c.id, { type, name: c.name, from: "btp" }); res.status(201).json(c);
  });
  router.put("/" + path + "/:id", allow(...WRITE), (req, res) => {
    const c = list(req).find(x => x.id === req.params.id); if (!c) return bad(res, "Fiche introuvable", 404);
    const b = req.body || {};
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim())) return bad(res, "Email invalide");
    for (const [k, n] of Object.entries(CONTACT_TEXT)) if (b[k] !== undefined && k !== "contactId") c[k] = str(b[k], n);
    if (b.name !== undefined && !c.name) return bad(res, "Nom obligatoire");
    if (b.openingBalance !== undefined) c.openingBalance = R2(b.openingBalance);
    save(); audit(req.user, "UPDATED", "StockContact", c.id, { from: "btp" }); res.json(c);
  });
}
contactRoutes("suppliers", "fournisseur");
contactRoutes("clients", "client");
const supplierOf = (req, sid) => mine(col("stockContacts"), req).find(c => c.id === sid && (c.type || "fournisseur") === "fournisseur");

/* ============================ Marques ============================ */
router.get("/brands", allow(...READ), (req, res) => res.json(mine(col("btpBrands"), req).slice().sort((a, b) => a.name.localeCompare(b.name, "fr"))));
router.post("/brands", allow(...CONFIG), (req, res) => {
  const name = str((req.body || {}).name, 80); if (!name) return bad(res, "Nom obligatoire");
  if (mine(col("btpBrands"), req).some(c => c.name.toLowerCase() === name.toLowerCase())) return bad(res, "Cette marque existe déjà", 409);
  const c = stamp({ id: id("btb"), name, createdAt: new Date().toISOString() }, req); col("btpBrands").push(c); save(); res.status(201).json(c);
});
router.put("/brands/:id", allow(...CONFIG), (req, res) => {
  const c = findMine("btpBrands", req, req.params.id); if (!c) return bad(res, "Marque introuvable", 404);
  const name = str((req.body || {}).name, 80); if (!name) return bad(res, "Nom obligatoire"); c.name = name; save(); res.json(c);
});
router.delete("/brands/:id", allow(...CONFIG), (req, res) => {
  const c = findMine("btpBrands", req, req.params.id); if (!c) return bad(res, "Marque introuvable", 404);
  if (mine(col("btpMaterials"), req).some(m => m.brandId === c.id)) return bad(res, "Marque utilisée par des matériaux : impossible de la supprimer");
  col("btpBrands").splice(col("btpBrands").indexOf(c), 1); save(); res.json({ ok: true });
});

/* ============================ Achats : bons de commande, réceptions facturées, paiements, retours ============================ */
// Ligne d'achat : quantité et prix ramenés à l'unité de stock ; montants HT, TVA, TTC calculés côté serveur.
function priceLines(req, raw) {
  const out = [];
  for (const l of (Array.isArray(raw) ? raw : []).slice(0, 200)) {
    const m = findMine("btpMaterials", req, l.materialId); if (!m) continue;
    const conv = l.inPurchaseUnit && m.conversion > 0 ? m.conversion : 1;
    const qty = Q(Number(l.qty) * conv); if (!(qty > 0) || qty > 1e9) continue;
    const unitPrice = l.unitPrice != null && l.unitPrice !== "" ? R2(Number(l.unitPrice) / conv) : R2(m.purchasePrice || 0);
    const discountPct = Math.min(100, Math.max(0, Number(l.discountPct) || 0));
    const vatRate = l.vatRate != null && l.vatRate !== "" ? Math.min(100, Math.max(0, Number(l.vatRate))) : (m.vatRate != null ? m.vatRate : 0);
    if (!(unitPrice >= 0)) continue;
    const ht = R2(qty * unitPrice * (1 - discountPct / 100));
    out.push({ materialId: m.id, qty, unitPrice, discountPct, vatRate, ht, vat: R2(ht * vatRate / 100) });
  }
  return out;
}
const docTotals = (lines, shipping) => {
  const ht = R2(lines.reduce((s, l) => s + l.ht, 0)), vat = R2(lines.reduce((s, l) => s + l.vat, 0)), sh = R2(Math.max(0, Number(shipping) || 0));
  return { totalHT: ht, totalVAT: vat, shipping: sh, totalTTC: R2(ht + vat + sh) };
};
const PO_STATUS = { brouillon: "Brouillon", envoye: "Envoyée", partiel: "Reçue en partie", recu: "Reçue", annule: "Annulée" };
const activePurchases = (req) => mine(col("btpPurchases"), req).filter(p => p.status !== "annulee");
function poReceived(req, po) {
  const r = {}; for (const p of activePurchases(req).filter(p => p.poId === po.id)) for (const l of p.lines) r[l.materialId] = Q((r[l.materialId] || 0) + l.qty);
  return r;
}
function poOut(req, po) {
  const rec = poReceived(req, po);
  return Object.assign({}, po, { statusLabel: PO_STATUS[po.status], supplier: (supplierOf(req, po.supplierId) || {}).name || "", warehouse: whName(req, po.warehouseId), project: projName(req, po.projectId),
    lines: po.lines.map(l => Object.assign({}, l, { material: matName(req, l.materialId), unit: (findMine("btpMaterials", req, l.materialId) || {}).unit || "", received: rec[l.materialId] || 0 })) });
}
function refreshPO(req, po) {
  if (po.status === "annule" || po.status === "brouillon") return;
  const rec = poReceived(req, po);
  const all = po.lines.every(l => (rec[l.materialId] || 0) >= l.qty), any = po.lines.some(l => (rec[l.materialId] || 0) > 0);
  const st = all ? "recu" : any ? "partiel" : "envoye";
  if (st !== po.status) { po.status = st; if (st !== "envoye") btpNotify(req, "po_received", { ref: po.ref, supplier: (supplierOf(req, po.supplierId) || {}).name || "", status: PO_STATUS[st].toLowerCase() }, {}); }
}
router.get("/po", allow(...READ), (req, res) => res.json(mine(col("btpPOs"), req).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(p => poOut(req, p))));
function applyPO(req, po, b) {
  if (b.supplierId !== undefined) { if (!supplierOf(req, b.supplierId)) return "Fournisseur obligatoire"; po.supplierId = b.supplierId; }
  if (b.warehouseId !== undefined) { if (!findMine("btpWarehouses", req, b.warehouseId)) return "Entrepôt de livraison obligatoire"; po.warehouseId = b.warehouseId; }
  if (b.projectId !== undefined) { if (b.projectId && !findMine("btpProjects", req, b.projectId)) return "Chantier introuvable"; po.projectId = b.projectId || ""; }
  for (const k of ["date", "expectedDate"]) if (b[k] !== undefined) { if (b[k] && !isDate(b[k])) return "Date invalide"; po[k] = b[k] || ""; }
  if (b.note !== undefined) po.note = str(b.note, 1000);
  if (b.lines !== undefined) { const lines = priceLines(req, b.lines); if (!lines.length) return "Ajoutez au moins un matériau avec une quantité"; po.lines = lines; }
  if (b.shipping !== undefined || b.lines !== undefined) Object.assign(po, docTotals(po.lines || [], b.shipping !== undefined ? b.shipping : po.shipping));
  return null;
}
router.post("/po", allow(...WRITE), (req, res) => {
  const b = req.body || {};
  const po = stamp({ id: id("bpo"), ref: nextRef(req, "btpPOs", "BC"), status: b.send ? "envoye" : "brouillon", date: today(), lines: [], createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: new Date().toISOString() }, req);
  const err = applyPO(req, po, Object.assign({ supplierId: b.supplierId, warehouseId: b.warehouseId, lines: b.lines }, b)); if (err) return bad(res, err);
  col("btpPOs").push(po); save(); audit(req.user, "CREATED", "BtpPO", po.id, { ref: po.ref }); res.status(201).json(poOut(req, po));
});
router.put("/po/:id", allow(...WRITE), (req, res) => {
  const po = findMine("btpPOs", req, req.params.id); if (!po) return bad(res, "Commande introuvable", 404);
  if (po.status !== "brouillon") return bad(res, "Seule une commande en brouillon peut être modifiée");
  const before = JSON.stringify(po); const err = applyPO(req, po, req.body || {});
  if (err) { Object.assign(po, JSON.parse(before)); return bad(res, err); }
  save(); res.json(poOut(req, po));
});
router.post("/po/:id/:action(send|cancel)", allow(...WRITE), (req, res) => {
  const po = findMine("btpPOs", req, req.params.id); if (!po) return bad(res, "Commande introuvable", 404);
  if (req.params.action === "send") { if (po.status !== "brouillon") return bad(res, "Commande déjà envoyée"); po.status = "envoye"; }
  else {
    if (po.status === "annule" || po.status === "recu") return bad(res, "Cette commande ne peut plus être annulée");
    if (activePurchases(req).some(p => p.poId === po.id)) { po.status = "recu"; po.closedShort = true; }   // reliquat abandonné
    else po.status = "annule";
  }
  save(); audit(req.user, "UPDATED", "BtpPO", po.id, { action: req.params.action }); res.json(poOut(req, po));
});

function purchaseOut(req, p) {
  const paid = R2(mine(col("btpPayments"), req).filter(x => x.purchaseId === p.id).reduce((s, x) => s + x.amount, 0));
  const credited = R2(mine(col("btpSupplierReturns"), req).filter(x => x.purchaseId === p.id && x.status !== "annulee").reduce((s, x) => s + x.creditTTC, 0));
  const due = p.status === "annulee" ? 0 : R2(p.totalTTC - paid - credited);
  return Object.assign({}, p, { supplier: (supplierOf(req, p.supplierId) || {}).name || "", warehouse: whName(req, p.warehouseId), project: projName(req, p.projectId),
    po: (findMine("btpPOs", req, p.poId) || {}).ref || "", paid, credited, due, payStatus: p.status === "annulee" ? "annulee" : due <= 0.009 ? "paye" : paid > 0 ? "partiel" : "non_paye",
    lines: p.lines.map(l => Object.assign({}, l, { material: matName(req, l.materialId), unit: (findMine("btpMaterials", req, l.materialId) || {}).unit || "" })) });
}
// Réception facturée : crée la facture d'achat et l'entrée en stock (une seule opération).
function createPurchase(req, b, po) {
  const sup = supplierOf(req, b.supplierId); if (!sup) return { error: "Fournisseur obligatoire" };
  const wh = findMine("btpWarehouses", req, b.warehouseId); if (!wh) return { error: "Entrepôt de réception obligatoire" };
  if (b.projectId && !findMine("btpProjects", req, b.projectId)) return { error: "Chantier introuvable" };
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return { error: "Date invalide (pas de date future)" };
  if (b.clientKey) { const dup = mine(col("btpPurchases"), req).find(p => p.clientKey === b.clientKey); if (dup) return { duplicate: dup }; }
  const lines = priceLines(req, b.lines); if (!lines.length) return { error: "Ajoutez au moins un matériau avec une quantité" };
  if (po) {
    const rec = poReceived(req, po);
    for (const l of lines) {
      const pl = po.lines.find(x => x.materialId === l.materialId);
      const left = pl ? Q(pl.qty - (rec[l.materialId] || 0)) : 0;
      if (l.qty > left) return { error: `« ${matName(req, l.materialId)} » : au plus ${left} restant à recevoir sur la commande ${po.ref}` };
    }
  }
  const tot = docTotals(lines, b.shipping);
  // Le transport est réparti sur les lignes au prorata du HT : il entre dans le coût du stock (CUMP), pas la TVA.
  const lineCost = l => R2((l.ht + (tot.totalHT ? tot.shipping * l.ht / tot.totalHT : 0)) / l.qty);
  const p = stamp({ id: id("bpa"), ref: nextRef(req, "btpPurchases", "ACH"), supplierId: sup.id, poId: po ? po.id : "", warehouseId: wh.id, projectId: b.projectId || (po && po.projectId) || "",
    date, supplierInvoice: str(b.supplierInvoice, 80), dueDate: isDate(b.dueDate) ? b.dueDate : "", note: str(b.note, 1000), lines: lines.map(l => Object.assign(l, { unitCost: lineCost(l) })),
    ...tot, status: "validee", clientKey: str(b.clientKey, 80), createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: new Date().toISOString() }, req);
  const r = post(req, { type: "reception", date, projectId: p.projectId, supplierId: sup.id, docRef: p.supplierInvoice || p.ref, reason: "Achat " + p.ref + (po ? " / commande " + po.ref : ""),
    sourceType: "purchase", sourceId: p.id, lines: p.lines.map(l => ({ materialId: l.materialId, warehouseId: wh.id, qty: l.qty, unitCost: l.unitCost })) });
  if (r.error) return { error: r.error };
  p.movementRef = r.ref; col("btpPurchases").push(p);
  if (po) refreshPO(req, po);
  save(); audit(req.user, "CREATED", "BtpPurchase", p.id, { ref: p.ref, totalTTC: p.totalTTC });
  return { purchase: p };
}
router.post("/po/:id/receive", allow(...WRITE), (req, res) => {
  const po = findMine("btpPOs", req, req.params.id); if (!po) return bad(res, "Commande introuvable", 404);
  if (!["envoye", "partiel"].includes(po.status)) return bad(res, "La commande doit être envoyée (et pas encore entièrement reçue)");
  const b = req.body || {};
  const r = createPurchase(req, Object.assign({}, b, { supplierId: po.supplierId, warehouseId: b.warehouseId || po.warehouseId, projectId: b.projectId || po.projectId,
    lines: (b.lines || []).map(l => { const pl = po.lines.find(x => x.materialId === l.materialId) || {}; return { materialId: l.materialId, qty: l.qty, unitPrice: pl.unitPrice, discountPct: pl.discountPct, vatRate: pl.vatRate }; }) }), po);
  if (r.error) return bad(res, r.error);
  res.status(r.duplicate ? 200 : 201).json(purchaseOut(req, r.purchase || r.duplicate));
});
router.get("/purchases", allow(...READ), (req, res) => {
  let list = mine(col("btpPurchases"), req); if (req.query.supplierId) list = list.filter(p => p.supplierId === req.query.supplierId);
  res.json(list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(p => purchaseOut(req, p)));
});
router.post("/purchases", allow(...WRITE), (req, res) => {
  const r = createPurchase(req, req.body || {}, null); if (r.error) return bad(res, r.error);
  res.status(r.duplicate ? 200 : 201).json(purchaseOut(req, r.purchase || r.duplicate));
});
const ACCOUNT_TYPES = { caisse: "Caisse", banque: "Banque", mobile: "Mobile money" };
router.post("/purchases/:id/pay", allow(...CONFIG), (req, res) => {
  const p = findMine("btpPurchases", req, req.params.id); if (!p) return bad(res, "Achat introuvable", 404);
  if (p.status === "annulee") return bad(res, "Achat annulé");
  const b = req.body || {}; const amount = R2(b.amount); const out = purchaseOut(req, p);
  if (!(amount > 0)) return bad(res, "Montant invalide");
  if (amount > out.due + 0.009) return bad(res, `Montant supérieur au reste à payer (${out.due})`);
  const acc = findMine("btpAccounts", req, b.accountId); if (!acc || acc.active === false) return bad(res, "Compte de paiement obligatoire");
  if (acc.type === "caisse" && accountBalance(req, acc) < amount) return bad(res, `Solde insuffisant dans la caisse « ${acc.name} »`);
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide");
  if (b.clientKey && mine(col("btpPayments"), req).some(x => x.clientKey === b.clientKey)) return res.json(purchaseOut(req, p));
  const pay = stamp({ id: id("bpy"), ref: nextRef(req, "btpPayments", "PAY"), purchaseId: p.id, supplierId: p.supplierId, accountId: acc.id, date, amount,
    method: str(b.method, 40) || ACCOUNT_TYPES[acc.type], note: str(b.note, 300), clientKey: str(b.clientKey, 80), createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  col("btpPayments").push(pay); save(); audit(req.user, "PAID", "BtpPurchase", p.id, { amount, account: acc.id });
  res.status(201).json(purchaseOut(req, p));
});
function returnedFor(req, purchaseId) {
  const r = {}; for (const x of mine(col("btpSupplierReturns"), req).filter(x => x.purchaseId === purchaseId && x.status !== "annulee")) for (const l of x.lines) r[l.materialId] = Q((r[l.materialId] || 0) + l.qty);
  return r;
}
router.get("/returns", allow(...READ), (req, res) => res.json(mine(col("btpSupplierReturns"), req).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  .map(x => Object.assign({}, x, { supplier: (supplierOf(req, x.supplierId) || {}).name || "", purchase: (findMine("btpPurchases", req, x.purchaseId) || {}).ref || "", warehouse: whName(req, x.warehouseId),
    lines: x.lines.map(l => Object.assign({}, l, { material: matName(req, l.materialId) })) }))));
router.post("/returns", allow(...WRITE), (req, res) => {
  const b = req.body || {};
  const p = findMine("btpPurchases", req, b.purchaseId); if (!p || p.status === "annulee") return bad(res, "Achat d'origine obligatoire");
  if (!str(b.reason)) return bad(res, "Motif du retour obligatoire");
  const whId = b.warehouseId || p.warehouseId; if (!findMine("btpWarehouses", req, whId)) return bad(res, "Entrepôt introuvable");
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide");
  const already = returnedFor(req, p.id); const lines = [];
  for (const l of (Array.isArray(b.lines) ? b.lines : [])) {
    const pl = p.lines.find(x => x.materialId === l.materialId); const q = Q(l.qty); if (!pl || !(q > 0)) continue;
    const left = Q(pl.qty - (already[l.materialId] || 0)); if (q > left) return bad(res, `« ${matName(req, l.materialId)} » : au plus ${left} retournable sur l'achat ${p.ref}`);
    const ht = R2(q * pl.unitPrice * (1 - pl.discountPct / 100));
    lines.push({ materialId: l.materialId, qty: q, unitCost: pl.unitCost, creditTTC: R2(ht * (1 + pl.vatRate / 100)) });
  }
  if (!lines.length) return bad(res, "Ajoutez au moins un matériau à retourner");
  const x = stamp({ id: id("bsr"), ref: nextRef(req, "btpSupplierReturns", "RF"), purchaseId: p.id, supplierId: p.supplierId, warehouseId: whId, date, reason: str(b.reason, 500), lines,
    creditTTC: R2(lines.reduce((s, l) => s + l.creditTTC, 0)), status: "validee", createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  const r = post(req, { type: "retour_fournisseur", date, supplierId: p.supplierId, reason: `Retour ${x.ref} sur achat ${p.ref} : ${x.reason}`, docRef: x.ref, sourceType: "supplierReturn", sourceId: x.id,
    lines: lines.map(l => ({ materialId: l.materialId, warehouseId: whId, qty: -l.qty })) });
  if (r.error) return bad(res, r.error);
  x.movementRef = r.ref; col("btpSupplierReturns").push(x); save(); audit(req.user, "CREATED", "BtpSupplierReturn", x.id, { ref: x.ref });
  res.status(201).json(x);
});
// Relevé fournisseur : solde d'ouverture + achats - paiements - avoirs de retour.
function supplierStatement(req, s) {
  const rows = [];
  for (const p of activePurchases(req).filter(p => p.supplierId === s.id)) rows.push({ date: p.date, ref: p.ref, label: "Achat" + (p.supplierInvoice ? " - facture " + p.supplierInvoice : ""), debit: p.totalTTC, credit: 0 });
  for (const x of mine(col("btpPayments"), req).filter(x => x.supplierId === s.id)) rows.push({ date: x.date, ref: x.ref, label: "Paiement (" + (findMine("btpAccounts", req, x.accountId) || {}).name + ")", debit: 0, credit: x.amount });
  for (const x of mine(col("btpSupplierReturns"), req).filter(x => x.supplierId === s.id && x.status !== "annulee")) rows.push({ date: x.date, ref: x.ref, label: "Avoir sur retour", debit: 0, credit: x.creditTTC });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  let bal = R2(s.openingBalance || 0); for (const r of rows) { bal = R2(bal + r.debit - r.credit); r.balance = bal; }
  return { opening: R2(s.openingBalance || 0), rows, balance: bal };
}
router.get("/suppliers/:id/statement", allow(...READ), (req, res) => {
  const s = supplierOf(req, req.params.id); if (!s) return bad(res, "Fournisseur introuvable", 404);
  res.json(Object.assign({ supplier: s }, supplierStatement(req, s)));
});
// Contre-passation d'un achat ou d'un retour : seulement si rien n'en dépend.
function reverseBlocked(req, m) {
  if (m.sourceType === "purchase") {
    const p = findMine("btpPurchases", req, m.sourceId); if (!p) return null;
    if (mine(col("btpPayments"), req).some(x => x.purchaseId === p.id)) return "Cet achat a des paiements : il ne peut plus être annulé";
    if (mine(col("btpSupplierReturns"), req).some(x => x.purchaseId === p.id && x.status !== "annulee")) return "Cet achat a des retours : annulez-les d'abord";
  }
  return null;
}
function afterReverse(req, m, reason) {
  if (m.sourceType === "purchase") { const p = findMine("btpPurchases", req, m.sourceId); if (p) { p.status = "annulee"; p.cancelReason = reason; const po = findMine("btpPOs", req, p.poId); if (po) refreshPO(req, po); save(); } }
  if (m.sourceType === "supplierReturn") { const x = findMine("btpSupplierReturns", req, m.sourceId); if (x) { x.status = "annulee"; x.cancelReason = reason; save(); } }
}

/* ============================ Comptes de paiement ============================ */
function accountRows(req, a) {
  const rows = [];
  for (const x of mine(col("btpPayments"), req).filter(x => x.accountId === a.id)) rows.push({ date: x.date, ref: x.ref, label: "Paiement fournisseur " + ((supplierOf(req, x.supplierId) || {}).name || ""), amount: -x.amount });
  for (const x of mine(col("btpExpenses"), req).filter(x => x.accountId === a.id)) rows.push({ date: x.date, ref: x.ref, label: "Dépense : " + (x.description || ""), amount: -x.amount });
  for (const x of mine(col("btpAccountEntries"), req).filter(x => x.accountId === a.id)) rows.push({ date: x.date, ref: x.ref, label: x.label || (x.amount > 0 ? "Approvisionnement" : "Retrait"), amount: x.amount });
  return rows.sort((p, q) => p.date.localeCompare(q.date));
}
function accountBalance(req, a) { return R2((a.openingBalance || 0) + accountRows(req, a).reduce((s, r) => s + r.amount, 0)); }
router.get("/accounts", allow(...READ), (req, res) => res.json(mine(col("btpAccounts"), req).map(a => Object.assign({}, a, { typeLabel: ACCOUNT_TYPES[a.type], balance: accountBalance(req, a) }))
  .sort((a, b) => a.name.localeCompare(b.name, "fr"))));
function applyAccount(a, b) {
  for (const [k, n] of Object.entries({ name: 120, number: 60, bank: 120, note: 300 })) if (b[k] !== undefined) a[k] = str(b[k], n);
  if (b.type !== undefined) { if (!ACCOUNT_TYPES[b.type]) return "Type de compte inconnu"; a.type = b.type; }
  if (b.active !== undefined) a.active = !!b.active;
  return a.name ? null : "Nom du compte obligatoire";
}
router.post("/accounts", allow(...CONFIG), (req, res) => {
  const b = req.body || {}; const a = stamp({ id: id("bac"), type: "caisse", active: true, openingBalance: R2(b.openingBalance), createdAt: new Date().toISOString() }, req);
  const err = applyAccount(a, b); if (err) return bad(res, err);
  col("btpAccounts").push(a); save(); audit(req.user, "CREATED", "BtpAccount", a.id, { name: a.name }); res.status(201).json(a);
});
router.put("/accounts/:id", allow(...CONFIG), (req, res) => {
  const a = findMine("btpAccounts", req, req.params.id); if (!a) return bad(res, "Compte introuvable", 404);
  const before = JSON.stringify(a); const err = applyAccount(a, req.body || {}); if (err) { Object.assign(a, JSON.parse(before)); return bad(res, err); }
  save(); res.json(a);
});
router.post("/accounts/:id/entries", allow(...CONFIG), (req, res) => {
  const a = findMine("btpAccounts", req, req.params.id); if (!a || a.active === false) return bad(res, "Compte introuvable", 404);
  const b = req.body || {}; const amount = R2(b.amount); if (!amount) return bad(res, "Montant obligatoire (positif = entrée, négatif = sortie)");
  if (!str(b.label)) return bad(res, "Libellé obligatoire");
  if (amount < 0 && a.type === "caisse" && accountBalance(req, a) + amount < 0) return bad(res, "Solde de caisse insuffisant");
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide");
  const e = stamp({ id: id("bae"), ref: nextRef(req, "btpAccountEntries", "OPC"), accountId: a.id, date, amount, label: str(b.label, 200), createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  col("btpAccountEntries").push(e); save(); audit(req.user, "CREATED", "BtpAccountEntry", e.id, { amount }); res.status(201).json(e);
});
router.get("/accounts/:id/statement", allow(...READ), (req, res) => {
  const a = findMine("btpAccounts", req, req.params.id); if (!a) return bad(res, "Compte introuvable", 404);
  let bal = R2(a.openingBalance || 0); const rows = accountRows(req, a).map(r => { bal = R2(bal + r.amount); return Object.assign(r, { balance: bal }); });
  res.json({ account: a, opening: R2(a.openingBalance || 0), rows, balance: bal });
});

/* ============================ Dépenses de chantier ============================ */
const DEFAULT_EXPENSE_CATS = ["Transport", "Location d'engins", "Carburant", "Main-d'œuvre occasionnelle", "Restauration", "Divers"];
router.get("/expense-categories", allow(...READ), (req, res) => {
  const tid = req.user.tenantId || "t1";
  if (!col("btpExpenseCats").some(c => (c.tenantId || "t1") === tid)) { for (const name of DEFAULT_EXPENSE_CATS) col("btpExpenseCats").push({ id: id("bec"), tenantId: tid, name, createdAt: new Date().toISOString() }); save(); }
  res.json(mine(col("btpExpenseCats"), req).slice().sort((a, b) => a.name.localeCompare(b.name, "fr")));
});
router.post("/expense-categories", allow(...CONFIG), (req, res) => {
  const name = str((req.body || {}).name, 80); if (!name) return bad(res, "Nom obligatoire");
  if (mine(col("btpExpenseCats"), req).some(c => c.name.toLowerCase() === name.toLowerCase())) return bad(res, "Cette catégorie existe déjà", 409);
  const c = stamp({ id: id("bec"), name, createdAt: new Date().toISOString() }, req); col("btpExpenseCats").push(c); save(); res.status(201).json(c);
});
router.get("/expenses", allow(...READ), (req, res) => {
  let list = mine(col("btpExpenses"), req); if (req.query.projectId) list = list.filter(e => e.projectId === req.query.projectId);
  res.json(list.slice().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)).map(e => Object.assign({}, e, {
    project: projName(req, e.projectId), category: (findMine("btpExpenseCats", req, e.categoryId) || {}).name || "", account: (findMine("btpAccounts", req, e.accountId) || {}).name || "",
    supplier: (supplierOf(req, e.supplierId) || {}).name || "" })));
});
router.post("/expenses", allow(...WRITE), (req, res) => {
  const b = req.body || {}; const amount = R2(b.amount);
  if (!(amount > 0)) return bad(res, "Montant invalide");
  if (!findMine("btpExpenseCats", req, b.categoryId)) return bad(res, "Catégorie de dépense obligatoire");
  if (b.projectId && !findMine("btpProjects", req, b.projectId)) return bad(res, "Chantier introuvable");
  if (b.supplierId && !supplierOf(req, b.supplierId)) return bad(res, "Fournisseur introuvable");
  const acc = b.accountId ? findMine("btpAccounts", req, b.accountId) : null; if (b.accountId && (!acc || acc.active === false)) return bad(res, "Compte de paiement introuvable");
  if (acc && acc.type === "caisse" && accountBalance(req, acc) < amount) return bad(res, `Solde insuffisant dans la caisse « ${acc.name} »`);
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide");
  if (!str(b.description)) return bad(res, "Description obligatoire");
  if (b.clientKey) { const dup = mine(col("btpExpenses"), req).find(e => e.clientKey === b.clientKey); if (dup) return res.json(dup); }
  const e = stamp({ id: id("bex"), ref: nextRef(req, "btpExpenses", "DEP"), date, amount, categoryId: b.categoryId, projectId: b.projectId || "", accountId: acc ? acc.id : "", supplierId: b.supplierId || "",
    description: str(b.description, 300), docRef: str(b.docRef, 80), clientKey: str(b.clientKey, 80), createdBy: req.user.id, createdByName: req.user.fullName || "", createdAt: new Date().toISOString() }, req);
  col("btpExpenses").push(e); save(); audit(req.user, "CREATED", "BtpExpense", e.id, { amount, projectId: e.projectId }); res.status(201).json(e);
});

/* ============================ Dotation EPI depuis le stock BTP ============================ */
router.get("/epi", allow(...READ), (req, res) => {
  const rev = reversedRefs(req);
  res.json(mine(col("btpMovements"), req).filter(m => m.type === "dotation").sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)).map(m => {
    const e = mine(db.employees || [], req).find(x => x.id === m.employeeId) || {};
    return Object.assign({}, m, { employee: `${e.firstName || ""} ${e.lastName || ""}`.trim(), material: matName(req, m.materialId), warehouse: whName(req, m.warehouseId), project: projName(req, m.projectId), reversed: rev.has(m.ref) });
  }));
});
router.get("/employees", allow(...READ), (req, res) => res.json(mine(db.employees || [], req).filter(e => (e.status || "").toUpperCase() !== "ARCHIVED")
  .map(e => ({ id: e.id, name: `${e.firstName || ""} ${e.lastName || ""}`.trim(), matricule: e.matricule || "" })).sort((a, b) => a.name.localeCompare(b.name, "fr"))));
router.post("/epi", allow(...WRITE), (req, res) => {
  const b = req.body || {};
  const emp = mine(db.employees || [], req).find(e => e.id === b.employeeId); if (!emp) return bad(res, "Salarié obligatoire");
  if (!findMine("btpWarehouses", req, b.warehouseId)) return bad(res, "Entrepôt obligatoire");
  if (b.projectId && !findMine("btpProjects", req, b.projectId)) return bad(res, "Chantier introuvable");
  const date = b.date ? String(b.date).slice(0, 10) : today(); if (!isDate(date) || date > today()) return bad(res, "Date invalide");
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l.materialId && Q(l.qty) > 0).map(l => ({ materialId: l.materialId, warehouseId: b.warehouseId, qty: -Math.abs(Q(l.qty)) }));
  const r = post(req, { type: "dotation", date, projectId: b.projectId || "", employeeId: emp.id, reason: str(b.note, 300) || `Dotation EPI - ${emp.firstName || ""} ${emp.lastName || ""}`.trim(), clientKey: str(b.clientKey, 80), lines });
  if (r.error) return bad(res, r.error);
  res.status(r.duplicate ? 200 : 201).json({ ok: true, ref: r.ref, duplicate: !!r.duplicate });
});

/* ============================ Modèles de notification ============================ */
router.get("/notif-templates", allow("ADM", "CD"), (req, res) => res.json(Object.keys(NOTIF_DEFAULTS).map(k => Object.assign(notifTemplate(req, k), { defaults: NOTIF_DEFAULTS[k] }))));
router.put("/notif-templates/:key", allow("ADM", "CD"), (req, res) => {
  if (!NOTIF_DEFAULTS[req.params.key]) return bad(res, "Modèle inconnu", 404);
  const b = req.body || {}; if (!str(b.subject) || !str(b.body)) return bad(res, "Objet et message obligatoires");
  let t = mine(col("btpNotifTemplates"), req).find(x => x.key === req.params.key);
  if (!t) { t = stamp({ id: id("bnt"), key: req.params.key }, req); col("btpNotifTemplates").push(t); }
  t.subject = str(b.subject, 200); t.body = str(b.body, 2000); t.enabled = b.enabled !== false; save();
  audit(req.user, "CONFIG_CHANGED", "BtpNotifTemplate", req.params.key, {}); res.json(notifTemplate(req, req.params.key));
});
router.delete("/notif-templates/:key", allow("ADM", "CD"), (req, res) => {
  const t = mine(col("btpNotifTemplates"), req).find(x => x.key === req.params.key);
  if (t) { col("btpNotifTemplates").splice(col("btpNotifTemplates").indexOf(t), 1); save(); }
  res.json(notifTemplate(req, req.params.key));
});

/* ============================ Imports (matériaux, stock d'ouverture) ============================ */
router.post("/import/parse", allow(...CONFIG), (req, res) => {
  const b = req.body || {}; if (!b.data) return bad(res, "Fichier manquant");
  let rows;
  try {
    const XLSX = require("xlsx"); const buf = Buffer.from(String(b.data).replace(/^data:.*?;base64,/, ""), "base64");
    if (buf.length > 10 * 1024 * 1024) return bad(res, "Fichier trop volumineux (10 Mo max)");
    // A CSV is text: decode it as UTF-8 (accents in « Désignation », « Unité »…), BOM removed; Excel files are read as binary.
    const isText = /\.(csv|txt)$/i.test(String(b.filename || "")) || !(buf[0] === 0x50 && buf[1] === 0x4b) && !(buf[0] === 0xd0 && buf[1] === 0xcf);
    const wb = isText ? XLSX.read(buf.toString("utf8").replace(/^﻿/, ""), { type: "string", raw: false }) : XLSX.read(buf, { type: "buffer", raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false });
  } catch (e) { return bad(res, "Fichier illisible : utilisez un fichier Excel (.xlsx) ou CSV"); }
  if (!rows.length) return bad(res, "Fichier vide");
  res.json({ headers: rows[0].map(h => String(h).trim()), rows: rows.slice(1, 5001).map(r => r.map(c => String(c).trim())), total: rows.length - 1 });
});
const unitFrom = (v) => { const s = String(v || "").trim().toLowerCase(); if (!s) return "";
  const u = UNITS.find(u => u.code.toLowerCase() === s || u.label.toLowerCase() === s || u.label.toLowerCase().startsWith(s)); return u ? u.code : null; };
const numFrom = (v) => { const n = Number(String(v == null ? "" : v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : NaN; };
function findOrCreate(req, collection, name, prefix) {
  const n = str(name, 80); if (!n) return "";
  let c = mine(col(collection), req).find(x => x.name.toLowerCase() === n.toLowerCase());
  if (!c) { c = stamp({ id: id(prefix), name: n, createdAt: new Date().toISOString() }, req); col(collection).push(c); }
  return c.id;
}
router.post("/materials/import", allow(...CONFIG), (req, res) => {
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows.slice(0, 5000) : [];
  seed(req); let created = 0; const skipped = [], errors = [];
  rows.forEach((r, i) => {
    const line = i + 2; const name = str(r.name, 120); if (!name) return errors.push({ line, error: "Nom manquant" });
    const ref = str(r.ref, 40);
    if (ref && mine(col("btpMaterials"), req).some(m => m.ref.toLowerCase() === ref.toLowerCase())) return skipped.push({ line, ref, reason: "Référence déjà existante" });
    if (!ref && mine(col("btpMaterials"), req).some(m => m.name.toLowerCase() === name.toLowerCase())) return skipped.push({ line, ref: name, reason: "Matériau déjà existant" });
    const unit = unitFrom(r.unit); if (unit === null) return errors.push({ line, error: "Unité inconnue : " + r.unit });
    const m = stamp({ id: id("btm"), ref: ref || nextRef(req, "btpMaterials", "MAT", 4, false), name, unit: unit || "PCS", purchaseUnit: unit || "PCS", conversion: 1,
      minStock: 0, maxStock: 0, reorderLevel: 0, purchasePrice: 0, avgCost: 0, vatRate: 19.25, active: true, createdAt: new Date().toISOString(), createdBy: req.user.id }, req);
    for (const k of ["purchasePrice", "minStock", "reorderLevel", "maxStock", "vatRate"]) if (r[k] !== undefined && r[k] !== "") { const v = numFrom(r[k]); if (!(v >= 0)) return errors.push({ line, error: `Valeur invalide (${k}) : ${r[k]}` }); m[k] = k === "purchasePrice" ? R2(v) : Q(v); }
    m.avgCost = m.purchasePrice; m.description = str(r.description, 600); m.barcode = str(r.barcode, 60);
    m.categoryId = findOrCreate(req, "btpCategories", r.category, "btc"); m.brandId = findOrCreate(req, "btpBrands", r.brand, "btb");
    col("btpMaterials").push(m); created++;
  });
  save(); audit(req.user, "IMPORTED", "BtpMaterial", "", { created, skipped: skipped.length, errors: errors.length });
  res.json({ created, skipped, errors });
});
router.post("/opening/import", allow(...CONFIG), (req, res) => {
  const b = req.body || {}; if (!findMine("btpWarehouses", req, b.warehouseId)) return bad(res, "Entrepôt obligatoire");
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : []; if (!rows.length) return bad(res, "Aucune ligne");
  seed(req); const errors = []; const lines = []; const createdMats = [];
  rows.forEach((r, i) => {
    const line = i + 2; const qty = numFrom(r.qty); if (!(qty > 0)) return errors.push({ line, error: "Quantité invalide : " + r.qty });
    const cost = r.unitCost === undefined || r.unitCost === "" ? null : numFrom(r.unitCost); if (cost !== null && !(cost >= 0)) return errors.push({ line, error: "Coût invalide : " + r.unitCost });
    let m = mine(col("btpMaterials"), req).find(x => (str(r.ref) && x.ref.toLowerCase() === str(r.ref).toLowerCase()) || (!str(r.ref) && str(r.name) && x.name.toLowerCase() === str(r.name).toLowerCase()));
    if (!m) {
      if (!str(r.name)) return errors.push({ line, error: "Matériau introuvable et nom absent pour le créer" });
      const unit = unitFrom(r.unit); if (unit === null) return errors.push({ line, error: "Unité inconnue : " + r.unit });
      m = stamp({ id: id("btm"), ref: str(r.ref, 40) || nextRef(req, "btpMaterials", "MAT", 4, false), name: str(r.name, 120), unit: unit || "PCS", purchaseUnit: unit || "PCS", conversion: 1,
        minStock: 0, maxStock: 0, reorderLevel: 0, purchasePrice: cost || 0, avgCost: 0, vatRate: 19.25, active: true, categoryId: findOrCreate(req, "btpCategories", r.category, "btc"), createdAt: new Date().toISOString(), createdBy: req.user.id }, req);
      col("btpMaterials").push(m); createdMats.push(m);
    }
    lines.push({ materialId: m.id, warehouseId: b.warehouseId, qty: Q(qty), unitCost: cost });
  });
  // Tout ou rien : une erreur sur une ligne n'importe rien (et retire les matériaux créés pour l'occasion).
  const undo = () => { for (const m of createdMats) col("btpMaterials").splice(col("btpMaterials").indexOf(m), 1); };
  if (errors.length) { undo(); return res.status(400).json({ error: `${errors.length} ligne(s) en erreur : rien n'a été importé`, errors }); }
  const r = post(req, { type: "initial", date: today(), reason: "Import du stock d'ouverture", clientKey: str(b.clientKey, 80), lines });
  if (r.error) { undo(); return bad(res, r.error); }
  res.status(201).json({ ok: true, ref: r.ref, lines: lines.length, createdMaterials: createdMats.length, duplicate: !!r.duplicate });
});

module.exports = router;
