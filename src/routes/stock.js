/**
 * SGRHP — Gestion de stock (module « stock »).
 * Catalogue (produits, catégories, unités, fournisseurs) + mouvements de stock
 * (entrées/achats, sorties/ventes, ajustements) avec stock courant et valorisation.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

for (const k of ["stockProducts", "stockCategories", "stockUnits", "stockSuppliers", "stockContacts", "stockBrands", "stockWarranties", "stockPriceGroups", "stockVariations", "stockPOs", "stockPurchases", "stockReturns", "stockSOs", "stockSales", "stockQuotes", "stockSalesReturns", "stockMovements"]) if (!db[k]) db[k] = [];

const R2 = (n) => Math.round(Number(n) || 0);
const Q = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

function seedStock(tid) {
  const has = (col) => (db[col] || []).some(x => (x.tenantId || "t1") === tid);
  const put = (col, rec) => db[col].push(Object.assign({ id: id("stk"), tenantId: tid, createdAt: new Date().toISOString() }, rec));
  if (!has("stockUnits")) { put("stockUnits", { name: "Pièces", shortName: "Pc(s)", allowDecimal: false }); put("stockUnits", { name: "Cartons", shortName: "ctn", allowDecimal: false }); }
  if (!has("stockCategories")) { for (const n of ["EPI / Sécurité", "Fournitures de bureau", "Consommables", "Divers"]) put("stockCategories", { name: n }); }
  save();
}

function crud(path, col, fields, keyField, roleWrite) {
  router.get("/" + path, allow("ADM", "CD", "RJ", "GPF"), (req, res) => { seedStock(req.user.tenantId || "t1"); res.json(mine(db[col], req).slice().sort((a, b) => String(a[keyField] || "").localeCompare(String(b[keyField] || "")))); });
  router.post("/" + path, allow(...roleWrite), (req, res) => {
    const b = req.body || {}; if (!b[keyField]) return res.status(400).json({ error: keyField + " obligatoire" });
    const rec = { id: id("stk"), createdAt: new Date().toISOString() };
    for (const f of fields) if (b[f] !== undefined) rec[f] = b[f];
    db[col].push(stamp(rec, req)); save(); audit(req.user, "CREATED", col, rec.id, {}); res.status(201).json(rec);
  });
  router.put("/" + path + "/:id", allow(...roleWrite), (req, res) => {
    const x = mine(db[col], req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
    for (const f of fields) if (req.body[f] !== undefined) x[f] = req.body[f];
    save(); res.json(x);
  });
  router.delete("/" + path + "/:id", allow("ADM", "CD"), (req, res) => {
    const x = mine(db[col], req).find(r => r.id === req.params.id); if (!x) return res.status(404).json({ error: "Introuvable" });
    db[col].splice(db[col].indexOf(x), 1); save(); res.json({ ok: true });
  });
}
crud("categories", "stockCategories", ["name"], "name", ["ADM", "CD", "GPF"]);
crud("units", "stockUnits", ["name", "shortName", "allowDecimal"], "name", ["ADM", "CD", "GPF"]);
crud("brands", "stockBrands", ["name", "note"], "name", ["ADM", "CD", "GPF"]);
crud("warranties", "stockWarranties", ["name", "duration", "description"], "name", ["ADM", "CD", "GPF"]);
crud("pricegroups", "stockPriceGroups", ["name", "note"], "name", ["ADM", "CD", "GPF"]);
crud("variations", "stockVariations", ["name", "values"], "name", ["ADM", "CD", "GPF"]);

/* ============================ CONTACTS (fournisseurs & clients) ============================ */
const CONTACT_FIELDS = ["type", "entityType", "contactId", "name", "firstName", "mobile", "altPhone", "landline", "email",
  "taxId", "openingBalance", "paymentTerms", "address1", "address2", "city", "wilaya", "country", "postalCode", "note",
  "custom1", "custom2", "custom3", "custom4", "custom5", "custom6", "custom7", "custom8", "custom9", "custom10"];
function nextContactId(req, type) {
  const pre = type === "client" ? "CLI" : "FRN";
  const used = new Set(mine(db.stockContacts, req).map(c => c.contactId));
  let n = mine(db.stockContacts, req).filter(c => (c.type || "fournisseur") === type).length + 1;
  let cid; do { cid = pre + String(n).padStart(4, "0"); n++; } while (used.has(cid));
  return cid;
}
router.get("/contacts", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  let list = mine(db.stockContacts, req);
  if (req.query.type) list = list.filter(c => (c.type || "fournisseur") === req.query.type);
  const q = (req.query.q || "").toLowerCase();
  if (q) list = list.filter(c => ((c.name || "") + " " + (c.contactId || "") + " " + (c.mobile || "")).toLowerCase().includes(q));
  res.json(list.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))));
});
router.get("/contacts/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const c = mine(db.stockContacts, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Contact introuvable" });
  res.json(c);
});
router.post("/contacts", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: "Nom obligatoire" });
  const type = b.type === "client" ? "client" : "fournisseur";
  let cid = String(b.contactId || "").trim();
  if (cid && mine(db.stockContacts, req).some(c => c.contactId === cid)) return res.status(409).json({ error: "ID de contact déjà utilisé : " + cid });
  if (!cid) cid = nextContactId(req, type);
  const rec = { id: id("ctc"), createdAt: new Date().toISOString() };
  for (const fld of CONTACT_FIELDS) if (b[fld] !== undefined) rec[fld] = b[fld];
  rec.type = type; rec.contactId = cid; rec.openingBalance = R2(b.openingBalance);
  db.stockContacts.push(stamp(rec, req)); save(); audit(req.user, "CREATED", "StockContact", rec.id, { type, name: rec.name }); res.status(201).json(rec);
});
router.put("/contacts/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const c = mine(db.stockContacts, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Contact introuvable" });
  const b = req.body || {};
  for (const fld of CONTACT_FIELDS) if (fld !== "contactId" && fld !== "type" && b[fld] !== undefined) c[fld] = b[fld];
  if (b.openingBalance !== undefined) c.openingBalance = R2(b.openingBalance);
  save(); res.json(c);
});
router.delete("/contacts/:id", allow("ADM", "CD"), (req, res) => {
  const c = mine(db.stockContacts, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Introuvable" });
  db.stockContacts.splice(db.stockContacts.indexOf(c), 1); save(); res.json({ ok: true });
});
// Back-compat alias: suppliers = contacts of type fournisseur
router.get("/suppliers", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockContacts, req).filter(c => (c.type || "fournisseur") === "fournisseur").sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))));
});

function prodOut(p, req) {
  const cat = mine(db.stockCategories, req).find(c => c.id === p.categoryId);
  const unit = mine(db.stockUnits, req).find(u => u.id === p.unitId);
  const brand = mine(db.stockBrands, req).find(x => x.id === p.brandId);
  const qty = Q(p.qty || 0);
  return Object.assign({}, p, {
    categoryName: cat ? cat.name : "", unitName: unit ? (unit.shortName || unit.name) : "", brandName: brand ? brand.name : "",
    qty, stockValue: R2(qty * (Number(p.purchasePrice) || 0)),
    low: (p.alertQty != null && p.alertQty !== "") ? (qty <= Number(p.alertQty)) : false,
    out: qty <= 0
  });
}
router.get("/products", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  let list = mine(db.stockProducts, req);
  const q = (req.query.q || "").toLowerCase();
  if (q) list = list.filter(p => ((p.name || "") + " " + (p.sku || "")).toLowerCase().includes(q));
  if (req.query.categoryId) list = list.filter(p => p.categoryId === req.query.categoryId);
  if (req.query.low === "1") list = list.filter(p => prodOut(p, req).low);
  res.json(list.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))).map(p => prodOut(p, req)));
});
router.get("/products/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const p = mine(db.stockProducts, req).find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: "Produit introuvable" });
  res.json(prodOut(p, req));
});
router.post("/products", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: "Nom du produit obligatoire" });
  if (b.sku && mine(db.stockProducts, req).some(p => (p.sku || "") && p.sku === b.sku)) return res.status(409).json({ error: "SKU déjà utilisé : " + b.sku });
  const initial = Q(b.qty || 0);
  const p = stamp({
    id: id("prd"), sku: b.sku || "", barcode: b.barcode || "", name: b.name, categoryId: b.categoryId || "", unitId: b.unitId || "", supplierId: b.supplierId || "",
    brandId: b.brandId || "", warrantyId: b.warrantyId || "", priceGroupId: b.priceGroupId || "",
    purchasePrice: R2(b.purchasePrice), salePrice: R2(b.salePrice), qty: initial, alertQty: b.alertQty != null ? Q(b.alertQty) : "",
    active: b.active !== false, note: b.note || "", createdAt: new Date().toISOString()
  }, req);
  db.stockProducts.push(p);
  if (initial) db.stockMovements.push(stamp({ id: id("mov"), date: new Date().toISOString().slice(0, 10), type: "initial", productId: p.id, qty: initial, unitCost: p.purchasePrice, ref: "Stock initial", note: "", createdBy: req.user.id, createdAt: new Date().toISOString() }, req));
  save(); audit(req.user, "CREATED", "StockProduct", p.id, { name: p.name }); res.status(201).json(prodOut(p, req));
});
router.put("/products/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const p = mine(db.stockProducts, req).find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: "Produit introuvable" });
  const b = req.body || {};
  for (const f of ["sku", "barcode", "name", "categoryId", "unitId", "supplierId", "brandId", "warrantyId", "priceGroupId", "note"]) if (b[f] !== undefined) p[f] = b[f];
  for (const f of ["purchasePrice", "salePrice"]) if (b[f] !== undefined) p[f] = R2(b[f]);
  if (b.alertQty !== undefined) p.alertQty = b.alertQty === "" ? "" : Q(b.alertQty);
  if (b.active !== undefined) p.active = !!b.active;
  save(); res.json(prodOut(p, req));
});
router.delete("/products/:id", allow("ADM", "CD"), (req, res) => {
  const p = mine(db.stockProducts, req).find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: "Produit introuvable" });
  db.stockProducts.splice(db.stockProducts.indexOf(p), 1); save(); res.json({ ok: true });
});

const _prod = (req, pid) => mine(db.stockProducts, req).find(p => p.id === pid);
function logMove(req, m) { const rec = stamp(Object.assign({ id: id("mov"), createdBy: req.user.id, createdAt: new Date().toISOString() }, m), req); db.stockMovements.push(rec); return rec; }

router.post("/movements/purchase", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const lines = Array.isArray(b.lines) ? b.lines : [];
  const date = (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const done = [];
  for (const l of lines) { const p = _prod(req, l.productId); const qty = Q(l.qty); if (!p || qty <= 0) continue;
    const cost = R2(l.unitCost != null ? l.unitCost : p.purchasePrice);
    p.qty = Q((p.qty || 0) + qty); if (cost) p.purchasePrice = cost;
    done.push(logMove(req, { date, type: "achat", productId: p.id, qty, unitCost: cost, ref: b.ref || "", supplierId: b.supplierId || "", note: b.note || "" }));
  }
  if (!done.length) return res.status(400).json({ error: "Aucune ligne valide (produit + quantité)" });
  save(); audit(req.user, "STOCK_IN", "StockMovement", "", { lines: done.length }); res.status(201).json({ ok: true, movements: done.length });
});

router.post("/movements/sale", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const lines = Array.isArray(b.lines) ? b.lines : [];
  const date = (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const allowNeg = !!b.allowNegative;
  for (const l of lines) { const p = _prod(req, l.productId); const qty = Q(l.qty); if (!p || qty <= 0) continue;
    if (!allowNeg && qty > Q(p.qty || 0)) return res.status(400).json({ error: `Stock insuffisant pour « ${p.name} » (disponible ${Q(p.qty || 0)}, demandé ${qty})` }); }
  const done = [];
  for (const l of lines) { const p = _prod(req, l.productId); const qty = Q(l.qty); if (!p || qty <= 0) continue;
    p.qty = Q((p.qty || 0) - qty);
    done.push(logMove(req, { date, type: "vente", productId: p.id, qty: -qty, unitCost: R2(l.unitPrice != null ? l.unitPrice : p.salePrice), ref: b.ref || "", customer: b.customer || "", note: b.note || "" }));
  }
  if (!done.length) return res.status(400).json({ error: "Aucune ligne valide (produit + quantité)" });
  save(); audit(req.user, "STOCK_OUT", "StockMovement", "", { lines: done.length }); res.status(201).json({ ok: true, movements: done.length });
});

router.post("/movements/adjust", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const p = _prod(req, b.productId); if (!p) return res.status(404).json({ error: "Produit introuvable" });
  const date = (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const cur = Q(p.qty || 0);
  let delta;
  if (b.mode === "set") delta = Q(b.value) - cur; else delta = Q(b.value);
  if (!delta) return res.status(400).json({ error: "Aucune variation de stock" });
  p.qty = Q(cur + delta);
  const m = logMove(req, { date, type: "ajustement", productId: p.id, qty: delta, unitCost: p.purchasePrice, ref: "Ajustement", reason: b.reason || "", note: b.note || "" });
  save(); audit(req.user, "STOCK_ADJUST", "StockMovement", m.id, { productId: p.id, delta }); res.status(201).json({ ok: true, newQty: p.qty });
});

router.get("/movements", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  const prods = {}; for (const p of mine(db.stockProducts, req)) prods[p.id] = p;
  let list = mine(db.stockMovements, req);
  if (req.query.productId) list = list.filter(m => m.productId === req.query.productId);
  if (req.query.type) list = list.filter(m => m.type === req.query.type);
  if (req.query.from) list = list.filter(m => (m.date || "") >= req.query.from);
  if (req.query.to) list = list.filter(m => (m.date || "") <= req.query.to);
  const rows = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""))
    .map(m => Object.assign({}, m, { productName: (prods[m.productId] || {}).name || "" }));
  res.json(rows.slice(0, 1000));
});

router.get("/dashboard", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  const prods = mine(db.stockProducts, req).map(p => prodOut(p, req));
  const stockValue = prods.reduce((s, p) => s + p.stockValue, 0);
  const low = prods.filter(p => p.low && !p.out);
  const out = prods.filter(p => p.out);
  const recent = mine(db.stockMovements, req).slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 8)
    .map(m => { const p = mine(db.stockProducts, req).find(x => x.id === m.productId) || {}; return { date: m.date, type: m.type, productName: p.name || "", qty: m.qty }; });
  const topValue = prods.slice().sort((a, b) => b.stockValue - a.stockValue).slice(0, 5).map(p => ({ name: p.name, qty: p.qty, unitName: p.unitName, stockValue: p.stockValue }));
  res.json({
    kpi: { products: prods.length, stockValue: R2(stockValue), lowStock: low.length, outOfStock: out.length },
    lowList: low.sort((a, b) => a.qty - b.qty).slice(0, 10).map(p => ({ id: p.id, name: p.name, qty: p.qty, alertQty: p.alertQty, unitName: p.unitName })),
    recent, topValue
  });
});

/* ============================ IMPORTS (produits & stock d'ouverture) ============================ */
function refByName(req, col, name) {
  const n = String(name || "").trim(); if (!n) return "";
  let x = mine(db[col], req).find(r => String(r.name || "").toLowerCase() === n.toLowerCase());
  if (!x) { x = stamp({ id: id("stk"), name: n, createdAt: new Date().toISOString() }, req); db[col].push(x); }
  return x.id;
}
router.post("/products/import", allow("ADM", "CD", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  let created = 0, skipped = 0;
  for (const r of rows) {
    const name = String(r.name || "").trim(); if (!name) { skipped++; continue; }
    const sku = String(r.sku || "").trim();
    if (sku && mine(db.stockProducts, req).some(p => p.sku === sku)) { skipped++; continue; }
    const qty = Q(r.qty || 0);
    const p = stamp({ id: id("prd"), sku, barcode: String(r.barcode || ""), name,
      categoryId: refByName(req, "stockCategories", r.category), unitId: refByName(req, "stockUnits", r.unit), brandId: refByName(req, "stockBrands", r.brand),
      supplierId: "", warrantyId: "", priceGroupId: "", purchasePrice: R2(r.purchasePrice), salePrice: R2(r.salePrice),
      qty, alertQty: (r.alertQty != null && r.alertQty !== "") ? Q(r.alertQty) : "", active: true, note: "", createdAt: new Date().toISOString() }, req);
    db.stockProducts.push(p);
    if (qty) db.stockMovements.push(stamp({ id: id("mov"), date: new Date().toISOString().slice(0, 10), type: "initial", productId: p.id, qty, unitCost: p.purchasePrice, ref: "Import produits", createdBy: req.user.id, createdAt: new Date().toISOString() }, req));
    created++;
  }
  save(); audit(req.user, "IMPORTED", "StockProducts", "", { created }); res.json({ ok: true, created, skipped });
});
router.post("/opening", allow("ADM", "CD", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  let updated = 0, notfound = 0, unchanged = 0;
  for (const r of rows) {
    const key = String(r.sku || r.name || "").trim().toLowerCase(); if (!key) { notfound++; continue; }
    const p = mine(db.stockProducts, req).find(x => (x.sku && String(x.sku).toLowerCase() === key) || String(x.name || "").toLowerCase() === key);
    if (!p) { notfound++; continue; }
    if (r.unitCost != null && r.unitCost !== "") p.purchasePrice = R2(r.unitCost);
    const target = Q(r.qty || 0); const delta = target - Q(p.qty || 0);
    if (delta) { p.qty = target; db.stockMovements.push(stamp({ id: id("mov"), date: new Date().toISOString().slice(0, 10), type: "initial", productId: p.id, qty: delta, unitCost: p.purchasePrice, ref: "Stock d'ouverture", createdBy: req.user.id, createdAt: new Date().toISOString() }, req)); updated++; }
    else unchanged++;
  }
  save(); audit(req.user, "IMPORTED", "StockOpening", "", { updated }); res.json({ ok: true, updated, notfound, unchanged });
});

/* ============================ ACHATS (bons de commande, réceptions, retours) ============================ */
function seqRef(req, col, prefix, field) {
  const yy = new Date().getFullYear();
  const n = mine(db[col], req).filter(x => String(x[field] || "").startsWith(prefix + yy)).length + 1;
  return prefix + yy + "/" + String(n).padStart(4, "0");
}
function calcLines(lines) {
  let subtotal = 0;
  const out = (Array.isArray(lines) ? lines : []).filter(l => l.productId && Q(l.qty) > 0).map(l => {
    const qty = Q(l.qty), pu = R2(l.unitCost), disc = Number(l.discountPct) || 0;
    const net = Math.round(qty * pu * (1 - disc / 100));
    return { productId: l.productId, qty, unitCost: pu, discountPct: disc, net, receivedQty: Q(l.receivedQty || 0) };
  });
  subtotal = out.reduce((s, l) => s + l.net, 0);
  return { lines: out, subtotal };
}
function pName(req, pid) { const p = _prod(req, pid); return p ? p.name : ""; }
function docTotals(subtotal, taxPct, shippingFee) {
  const tax = Math.round(subtotal * (Number(taxPct) || 0) / 100);
  const ship = R2(shippingFee);
  return { tax, shipping: ship, total: subtotal + tax + ship };
}

/* ---- Bons de commande ---- */
function poOut(po) {
  const ordered = (po.lines || []).reduce((s, l) => s + Q(l.qty), 0);
  const received = (po.lines || []).reduce((s, l) => s + Q(l.receivedQty || 0), 0);
  const remaining = Q(ordered - received);
  const status = received <= 0 ? "ordered" : (remaining > 0 ? "partial" : "completed");
  return Object.assign({}, po, { ordered, received, remaining, status });
}
router.get("/po", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockPOs, req).map(poOut).sort((a, b) => (b.date || "").localeCompare(a.date || "")));
});
router.get("/po/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  const o = poOut(po); o.lines = (o.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })); res.json(o);
});
router.post("/po", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines);
  if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  const t = docTotals(subtotal, b.taxPct, b.shippingFee);
  const po = stamp({ id: id("po"), ref: b.ref || seqRef(req, "stockPOs", "PO", "ref"), supplierId: b.supplierId || "", date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    location: b.location || "", paymentTerms: b.paymentTerms || "", deliveryDelay: b.deliveryDelay || "", shippingStatus: b.shippingStatus || "", deliverTo: b.deliverTo || "", note: b.note || "",
    taxPct: Number(b.taxPct) || 0, shippingFee: R2(b.shippingFee), subtotal, tax: t.tax, total: t.total, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockPOs.push(po); save(); audit(req.user, "CREATED", "StockPO", po.id, { ref: po.ref }); res.status(201).json(poOut(po));
});
router.put("/po/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  if ((po.lines || []).some(l => Q(l.receivedQty || 0) > 0)) return res.status(409).json({ error: "BC déjà partiellement reçu — non modifiable" });
  const b = req.body || {};
  for (const f of ["supplierId", "date", "location", "paymentTerms", "deliveryDelay", "shippingStatus", "deliverTo", "note"]) if (b[f] !== undefined) po[f] = b[f];
  if (Array.isArray(b.lines)) { const { lines, subtotal } = calcLines(b.lines); po.lines = lines; po.subtotal = subtotal; const t = docTotals(subtotal, b.taxPct != null ? b.taxPct : po.taxPct, b.shippingFee != null ? b.shippingFee : po.shippingFee); po.tax = t.tax; po.total = t.total; }
  if (b.taxPct !== undefined) po.taxPct = Number(b.taxPct) || 0;
  if (b.shippingFee !== undefined) po.shippingFee = R2(b.shippingFee);
  save(); res.json(poOut(po));
});
router.delete("/po/:id", allow("ADM", "CD"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "Introuvable" });
  if ((po.lines || []).some(l => Q(l.receivedQty || 0) > 0)) return res.status(409).json({ error: "BC déjà reçu — non supprimable" });
  db.stockPOs.splice(db.stockPOs.indexOf(po), 1); save(); res.json({ ok: true });
});
// Réception d'un BC : reçoit le reliquat, incrémente le stock, crée un achat
router.post("/po/:id/receive", allow("ADM", "CD", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  const date = (req.body && req.body.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const recvLines = [];
  for (const l of (po.lines || [])) { const rem = Q(Q(l.qty) - Q(l.receivedQty || 0)); if (rem <= 0) continue;
    recvLines.push({ productId: l.productId, qty: rem, unitCost: l.unitCost, discountPct: l.discountPct });
    l.receivedQty = Q(l.qty);
  }
  if (!recvLines.length) return res.status(400).json({ error: "Rien à recevoir (BC déjà complet)" });
  const pur = createPurchase(req, { supplierId: po.supplierId, date, poId: po.id, poRef: po.ref, lines: recvLines, taxPct: po.taxPct, shippingFee: 0, amountPaid: 0, note: "Réception BC " + po.ref });
  save(); audit(req.user, "RECEIVED", "StockPO", po.id, { ref: po.ref, purchase: pur.ref }); res.json({ ok: true, po: poOut(po), purchaseRef: pur.ref });
});

/* ---- Achats (réceptions) ---- */
function createPurchase(req, b) {
  const { lines, subtotal } = calcLines(b.lines);
  const t = docTotals(subtotal, b.taxPct, b.shippingFee);
  const paid = R2(b.amountPaid);
  const pur = stamp({ id: id("pur"), ref: b.ref || seqRef(req, "stockPurchases", "ACH", "ref"), supplierId: b.supplierId || "", poId: b.poId || "", poRef: b.poRef || "",
    date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), location: b.location || "", note: b.note || "",
    taxPct: Number(b.taxPct) || 0, shippingFee: t.shipping, subtotal, tax: t.tax, total: t.total,
    amountPaid: Math.min(paid, t.total), paymentStatus: paid >= t.total && t.total > 0 ? "paid" : paid > 0 ? "partial" : "due",
    purchaseStatus: "received", lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockPurchases.push(pur);
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue; p.qty = Q((p.qty || 0) + l.qty); if (l.unitCost) p.purchasePrice = l.unitCost;
    logMove(req, { date: pur.date, type: "achat", productId: p.id, qty: l.qty, unitCost: l.unitCost, ref: pur.ref, supplierId: pur.supplierId, sourceType: "purchase", sourceId: pur.id });
  }
  return pur;
}
router.get("/purchases", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockPurchases, req).slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")));
});
router.get("/purchases/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const pur = mine(db.stockPurchases, req).find(x => x.id === req.params.id); if (!pur) return res.status(404).json({ error: "Achat introuvable" });
  res.json(Object.assign({}, pur, { lines: (pur.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })) }));
});
router.post("/purchases", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines } = calcLines(b.lines);
  if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  const pur = createPurchase(req, b); save(); audit(req.user, "STOCK_IN", "StockPurchase", pur.id, { ref: pur.ref }); res.status(201).json(pur);
});
router.post("/purchases/:id/pay", allow("ADM", "CD", "GPF"), (req, res) => {
  const pur = mine(db.stockPurchases, req).find(x => x.id === req.params.id); if (!pur) return res.status(404).json({ error: "Achat introuvable" });
  const amt = R2((req.body || {}).amount);
  pur.amountPaid = Math.min(R2(pur.amountPaid) + amt, pur.total);
  pur.paymentStatus = pur.amountPaid >= pur.total && pur.total > 0 ? "paid" : pur.amountPaid > 0 ? "partial" : "due";
  save(); res.json({ ok: true, amountPaid: pur.amountPaid, paymentStatus: pur.paymentStatus });
});
router.delete("/purchases/:id", allow("ADM", "CD"), (req, res) => {
  const pur = mine(db.stockPurchases, req).find(x => x.id === req.params.id); if (!pur) return res.status(404).json({ error: "Introuvable" });
  // reverse stock + remove linked movements
  for (const m of mine(db.stockMovements, req).filter(m => m.sourceType === "purchase" && m.sourceId === pur.id)) {
    const p = _prod(req, m.productId); if (p) p.qty = Q((p.qty || 0) - Q(m.qty)); db.stockMovements.splice(db.stockMovements.indexOf(m), 1);
  }
  if (pur.poId) { const po = mine(db.stockPOs, req).find(x => x.id === pur.poId); if (po) for (const l of (po.lines || [])) { const pl = (pur.lines || []).find(x => x.productId === l.productId); if (pl) l.receivedQty = Q(Q(l.receivedQty || 0) - Q(pl.qty)); } }
  db.stockPurchases.splice(db.stockPurchases.indexOf(pur), 1); save(); res.json({ ok: true });
});

/* ---- Retours d'achat ---- */
router.get("/returns", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockReturns, req).slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")));
});
router.post("/returns", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines);
  if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  const ret = stamp({ id: id("ret"), ref: b.ref || seqRef(req, "stockReturns", "RET", "ref"), supplierId: b.supplierId || "", purchaseId: b.purchaseId || "",
    date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), note: b.note || "", subtotal, total: subtotal, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockReturns.push(ret);
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue; p.qty = Q((p.qty || 0) - l.qty);
    logMove(req, { date: ret.date, type: "retour", productId: p.id, qty: -l.qty, unitCost: l.unitCost, ref: ret.ref, supplierId: ret.supplierId, sourceType: "return", sourceId: ret.id });
  }
  save(); audit(req.user, "STOCK_RETURN", "StockReturn", ret.id, { ref: ret.ref }); res.status(201).json(ret);
});
router.delete("/returns/:id", allow("ADM", "CD"), (req, res) => {
  const ret = mine(db.stockReturns, req).find(x => x.id === req.params.id); if (!ret) return res.status(404).json({ error: "Introuvable" });
  for (const m of mine(db.stockMovements, req).filter(m => m.sourceType === "return" && m.sourceId === ret.id)) {
    const p = _prod(req, m.productId); if (p) p.qty = Q((p.qty || 0) - Q(m.qty)); db.stockMovements.splice(db.stockMovements.indexOf(m), 1);
  }
  db.stockReturns.splice(db.stockReturns.indexOf(ret), 1); save(); res.json({ ok: true });
});

/* ============================ VENTES (commande client, ventes, devis, retours) ============================ */
function cName(req, cid) { const c = mine(db.stockContacts, req).find(x => x.id === cid); return c ? c.name : ""; }
function stockAvail(req, lines, allowNeg) {
  if (allowNeg) return null;
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue; if (Q(l.qty) > Q(p.qty || 0)) return `Stock insuffisant pour « ${p.name} » (disponible ${Q(p.qty || 0)}, demandé ${Q(l.qty)})`; }
  return null;
}

/* ---- Commande client (sales order) ---- */
function soOut(so) {
  const ordered = (so.lines || []).reduce((s, l) => s + Q(l.qty), 0);
  const delivered = (so.lines || []).reduce((s, l) => s + Q(l.deliveredQty || 0), 0);
  const remaining = Q(ordered - delivered);
  const status = delivered <= 0 ? "ordered" : (remaining > 0 ? "partial" : "completed");
  return Object.assign({}, so, { ordered, delivered, remaining, status });
}
router.get("/so", allow("ADM", "CD", "RJ", "GPF"), (req, res) => { seedStock(req.user.tenantId || "t1"); res.json(mine(db.stockSOs, req).map(soOut).sort((a, b) => (b.date || "").localeCompare(a.date || ""))); });
router.get("/so/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const so = mine(db.stockSOs, req).find(x => x.id === req.params.id); if (!so) return res.status(404).json({ error: "Commande introuvable" });
  const o = soOut(so); o.lines = (o.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })); res.json(o);
});
router.post("/so", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines); if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  const t = docTotals(subtotal, b.taxPct, b.shippingFee);
  const so = stamp({ id: id("so"), ref: b.ref || seqRef(req, "stockSOs", "CC", "ref"), customerId: b.customerId || "", date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    location: b.location || "", paymentTerms: b.paymentTerms || "", deliverTo: b.deliverTo || "", note: b.note || "", taxPct: Number(b.taxPct) || 0, shippingFee: R2(b.shippingFee),
    subtotal, tax: t.tax, total: t.total, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockSOs.push(so); save(); audit(req.user, "CREATED", "StockSO", so.id, { ref: so.ref }); res.status(201).json(soOut(so));
});
router.delete("/so/:id", allow("ADM", "CD"), (req, res) => {
  const so = mine(db.stockSOs, req).find(x => x.id === req.params.id); if (!so) return res.status(404).json({ error: "Introuvable" });
  if ((so.lines || []).some(l => Q(l.deliveredQty || 0) > 0)) return res.status(409).json({ error: "Commande déjà livrée — non supprimable" });
  db.stockSOs.splice(db.stockSOs.indexOf(so), 1); save(); res.json({ ok: true });
});
router.post("/so/:id/deliver", allow("ADM", "CD", "GPF"), (req, res) => {
  const so = mine(db.stockSOs, req).find(x => x.id === req.params.id); if (!so) return res.status(404).json({ error: "Commande introuvable" });
  const allowNeg = !!(req.body && req.body.allowNegative);
  const lines = [];
  for (const l of (so.lines || [])) { const rem = Q(Q(l.qty) - Q(l.deliveredQty || 0)); if (rem <= 0) continue; lines.push({ productId: l.productId, qty: rem, unitCost: l.unitCost, discountPct: l.discountPct }); }
  if (!lines.length) return res.status(400).json({ error: "Rien à livrer (commande déjà complète)" });
  const err = stockAvail(req, lines, allowNeg); if (err) return res.status(400).json({ error: err });
  for (const l of (so.lines || [])) l.deliveredQty = Q(l.qty);
  const sale = createSale(req, { customerId: so.customerId, date: (req.body && req.body.date) || new Date().toISOString().slice(0, 10), soId: so.id, soRef: so.ref, lines, taxPct: so.taxPct, shippingFee: 0, amountPaid: 0, allowNegative: true, note: "Livraison commande " + so.ref });
  save(); res.json({ ok: true, so: soOut(so), saleRef: sale.ref });
});

/* ---- Ventes ---- */
function createSale(req, b) {
  const { lines, subtotal } = calcLines(b.lines);
  const t = docTotals(subtotal, b.taxPct, b.shippingFee); const paid = R2(b.amountPaid);
  const sale = stamp({ id: id("sal"), ref: b.ref || seqRef(req, "stockSales", "VTE", "ref"), customerId: b.customerId || "", soId: b.soId || "", soRef: b.soRef || "",
    date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), channel: b.channel || "vente", note: b.note || "",
    taxPct: Number(b.taxPct) || 0, shippingFee: t.shipping, subtotal, tax: t.tax, total: t.total,
    amountPaid: Math.min(paid, t.total), paymentStatus: paid >= t.total && t.total > 0 ? "paid" : paid > 0 ? "partial" : "due",
    saleStatus: "final", lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockSales.push(sale);
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue; p.qty = Q((p.qty || 0) - l.qty);
    logMove(req, { date: sale.date, type: "vente", productId: p.id, qty: -l.qty, unitCost: l.unitCost, ref: sale.ref, customer: cName(req, sale.customerId), sourceType: "sale", sourceId: sale.id });
  }
  return sale;
}
router.get("/sales", allow("ADM", "CD", "RJ", "GPF"), (req, res) => { seedStock(req.user.tenantId || "t1"); res.json(mine(db.stockSales, req).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))); });
router.get("/sales/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const sale = mine(db.stockSales, req).find(x => x.id === req.params.id); if (!sale) return res.status(404).json({ error: "Vente introuvable" });
  res.json(Object.assign({}, sale, { lines: (sale.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })) }));
});
router.post("/sales", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines } = calcLines(b.lines); if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  const err = stockAvail(req, lines, !!b.allowNegative); if (err) return res.status(400).json({ error: err });
  const sale = createSale(req, b); save(); audit(req.user, "STOCK_OUT", "StockSale", sale.id, { ref: sale.ref }); res.status(201).json(sale);
});
router.post("/sales/:id/pay", allow("ADM", "CD", "GPF"), (req, res) => {
  const sale = mine(db.stockSales, req).find(x => x.id === req.params.id); if (!sale) return res.status(404).json({ error: "Vente introuvable" });
  sale.amountPaid = Math.min(R2(sale.amountPaid) + R2((req.body || {}).amount), sale.total);
  sale.paymentStatus = sale.amountPaid >= sale.total && sale.total > 0 ? "paid" : sale.amountPaid > 0 ? "partial" : "due";
  save(); res.json({ ok: true, amountPaid: sale.amountPaid, paymentStatus: sale.paymentStatus });
});
router.delete("/sales/:id", allow("ADM", "CD"), (req, res) => {
  const sale = mine(db.stockSales, req).find(x => x.id === req.params.id); if (!sale) return res.status(404).json({ error: "Introuvable" });
  for (const m of mine(db.stockMovements, req).filter(m => m.sourceType === "sale" && m.sourceId === sale.id)) { const p = _prod(req, m.productId); if (p) p.qty = Q((p.qty || 0) - Q(m.qty)); db.stockMovements.splice(db.stockMovements.indexOf(m), 1); }
  if (sale.soId) { const so = mine(db.stockSOs, req).find(x => x.id === sale.soId); if (so) for (const l of (so.lines || [])) { const sl = (sale.lines || []).find(x => x.productId === l.productId); if (sl) l.deliveredQty = Q(Q(l.deliveredQty || 0) - Q(sl.qty)); } }
  db.stockSales.splice(db.stockSales.indexOf(sale), 1); save(); res.json({ ok: true });
});

/* ---- Devis (quotations) ---- */
router.get("/quotes", allow("ADM", "CD", "RJ", "GPF"), (req, res) => { seedStock(req.user.tenantId || "t1"); res.json(mine(db.stockQuotes, req).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))); });
router.get("/quotes/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const q = mine(db.stockQuotes, req).find(x => x.id === req.params.id); if (!q) return res.status(404).json({ error: "Devis introuvable" });
  res.json(Object.assign({}, q, { lines: (q.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })) }));
});
router.post("/quotes", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines); if (!lines.length) return res.status(400).json({ error: "Au moins une ligne" });
  const t = docTotals(subtotal, b.taxPct, b.shippingFee);
  const q = stamp({ id: id("qte"), ref: b.ref || seqRef(req, "stockQuotes", "DEV", "ref"), customerId: b.customerId || "", date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    note: b.note || "", taxPct: Number(b.taxPct) || 0, shippingFee: R2(b.shippingFee), subtotal, tax: t.tax, total: t.total, status: "open", lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockQuotes.push(q); save(); res.status(201).json(q);
});
router.delete("/quotes/:id", allow("ADM", "CD"), (req, res) => {
  const q = mine(db.stockQuotes, req).find(x => x.id === req.params.id); if (!q) return res.status(404).json({ error: "Introuvable" });
  db.stockQuotes.splice(db.stockQuotes.indexOf(q), 1); save(); res.json({ ok: true });
});
router.post("/quotes/:id/convert", allow("ADM", "CD", "GPF"), (req, res) => {
  const q = mine(db.stockQuotes, req).find(x => x.id === req.params.id); if (!q) return res.status(404).json({ error: "Devis introuvable" });
  const err = stockAvail(req, q.lines || [], !!(req.body && req.body.allowNegative)); if (err) return res.status(400).json({ error: err });
  const sale = createSale(req, { customerId: q.customerId, date: new Date().toISOString().slice(0, 10), lines: q.lines, taxPct: q.taxPct, shippingFee: q.shippingFee, amountPaid: 0, allowNegative: true, note: "Devis " + q.ref });
  q.status = "converted"; q.saleRef = sale.ref; save(); res.json({ ok: true, saleRef: sale.ref });
});

/* ---- Retours de vente ---- */
router.get("/salesreturns", allow("ADM", "CD", "RJ", "GPF"), (req, res) => { seedStock(req.user.tenantId || "t1"); res.json(mine(db.stockSalesReturns, req).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))); });
router.post("/salesreturns", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines); if (!lines.length) return res.status(400).json({ error: "Au moins une ligne" });
  const ret = stamp({ id: id("sret"), ref: b.ref || seqRef(req, "stockSalesReturns", "RTV", "ref"), customerId: b.customerId || "", saleId: b.saleId || "",
    date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), note: b.note || "", subtotal, total: subtotal, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockSalesReturns.push(ret);
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue; p.qty = Q((p.qty || 0) + l.qty); logMove(req, { date: ret.date, type: "retourv", productId: p.id, qty: l.qty, unitCost: l.unitCost, ref: ret.ref, customer: cName(req, ret.customerId), sourceType: "salesreturn", sourceId: ret.id }); }
  save(); res.status(201).json(ret);
});
router.delete("/salesreturns/:id", allow("ADM", "CD"), (req, res) => {
  const ret = mine(db.stockSalesReturns, req).find(x => x.id === req.params.id); if (!ret) return res.status(404).json({ error: "Introuvable" });
  for (const m of mine(db.stockMovements, req).filter(m => m.sourceType === "salesreturn" && m.sourceId === ret.id)) { const p = _prod(req, m.productId); if (p) p.qty = Q((p.qty || 0) - Q(m.qty)); db.stockMovements.splice(db.stockMovements.indexOf(m), 1); }
  db.stockSalesReturns.splice(db.stockSalesReturns.indexOf(ret), 1); save(); res.json({ ok: true });
});

module.exports = router;
module.exports.seedStock = seedStock;
