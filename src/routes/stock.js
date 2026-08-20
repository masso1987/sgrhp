/**
 * SGRHP — Gestion de stock (module « stock »).
 * Catalogue (produits, catégories, unités, fournisseurs) + mouvements de stock
 * (entrées/achats, sorties/ventes, ajustements) avec stock courant et valorisation.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

for (const k of ["stockProducts", "stockCategories", "stockUnits", "stockSuppliers", "stockContacts", "stockBrands", "stockWarranties", "stockPriceGroups", "stockVariations", "stockPOs", "stockPurchases", "stockReturns", "stockSOs", "stockSales", "stockQuotes", "stockSalesReturns", "stockLocations", "stockTransfers", "stockExpenseCats", "stockExpenses", "stockPaymentAccounts", "stockMovements"]) if (!db[k]) db[k] = [];

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
crud("locations", "stockLocations", ["name", "address"], "name", ["ADM", "CD", "GPF"]);
crud("expensecats", "stockExpenseCats", ["name"], "name", ["ADM", "CD", "GPF"]);

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
router.get("/contacts/:id/statement", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const c = mine(db.stockContacts, req).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Contact introuvable" });
  const kind = c.type || "fournisseur"; const rows = [];
  const ob = R2(c.openingBalance);
  if (ob) rows.push({ type: "Solde d'ouverture", ref: "", date: "", total: ob, paid: 0, due: ob });
  if (kind === "client") {
    for (const x of mine(db.stockSales, req).filter(y => y.customerId === c.id)) rows.push({ type: "Vente", ref: x.ref, date: x.date, total: R2(x.total), paid: R2(x.amountPaid), due: R2(x.total) - R2(x.amountPaid) });
    for (const x of mine(db.stockSalesReturns, req).filter(y => y.customerId === c.id)) rows.push({ type: "Retour vente", ref: x.ref, date: x.date, total: -R2(x.total), paid: 0, due: -R2(x.total) });
  } else {
    for (const x of mine(db.stockPurchases, req).filter(y => y.supplierId === c.id)) rows.push({ type: "Achat", ref: x.ref, date: x.date, total: R2(x.total), paid: R2(x.amountPaid), due: R2(x.total) - R2(x.amountPaid) });
    for (const x of mine(db.stockReturns, req).filter(y => y.supplierId === c.id)) rows.push({ type: "Retour achat", ref: x.ref, date: x.date, total: -R2(x.total), paid: 0, due: -R2(x.total) });
  }
  rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const totals = { total: rows.reduce((s, r) => s + r.total, 0), paid: rows.reduce((s, r) => s + r.paid, 0), due: rows.reduce((s, r) => s + r.due, 0) };
  res.json({ contact: { id: c.id, code: c.contactId, name: c.name, kind, openingBalance: ob, mobile: c.mobile || "", email: c.email || "" }, rows, totals });
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
    active: b.active !== false, note: b.note || "", expDate: b.expDate || "", mfgDate: b.mfgDate || "", createdAt: new Date().toISOString()
  }, req);
  db.stockProducts.push(p);
  if (initial) db.stockMovements.push(stamp({ id: id("mov"), date: new Date().toISOString().slice(0, 10), type: "initial", productId: p.id, qty: initial, unitCost: p.purchasePrice, ref: "Stock initial", note: "", createdBy: req.user.id, createdAt: new Date().toISOString() }, req));
  save(); audit(req.user, "CREATED", "StockProduct", p.id, { name: p.name }); res.status(201).json(prodOut(p, req));
});
router.put("/products/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const p = mine(db.stockProducts, req).find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: "Produit introuvable" });
  const b = req.body || {};
  for (const f of ["sku", "barcode", "name", "categoryId", "unitId", "supplierId", "brandId", "warrantyId", "priceGroupId", "note", "expDate", "mfgDate"]) if (b[f] !== undefined) p[f] = b[f];
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
const PO_ORDER_STATUS = ["commande", "emballe", "expedie", "livre", "annule"];
function attachOf(a) {
  if (!a || !a.dataUrl) return null;
  if (String(a.dataUrl).length > 8 * 1024 * 1024) return "TOO_BIG";
  return { name: String(a.name || "document").slice(0, 160), size: Number(a.size) || 0, dataUrl: a.dataUrl };
}
function calcLines(lines) {
  let subtotal = 0;
  const out = (Array.isArray(lines) ? lines : []).filter(l => l.productId && Q(l.qty) > 0).map(l => {
    const qty = Q(l.qty), pu = R2(l.unitCost), disc = Number(l.discountPct) || 0;
    let lineDisc; if (l.discountMode === "fixed") lineDisc = R2(l.discountValue); else if (l.discountMode === "percent") lineDisc = Math.round(qty * pu * (Number(l.discountValue) || 0) / 100); else lineDisc = Math.round(qty * pu * disc / 100);
    const net = Math.max(0, Math.round(qty * pu) - lineDisc);
    const extra = {}; if (l.salePrice !== undefined && l.salePrice !== "") extra.salePrice = R2(l.salePrice);
    if (l.mfgDate) extra.mfgDate = String(l.mfgDate).slice(0, 10); if (l.expDate) extra.expDate = String(l.expDate).slice(0, 10);
    if (l.unitId) extra.unitId = l.unitId; if (l.warrantyId) extra.warrantyId = l.warrantyId; if (l.note) extra.note = String(l.note).slice(0, 300);
    if (l.discountMode) extra.discountMode = l.discountMode; if (l.discountValue !== undefined) extra.discountValue = R2(l.discountValue);
    return Object.assign({ productId: l.productId, qty, unitCost: pu, discountPct: disc, net, receivedQty: Q(l.receivedQty || 0) }, extra);
  });
  subtotal = out.reduce((s, l) => s + l.net, 0);
  return { lines: out, subtotal };
}
function pName(req, pid) { const p = _prod(req, pid); return p ? p.name : ""; }
function uName(uid) { const u = (db.users || []).find(x => x.id === uid); return u ? (u.fullName || u.email || "") : ""; }
function lineQty(d) { return (d.lines || []).reduce((s, l) => s + Q(l.qty), 0); }
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
  res.json(mine(db.stockPOs, req).map(po => Object.assign(poOut(po), { addedBy: uName(po.createdBy) })).sort((a, b) => (b.date || "").localeCompare(a.date || "")));
});
router.get("/po/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  const o = poOut(po); o.lines = (o.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })); res.json(o);
});
router.post("/po", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines);
  if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  const t = docTotals(subtotal, b.taxPct, b.shippingFee);
  const att = attachOf(b.attachment); if (att === "TOO_BIG") return res.status(400).json({ error: "Document trop volumineux (max 5 Mo)" });
  const po = stamp({ id: id("po"), ref: b.ref || seqRef(req, "stockPOs", "PO", "ref"), supplierId: b.supplierId || "", date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    location: b.location || "", paymentTerms: b.paymentTerms || "", deliveryDelay: b.deliveryDelay || "", orderStatus: PO_ORDER_STATUS.includes(b.orderStatus) ? b.orderStatus : "commande", deliverTo: b.deliverTo || "", note: b.note || "", attachment: att || null,
    taxPct: Number(b.taxPct) || 0, shippingFee: R2(b.shippingFee), subtotal, tax: t.tax, total: t.total, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockPOs.push(po); save(); audit(req.user, "CREATED", "StockPO", po.id, { ref: po.ref }); res.status(201).json(poOut(po));
});
router.put("/po/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  if ((po.lines || []).some(l => Q(l.receivedQty || 0) > 0)) return res.status(409).json({ error: "BC déjà partiellement reçu — non modifiable" });
  const b = req.body || {};
  for (const f of ["supplierId", "date", "location", "paymentTerms", "deliveryDelay", "deliverTo", "note"]) if (b[f] !== undefined) po[f] = b[f];
  if (b.orderStatus !== undefined && PO_ORDER_STATUS.includes(b.orderStatus)) po.orderStatus = b.orderStatus;
  if (b.attachment !== undefined) { const att = attachOf(b.attachment); if (att === "TOO_BIG") return res.status(400).json({ error: "Document trop volumineux (max 5 Mo)" }); po.attachment = att || null; }
  if (Array.isArray(b.lines)) { const { lines, subtotal } = calcLines(b.lines); po.lines = lines; po.subtotal = subtotal; const t = docTotals(subtotal, b.taxPct != null ? b.taxPct : po.taxPct, b.shippingFee != null ? b.shippingFee : po.shippingFee); po.tax = t.tax; po.total = t.total; }
  if (b.taxPct !== undefined) po.taxPct = Number(b.taxPct) || 0;
  if (b.shippingFee !== undefined) po.shippingFee = R2(b.shippingFee);
  save(); audit(req.user, "UPDATED", "StockPO", po.id, { ref: po.ref }); res.json(poOut(po));
});
router.put("/po/:id/shipping", allow("ADM", "CD", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  const b = req.body || {};
  if (b.orderStatus !== undefined && PO_ORDER_STATUS.includes(b.orderStatus)) po.orderStatus = b.orderStatus;
  for (const k of ["deliveryDelay", "deliverTo"]) if (b[k] !== undefined) po[k] = b[k];
  if (b.shippingFee !== undefined) { po.shippingFee = R2(b.shippingFee); po.total = po.subtotal + po.tax + po.shippingFee; }
  save(); audit(req.user, "SHIPPING", "StockPO", po.id, {}); res.json(poOut(po));
});
router.delete("/po/:id", allow("ADM", "CD"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "Introuvable" });
  if ((po.lines || []).some(l => Q(l.receivedQty || 0) > 0)) return res.status(409).json({ error: "BC déjà reçu — non supprimable" });
  db.stockPOs.splice(db.stockPOs.indexOf(po), 1); save(); res.json({ ok: true });
});
// Réception d'un BC : reçoit le reliquat, incrémente le stock, crée un achat
router.put("/po/:id/status", allow("ADM", "CD", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  const st = (req.body || {}).orderStatus; if (!PO_ORDER_STATUS.includes(st)) return res.status(400).json({ error: "Statut invalide" });
  po.orderStatus = st; save(); audit(req.user, "STATUS", "StockPO", po.id, { orderStatus: st }); res.json({ ok: true, orderStatus: st });
});
router.post("/po/:id/receive", allow("ADM", "CD", "GPF"), (req, res) => {
  const po = mine(db.stockPOs, req).find(x => x.id === req.params.id); if (!po) return res.status(404).json({ error: "BC introuvable" });
  const date = (req.body && req.body.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const recvLines = [];
  for (const l of (po.lines || [])) { const rem = Q(Q(l.qty) - Q(l.receivedQty || 0)); if (rem <= 0) continue;
    recvLines.push({ productId: l.productId, qty: rem, unitCost: l.unitCost, discountPct: l.discountPct });
  }
  if (!recvLines.length) return res.status(400).json({ error: "Rien à recevoir (BC déjà complet)" });
  const pur = createPurchase(req, { supplierId: po.supplierId, date, poId: po.id, poRef: po.ref, paymentTerms: po.paymentTerms, lines: recvLines, taxPct: po.taxPct, shippingFee: 0, amountPaid: 0, note: "Réception BC " + po.ref });
  save(); audit(req.user, "RECEIVED", "StockPO", po.id, { ref: po.ref, purchase: pur.ref }); res.json({ ok: true, po: poOut(po), purchaseRef: pur.ref });
});

/* ---- Achats (réceptions) ---- */
function createPurchase(req, b) {
  const { lines, subtotal } = calcLines(b.lines);
  const dt = (b.discountType === "percent" || b.discountType === "fixed") ? b.discountType : "none";
  const discount = dt === "percent" ? Math.round(subtotal * (Number(b.discountValue) || 0) / 100) : dt === "fixed" ? R2(b.discountValue) : 0;
  const taxable = Math.max(0, subtotal - discount);
  const taxPct = Number(b.taxPct) || 0;
  const tax = Math.round(taxable * taxPct / 100);
  const ship = R2(b.shippingFee);
  const total = taxable + tax + ship;
  const paid = R2(b.amountPaid);
  const att = attachOf(b.attachment);
  const pStatus = ["received", "ordered", "pending"].includes(b.purchaseStatus) ? b.purchaseStatus : "received";
  const pur = stamp({ id: id("pur"), ref: b.ref || seqRef(req, "stockPurchases", "ACH", "ref"), supplierId: b.supplierId || "", poId: b.poId || "", poRef: b.poRef || "",
    date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), location: b.location || "", paymentTerms: b.paymentTerms || "", paymentAccountId: b.paymentAccountId || "", note: b.note || "", attachment: att && att !== "TOO_BIG" ? att : null,
    taxPct, shippingFee: ship, discountType: dt, discountValue: R2(b.discountValue), discount, subtotal, tax, total,
    amountPaid: Math.min(paid, total), paymentStatus: paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : "due",
    purchaseStatus: pStatus, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockPurchases.push(pur);
  if (b.poId) { const po = mine(db.stockPOs, req).find(x => x.id === b.poId); if (po) { for (const pl of lines) { const l = (po.lines || []).find(x => x.productId === pl.productId); if (l) l.receivedQty = Q(Q(l.receivedQty || 0) + pl.qty); } if ((po.lines || []).every(l => Q(l.receivedQty || 0) >= Q(l.qty))) po.orderStatus = "livre"; } }
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue;
    if (l.unitCost) p.purchasePrice = l.unitCost;
    if (l.salePrice) p.salePrice = l.salePrice; if (l.expDate) p.expDate = l.expDate; if (l.mfgDate) p.mfgDate = l.mfgDate;
    if (pStatus === "received") { p.qty = Q((p.qty || 0) + l.qty);
      logMove(req, { date: pur.date, type: "achat", productId: p.id, qty: l.qty, unitCost: l.unitCost, ref: pur.ref, supplierId: pur.supplierId, sourceType: "purchase", sourceId: pur.id }); }
  }
  return pur;
}
router.get("/purchases", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockPurchases, req).map(p => Object.assign({}, p, { addedBy: uName(p.createdBy), totalQty: lineQty(p) })).sort((a, b) => (b.date || "").localeCompare(a.date || "")));
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
  const dt = (b.discountType === "percent" || b.discountType === "fixed") ? b.discountType : "none";
  const discount = dt === "percent" ? Math.round(subtotal * (Number(b.discountValue) || 0) / 100) : dt === "fixed" ? R2(b.discountValue) : 0;
  const taxable = Math.max(0, subtotal - discount);
  const taxPct = Number(b.taxPct) || 0; const tax = Math.round(taxable * taxPct / 100); const ship = R2(b.shippingFee);
  const total = taxable + tax + ship; const paid = R2(b.amountPaid);
  const sale = stamp({ id: id("sal"), ref: b.ref || seqRef(req, "stockSales", "VTE", "ref"), customerId: b.customerId || "", soId: b.soId || "", soRef: b.soRef || "",
    date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), channel: b.channel || "vente", location: b.location || "", paymentAccountId: b.paymentAccountId || "", note: b.note || "",
    taxPct, shippingFee: ship, discountType: dt, discountValue: R2(b.discountValue), discount, subtotal, tax, total,
    amountPaid: Math.min(paid, total), paymentStatus: paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : "due",
    saleStatus: "final", lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockSales.push(sale);
  for (const l of lines) { const p = _prod(req, l.productId); if (!p) continue; p.qty = Q((p.qty || 0) - l.qty);
    logMove(req, { date: sale.date, type: "vente", productId: p.id, qty: -l.qty, unitCost: l.unitCost, ref: sale.ref, customer: cName(req, sale.customerId), sourceType: "sale", sourceId: sale.id });
  }
  return sale;
}
router.get("/sales", allow("ADM", "CD", "RJ", "GPF"), (req, res) => { seedStock(req.user.tenantId || "t1"); res.json(mine(db.stockSales, req).map(p => Object.assign({}, p, { addedBy: uName(p.createdBy), totalQty: lineQty(p) })).sort((a, b) => (b.date || "").localeCompare(a.date || ""))); });
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

/* ============================ TRANSFERTS DE STOCK ============================ */
const TRF_STATUS = ["en_cours", "termine", "annule"];
function locName(req, id) { const l = mine(db.stockLocations, req).find(x => x.id === id); return l ? l.name : ""; }
router.get("/transfers", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockTransfers, req).map(t => Object.assign({}, t, { fromName: locName(req, t.fromId), toName: locName(req, t.toId) })).sort((a, b) => (b.date || "").localeCompare(a.date || "")));
});
router.get("/transfers/:id", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const t = mine(db.stockTransfers, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Transfert introuvable" });
  res.json(Object.assign({}, t, { fromName: locName(req, t.fromId), toName: locName(req, t.toId), lines: (t.lines || []).map(l => Object.assign({}, l, { productName: pName(req, l.productId) })) }));
});
router.post("/transfers", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; const { lines, subtotal } = calcLines(b.lines);
  if (!lines.length) return res.status(400).json({ error: "Au moins une ligne (produit + quantité)" });
  if (!b.fromId || !b.toId) return res.status(400).json({ error: "Lieu (Du) et Lieu (Au) obligatoires" });
  if (b.fromId === b.toId) return res.status(400).json({ error: "Le lieu de départ et d'arrivée doivent être différents" });
  const ship = R2(b.shippingFee);
  const t = stamp({ id: id("trf"), ref: b.ref || seqRef(req, "stockTransfers", "TRF", "ref"), date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    status: TRF_STATUS.includes(b.status) ? b.status : "en_cours", fromId: b.fromId, toId: b.toId, shippingFee: ship, note: b.note || "",
    subtotal, total: subtotal + ship, lines, createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockTransfers.push(t);
  const label = "Transfert " + t.ref + " : " + locName(req, t.fromId) + " → " + locName(req, t.toId);
  for (const l of lines) logMove(req, { date: t.date, type: "transfert", productId: l.productId, qty: l.qty, unitCost: l.unitCost, ref: t.ref, note: label, sourceType: "transfer", sourceId: t.id });
  save(); audit(req.user, "STOCK_TRANSFER", "StockTransfer", t.id, { ref: t.ref }); res.status(201).json(t);
});
router.put("/transfers/:id/status", allow("ADM", "CD", "GPF"), (req, res) => {
  const t = mine(db.stockTransfers, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  const st = (req.body || {}).status; if (!TRF_STATUS.includes(st)) return res.status(400).json({ error: "Statut invalide" });
  t.status = st; save(); res.json({ ok: true, status: st });
});
router.delete("/transfers/:id", allow("ADM", "CD"), (req, res) => {
  const t = mine(db.stockTransfers, req).find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: "Introuvable" });
  for (const m of mine(db.stockMovements, req).filter(m => m.sourceType === "transfer" && m.sourceId === t.id)) db.stockMovements.splice(db.stockMovements.indexOf(m), 1);
  db.stockTransfers.splice(db.stockTransfers.indexOf(t), 1); save(); res.json({ ok: true });
});

/* ============================ DÉPENSES ============================ */
function expOut(req, e) {
  const c = mine(db.stockExpenseCats, req).find(x => x.id === e.categoryId);
  const acc = mine(db.stockPaymentAccounts, req).find(x => x.id === e.paymentAccountId);
  return Object.assign({}, e, { categoryName: c ? c.name : "", supplierName: cName(req, e.supplierId), accountName: acc ? acc.name : "", addedBy: uName(e.createdBy) });
}
router.get("/expenses", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  let list = mine(db.stockExpenses, req);
  if (req.query.from) list = list.filter(e => (e.date || "") >= req.query.from);
  if (req.query.to) list = list.filter(e => (e.date || "") <= req.query.to);
  if (req.query.categoryId) list = list.filter(e => e.categoryId === req.query.categoryId);
  res.json(list.map(e => expOut(req, e)).sort((a, b) => (b.date || "").localeCompare(a.date || "")));
});
router.post("/expenses", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; if (!(R2(b.amount) > 0)) return res.status(400).json({ error: "Montant obligatoire" });
  const e = stamp({ id: id("exp"), ref: b.ref || seqRef(req, "stockExpenses", "DEP", "ref"), date: (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    categoryId: b.categoryId || "", amount: R2(b.amount), supplierId: b.supplierId || "", location: b.location || "", paymentAccountId: b.paymentAccountId || "", note: b.note || "",
    createdBy: req.user.id, createdAt: new Date().toISOString() }, req);
  db.stockExpenses.push(e); save(); audit(req.user, "CREATED", "StockExpense", e.id, { amount: e.amount }); res.status(201).json(expOut(req, e));
});
router.put("/expenses/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const e = mine(db.stockExpenses, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Dépense introuvable" });
  const b = req.body || {};
  for (const k of ["date", "categoryId", "supplierId", "location", "paymentAccountId", "note"]) if (b[k] !== undefined) e[k] = b[k];
  if (b.amount !== undefined) e.amount = R2(b.amount);
  save(); res.json(expOut(req, e));
});
router.delete("/expenses/:id", allow("ADM", "CD"), (req, res) => {
  const e = mine(db.stockExpenses, req).find(x => x.id === req.params.id); if (!e) return res.status(404).json({ error: "Introuvable" });
  db.stockExpenses.splice(db.stockExpenses.indexOf(e), 1); save(); res.json({ ok: true });
});

/* ============================ COMPTES DE PAIEMENT ============================ */
function acctBalance(req, accId) {
  const acc = mine(db.stockPaymentAccounts, req).find(a => a.id === accId); if (!acc) return 0;
  let bal = R2(acc.openingBalance);
  for (const x of mine(db.stockSales, req)) if (x.paymentAccountId === accId) bal += R2(x.amountPaid);
  for (const x of mine(db.stockPurchases, req)) if (x.paymentAccountId === accId) bal -= R2(x.amountPaid);
  for (const x of mine(db.stockExpenses, req)) if (x.paymentAccountId === accId) bal -= R2(x.amount);
  return bal;
}
router.get("/accounts", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  res.json(mine(db.stockPaymentAccounts, req).map(a => Object.assign({}, a, { balance: acctBalance(req, a.id) })).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))));
});
router.post("/accounts", allow("ADM", "CD", "GPF"), (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: "Nom obligatoire" });
  const a = stamp({ id: id("pac"), name: b.name, type: b.type || "caisse", openingBalance: R2(b.openingBalance), note: b.note || "", createdAt: new Date().toISOString() }, req);
  db.stockPaymentAccounts.push(a); save(); res.status(201).json(Object.assign({}, a, { balance: acctBalance(req, a.id) }));
});
router.put("/accounts/:id", allow("ADM", "CD", "GPF"), (req, res) => {
  const a = mine(db.stockPaymentAccounts, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  const b = req.body || {}; for (const k of ["name", "type", "note"]) if (b[k] !== undefined) a[k] = b[k]; if (b.openingBalance !== undefined) a.openingBalance = R2(b.openingBalance);
  save(); res.json(Object.assign({}, a, { balance: acctBalance(req, a.id) }));
});
router.delete("/accounts/:id", allow("ADM", "CD"), (req, res) => {
  const a = mine(db.stockPaymentAccounts, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  db.stockPaymentAccounts.splice(db.stockPaymentAccounts.indexOf(a), 1); save(); res.json({ ok: true });
});
router.get("/accounts/:id/statement", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  const a = mine(db.stockPaymentAccounts, req).find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Introuvable" });
  const rows = [{ date: "", type: "Solde d'ouverture", ref: "", inflow: R2(a.openingBalance) > 0 ? R2(a.openingBalance) : 0, outflow: R2(a.openingBalance) < 0 ? -R2(a.openingBalance) : 0 }];
  for (const x of mine(db.stockSales, req)) if (x.paymentAccountId === a.id && R2(x.amountPaid) > 0) rows.push({ date: x.date, type: "Encaissement vente", ref: x.ref, inflow: R2(x.amountPaid), outflow: 0 });
  for (const x of mine(db.stockPurchases, req)) if (x.paymentAccountId === a.id && R2(x.amountPaid) > 0) rows.push({ date: x.date, type: "Paiement achat", ref: x.ref, inflow: 0, outflow: R2(x.amountPaid) });
  for (const x of mine(db.stockExpenses, req)) if (x.paymentAccountId === a.id) rows.push({ date: x.date, type: "Dépense", ref: x.ref, inflow: 0, outflow: R2(x.amount) });
  rows.sort((r1, r2) => (r1.date || "").localeCompare(r2.date || ""));
  let bal = 0; for (const r of rows) { bal += r.inflow - r.outflow; r.balance = bal; }
  res.json({ account: { id: a.id, name: a.name, type: a.type }, rows, balance: bal });
});

module.exports = router;
module.exports.seedStock = seedStock;

/* ============================ RAPPORTS ============================ */
function _nameMap(list) { const m = {}; for (const x of list) m[x.id] = x.name; return m; }
function flattenSales(req, f) {
  const prods = {}; for (const p of mine(db.stockProducts, req)) prods[p.id] = p;
  const cats = _nameMap(mine(db.stockCategories, req)), brands = _nameMap(mine(db.stockBrands, req));
  const rows = [];
  for (const s of mine(db.stockSales, req)) {
    if (f.from && (s.date || "") < f.from) continue; if (f.to && (s.date || "") > f.to) continue;
    if (f.customerId && s.customerId !== f.customerId) continue;
    if (f.createdBy && s.createdBy !== f.createdBy) continue;
    for (const l of (s.lines || [])) {
      const p = prods[l.productId] || {};
      if (f.productId && l.productId !== f.productId) continue;
      if (f.categoryId && p.categoryId !== f.categoryId) continue;
      if (f.brandId && p.brandId !== f.brandId) continue;
      if (f.q) { const hay = ((p.name || "") + " " + (p.sku || "") + " " + (p.barcode || "")).toLowerCase(); if (!hay.includes(f.q)) continue; }
      const net = l.net != null ? l.net : Math.round(Q(l.qty) * R2(l.unitCost) * (1 - (Number(l.discountPct) || 0) / 100));
      const tax = Math.round(net * (Number(s.taxPct) || 0) / 100);
      rows.push({ date: s.date, ref: s.ref, docId: s.id, customerId: s.customerId, customerName: cName(req, s.customerId),
        productId: l.productId, productName: p.name || "", sku: p.sku || "", categoryName: cats[p.categoryId] || "", brandName: brands[p.brandId] || "",
        qty: Q(l.qty), pu: R2(l.unitCost), disc: Number(l.discountPct) || 0, net, tax, ttc: net + tax, cost: Math.round(Q(l.qty) * (Number(p.purchasePrice) || 0)),
        createdBy: s.createdBy, channel: s.channel || "vente", paymentStatus: s.paymentStatus, amountPaid: R2(s.amountPaid), total: R2(s.total) });
    }
  }
  return rows;
}
function flattenPurchases(req, f) {
  const prods = {}; for (const p of mine(db.stockProducts, req)) prods[p.id] = p;
  const cats = _nameMap(mine(db.stockCategories, req)), brands = _nameMap(mine(db.stockBrands, req));
  const rows = [];
  for (const s of mine(db.stockPurchases, req)) {
    if (f.from && (s.date || "") < f.from) continue; if (f.to && (s.date || "") > f.to) continue;
    if (f.supplierId && s.supplierId !== f.supplierId) continue;
    for (const l of (s.lines || [])) {
      const p = prods[l.productId] || {};
      if (f.productId && l.productId !== f.productId) continue;
      if (f.categoryId && p.categoryId !== f.categoryId) continue;
      if (f.brandId && p.brandId !== f.brandId) continue;
      if (f.q) { const hay = ((p.name || "") + " " + (p.sku || "") + " " + (p.barcode || "")).toLowerCase(); if (!hay.includes(f.q)) continue; }
      const net = l.net != null ? l.net : Math.round(Q(l.qty) * R2(l.unitCost) * (1 - (Number(l.discountPct) || 0) / 100));
      const tax = Math.round(net * (Number(s.taxPct) || 0) / 100);
      rows.push({ date: s.date, ref: s.ref, docId: s.id, supplierId: s.supplierId, supplierName: cName(req, s.supplierId),
        productId: l.productId, productName: p.name || "", sku: p.sku || "", categoryName: cats[p.categoryId] || "", brandName: brands[p.brandId] || "",
        qty: Q(l.qty), pu: R2(l.unitCost), disc: Number(l.discountPct) || 0, net, tax, ttc: net + tax,
        paymentStatus: s.paymentStatus, amountPaid: R2(s.amountPaid), total: R2(s.total) });
    }
  }
  return rows;
}
const C = (k, l, fmt, align) => ({ k, l, fmt: fmt || "text", align: align || (fmt === "money" || fmt === "qty" || fmt === "pct" ? "r" : "l") });
function groupBy(rows, keyField, nameField, aggs) {
  const g = {};
  for (const r of rows) { const k = r[keyField] || "—"; const o = g[k] || (g[k] = { _name: r[nameField] || k }); for (const a of aggs) o[a] = (o[a] || 0) + (r[a] || 0); }
  return Object.entries(g).map(([k, v]) => Object.assign({ key: k, name: v._name }, v));
}
router.get("/reports", allow("ADM", "CD", "RJ", "GPF"), (req, res) => {
  seedStock(req.user.tenantId || "t1");
  const q = req.query || {};
  const f = { from: q.from || "", to: q.to || "", productId: q.productId || "", categoryId: q.categoryId || "", brandId: q.brandId || "", customerId: q.customerId || "", supplierId: q.supplierId || "", createdBy: q.createdBy || "", q: (q.q || "").toLowerCase().trim() };
  const type = q.type || "product-sales"; const tab = q.tab || "detail";
  const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  let out = { title: "", columns: [], rows: [], totals: {} };

  if (type === "product-sales") {
    const S = flattenSales(req, f);
    if (tab === "grouped") {
      out.title = "Rapport de vente de produit — Groupé";
      out.columns = [C("name", "Produit"), C("sku", "SKU"), C("qty", "Quantité", "qty"), C("net", "Total HT", "money"), C("tax", "Impôt", "money"), C("ttc", "Total TTC", "money"), C("marge", "Marge", "money")];
      const g = {}; for (const r of S) { const o = g[r.productId] || (g[r.productId] = { name: r.productName, sku: r.sku, qty: 0, net: 0, tax: 0, ttc: 0, cost: 0 }); o.qty += r.qty; o.net += r.net; o.tax += r.tax; o.ttc += r.ttc; o.cost += r.cost; }
      out.rows = Object.values(g).map(o => Object.assign(o, { marge: o.net - o.cost }));
    } else if (tab === "category" || tab === "brand") {
      const nf = tab === "category" ? "categoryName" : "brandName";
      out.title = "Rapport de vente de produit — Par " + (tab === "category" ? "catégorie" : "marque");
      out.columns = [C("name", tab === "category" ? "Catégorie" : "Marque"), C("qty", "Quantité", "qty"), C("net", "Total HT", "money"), C("tax", "Impôt", "money"), C("ttc", "Total TTC", "money"), C("marge", "Marge", "money")];
      const g = {}; for (const r of S) { const key = r[nf] || "—"; const o = g[key] || (g[key] = { name: key, qty: 0, net: 0, tax: 0, ttc: 0, cost: 0 }); o.qty += r.qty; o.net += r.net; o.tax += r.tax; o.ttc += r.ttc; o.cost += r.cost; }
      out.rows = Object.values(g).map(o => Object.assign(o, { marge: o.net - o.cost }));
    } else {
      const atCost = tab === "cost";
      out.title = "Rapport de vente de produit — Détaillé" + (atCost ? " (à l'achat)" : "");
      out.columns = [C("productName", "Produit"), C("sku", "SKU"), C("customerName", "Client"), C("ref", "Réf n°"), C("date", "Date"), C("qty", "Quantité", "qty"), C("pu", "Prix unitaire", "money"), C("tax", "Impôt", "money"), C("ttc", "Prix TTC", "money"), atCost ? C("cost", "Coût", "money") : C("net", "Total HT", "money")];
      out.rows = S;
    }
    out.totals = { qty: sum(out.rows, "qty"), net: sum(out.rows, "net"), tax: sum(out.rows, "tax"), ttc: sum(out.rows, "ttc"), marge: sum(out.rows, "marge"), cost: sum(out.rows, "cost") };
  }
  else if (type === "product-purchases") {
    const P = flattenPurchases(req, f);
    if (tab === "grouped") {
      out.title = "Rapport d'achat de produit — Groupé";
      out.columns = [C("name", "Produit"), C("sku", "SKU"), C("qty", "Quantité", "qty"), C("net", "Total HT", "money"), C("tax", "Impôt", "money"), C("ttc", "Total TTC", "money")];
      const g = {}; for (const r of P) { const o = g[r.productId] || (g[r.productId] = { name: r.productName, sku: r.sku, qty: 0, net: 0, tax: 0, ttc: 0 }); o.qty += r.qty; o.net += r.net; o.tax += r.tax; o.ttc += r.ttc; }
      out.rows = Object.values(g);
    } else {
      out.title = "Rapport d'achat de produit — Détaillé";
      out.columns = [C("productName", "Produit"), C("sku", "SKU"), C("supplierName", "Fournisseur"), C("ref", "Réf n°"), C("date", "Date"), C("qty", "Quantité", "qty"), C("pu", "Coût unitaire", "money"), C("tax", "Impôt", "money"), C("ttc", "Total TTC", "money")];
      out.rows = P;
    }
    out.totals = { qty: sum(out.rows, "qty"), net: sum(out.rows, "net"), tax: sum(out.rows, "tax"), ttc: sum(out.rows, "ttc") };
  }
  else if (type === "stock") {
    out.title = "Rapport d'articles / de stock";
    out.columns = [C("name", "Produit"), C("sku", "SKU"), C("categoryName", "Catégorie"), C("brandName", "Marque"), C("qty", "Stock", "qty"), C("purchasePrice", "PU achat", "money"), C("salePrice", "PU vente", "money"), C("value", "Valeur stock", "money")];
    const cats = _nameMap(mine(db.stockCategories, req)), brands = _nameMap(mine(db.stockBrands, req));
    out.rows = mine(db.stockProducts, req).filter(p => (!f.categoryId || p.categoryId === f.categoryId) && (!f.brandId || p.brandId === f.brandId) && (!f.q || ((p.name || "") + " " + (p.sku || "")).toLowerCase().includes(f.q)))
      .map(p => ({ name: p.name, sku: p.sku, categoryName: cats[p.categoryId] || "", brandName: brands[p.brandId] || "", qty: Q(p.qty), purchasePrice: R2(p.purchasePrice), salePrice: R2(p.salePrice), value: Math.round(Q(p.qty) * R2(p.purchasePrice)) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    out.totals = { qty: sum(out.rows, "qty"), value: sum(out.rows, "value") };
  }
  else if (type === "profit-loss") {
    const S = flattenSales(req, f);
    const revenue = sum(S, "net"), cogs = sum(S, "cost"), taxColl = sum(S, "tax");
    out.title = "Rapport Profit / Perte";
    out.columns = [C("label", "Élément"), C("amount", "Montant", "money")];
    out.rows = [{ label: "Ventes (HT)", amount: revenue }, { label: "Coût des marchandises vendues (CMV)", amount: -cogs }, { label: "= Marge brute", amount: revenue - cogs }, { label: "TVA collectée (mémo)", amount: taxColl }];
    out.totals = { amount: revenue - cogs };
  }
  else if (type === "purchase-sale") {
    const S = flattenSales(req, f), P = flattenPurchases(req, f);
    out.title = "Achat & Vente";
    out.columns = [C("label", "Élément"), C("qty", "Quantité", "qty"), C("net", "Total HT", "money"), C("tax", "Impôt", "money"), C("ttc", "Total TTC", "money")];
    out.rows = [
      { label: "Achats", qty: sum(P, "qty"), net: sum(P, "net"), tax: sum(P, "tax"), ttc: sum(P, "ttc") },
      { label: "Ventes", qty: sum(S, "qty"), net: sum(S, "net"), tax: sum(S, "tax"), ttc: sum(S, "ttc") },
      { label: "Marge (ventes − CMV)", qty: 0, net: sum(S, "net") - sum(S, "cost"), tax: 0, ttc: 0 }];
  }
  else if (type === "product-trend") {
    const S = flattenSales(req, f);
    out.title = "Tendance des produits (meilleures ventes)";
    out.columns = [C("name", "Produit"), C("sku", "SKU"), C("qty", "Quantité vendue", "qty"), C("net", "CA HT", "money"), C("marge", "Marge", "money")];
    const g = {}; for (const r of S) { const o = g[r.productId] || (g[r.productId] = { name: r.productName, sku: r.sku, qty: 0, net: 0, cost: 0 }); o.qty += r.qty; o.net += r.net; o.cost += r.cost; }
    out.rows = Object.values(g).map(o => Object.assign(o, { marge: o.net - o.cost })).sort((a, b) => b.qty - a.qty);
    out.totals = { qty: sum(out.rows, "qty"), net: sum(out.rows, "net"), marge: sum(out.rows, "marge") };
  }
  else if (type === "payments-sales" || type === "payments-purchase") {
    const isSale = type === "payments-sales";
    const list = mine(isSale ? db.stockSales : db.stockPurchases, req).filter(d => (!f.from || (d.date || "") >= f.from) && (!f.to || (d.date || "") <= f.to) && (isSale ? (!f.customerId || d.customerId === f.customerId) : (!f.supplierId || d.supplierId === f.supplierId)));
    out.title = isSale ? "Rapport de paiement de vente" : "Rapport de paiement d'achat";
    out.columns = [C("ref", "Réf"), C("date", "Date"), C("party", isSale ? "Client" : "Fournisseur"), C("status", "Statut"), C("total", "Total", "money"), C("paid", "Payé", "money"), C("due", "Dû", "money")];
    out.rows = list.map(d => ({ ref: d.ref, date: d.date, party: cName(req, isSale ? d.customerId : d.supplierId), status: d.paymentStatus, total: R2(d.total), paid: R2(d.amountPaid), due: R2(d.total) - R2(d.amountPaid) })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    out.totals = { total: sum(out.rows, "total"), paid: sum(out.rows, "paid"), due: sum(out.rows, "due") };
  }
  else if (type === "cash") {
    const S = mine(db.stockSales, req).filter(d => (!f.from || (d.date || "") >= f.from) && (!f.to || (d.date || "") <= f.to));
    out.title = "Rapport de caisse (encaissements)";
    out.columns = [C("ref", "Réf"), C("date", "Date"), C("customer", "Client"), C("channel", "Canal"), C("paid", "Encaissé", "money")];
    out.rows = S.filter(d => R2(d.amountPaid) > 0).map(d => ({ ref: d.ref, date: d.date, customer: cName(req, d.customerId), channel: d.channel || "vente", paid: R2(d.amountPaid) })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    out.totals = { paid: sum(out.rows, "paid") };
  }
  else if (type === "adjustments") {
    const prods = {}; for (const p of mine(db.stockProducts, req)) prods[p.id] = p;
    out.title = "Rapport d'ajustement de stock";
    out.columns = [C("date", "Date"), C("productName", "Produit"), C("qty", "Variation", "qty"), C("reason", "Motif"), C("ref", "Réf")];
    out.rows = mine(db.stockMovements, req).filter(m => m.type === "ajustement" && (!f.from || (m.date || "") >= f.from) && (!f.to || (m.date || "") <= f.to) && (!f.productId || m.productId === f.productId))
      .map(m => ({ date: m.date, productName: (prods[m.productId] || {}).name || "", qty: Q(m.qty), reason: m.reason || "", ref: m.ref || "" })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }
  else if (type === "supplier-customer") {
    const P = flattenPurchases(req, f), S = flattenSales(req, f);
    out.title = "Rapport fournisseur & client";
    out.columns = [C("name", "Tiers"), C("role", "Type"), C("qty", "Quantité", "qty"), C("net", "Total HT", "money"), C("paid", "Payé", "money"), C("due", "Dû", "money")];
    const g = {};
    for (const d of mine(db.stockPurchases, req)) { if (f.from && (d.date || "") < f.from) continue; if (f.to && (d.date || "") > f.to) continue; const key = "F:" + d.supplierId; const o = g[key] || (g[key] = { name: cName(req, d.supplierId), role: "Fournisseur", qty: 0, net: 0, paid: 0, due: 0 }); o.net += R2(d.subtotal); o.paid += R2(d.amountPaid); o.due += R2(d.total) - R2(d.amountPaid); }
    for (const d of mine(db.stockSales, req)) { if (f.from && (d.date || "") < f.from) continue; if (f.to && (d.date || "") > f.to) continue; const key = "C:" + d.customerId; const o = g[key] || (g[key] = { name: cName(req, d.customerId), role: "Client", qty: 0, net: 0, paid: 0, due: 0 }); o.net += R2(d.subtotal); o.paid += R2(d.amountPaid); o.due += R2(d.total) - R2(d.amountPaid); }
    for (const r of P) { const key = "F:" + r.supplierId; if (g[key]) g[key].qty += r.qty; }
    for (const r of S) { const key = "C:" + r.customerId; if (g[key]) g[key].qty += r.qty; }
    out.rows = Object.values(g).filter(o => o.name).sort((a, b) => a.role.localeCompare(b.role) || String(a.name).localeCompare(String(b.name)));
    out.totals = { net: sum(out.rows, "net"), paid: sum(out.rows, "paid"), due: sum(out.rows, "due") };
  }
  else if (type === "tax") {
    const S = flattenSales(req, f), P = flattenPurchases(req, f);
    const collected = sum(S, "tax"), deductible = sum(P, "tax");
    out.title = "Rapport d'impôt (TVA)";
    out.columns = [C("label", "Élément"), C("base", "Base HT", "money"), C("tax", "Impôt", "money")];
    out.rows = [{ label: "TVA collectée (ventes)", base: sum(S, "net"), tax: collected }, { label: "TVA déductible (achats)", base: sum(P, "net"), tax: deductible }, { label: "= TVA nette", base: 0, tax: collected - deductible }];
    out.totals = { tax: collected - deductible };
  }
  else if (type === "by-user") {
    const S = flattenSales(req, f); const users = {}; for (const u of (db.users || [])) users[u.id] = u.fullName || u.email;
    out.title = "Rapport du représentant (par utilisateur)";
    out.columns = [C("name", "Utilisateur"), C("qty", "Quantité", "qty"), C("net", "CA HT", "money"), C("ttc", "CA TTC", "money")];
    const g = {}; for (const r of S) { const key = r.createdBy || "—"; const o = g[key] || (g[key] = { name: users[key] || "—", qty: 0, net: 0, ttc: 0 }); o.qty += r.qty; o.net += r.net; o.ttc += r.ttc; }
    out.rows = Object.values(g).sort((a, b) => b.net - a.net);
    out.totals = { qty: sum(out.rows, "qty"), net: sum(out.rows, "net"), ttc: sum(out.rows, "ttc") };
  }
  else if (type === "activity") {
    const prods = {}; for (const p of mine(db.stockProducts, req)) prods[p.id] = p;
    out.title = "Journal d'activité (mouvements de stock)";
    out.columns = [C("date", "Date"), C("type", "Type"), C("productName", "Produit"), C("qty", "Quantité", "qty"), C("ref", "Réf")];
    out.rows = mine(db.stockMovements, req).filter(m => (!f.from || (m.date || "") >= f.from) && (!f.to || (m.date || "") <= f.to) && (!f.productId || m.productId === f.productId))
      .map(m => ({ date: m.date, type: m.type, productName: (prods[m.productId] || {}).name || "", qty: Q(m.qty), ref: m.ref || "" })).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 1000);
  }
  else if (type === "expiry") {
    const today = new Date().toISOString().slice(0, 10);
    const cats = _nameMap(mine(db.stockCategories, req)), brands = _nameMap(mine(db.stockBrands, req));
    out.title = "Rapport d'expiration du stock";
    out.columns = [C("name", "Produit"), C("sku", "SKU"), C("categoryName", "Catégorie"), C("qty", "Stock", "qty"), C("expDate", "Date d'expiration"), C("days", "Jours restants", "qty"), C("status", "Statut")];
    out.rows = mine(db.stockProducts, req).filter(p => p.expDate && (!f.categoryId || p.categoryId === f.categoryId) && (!f.brandId || p.brandId === f.brandId) && (!f.q || ((p.name || "") + " " + (p.sku || "")).toLowerCase().includes(f.q)))
      .map(p => { const d = Math.ceil((new Date(p.expDate) - new Date(today)) / 86400000); return { name: p.name, sku: p.sku, categoryName: cats[p.categoryId] || "", qty: Q(p.qty), expDate: p.expDate, days: d, status: d < 0 ? "Expiré" : d <= 30 ? "Bientôt (≤30j)" : "OK" }; })
      .sort((a, b) => a.days - b.days);
  }
  else if (type === "transfers") {
    out.title = "Rapport de transferts de stock";
    out.columns = [C("ref", "Réf"), C("date", "Date"), C("from", "Lieu (Du)"), C("to", "Lieu (Au)"), C("status", "Statut"), C("total", "Total", "money")];
    out.rows = mine(db.stockTransfers, req).filter(t => (!f.from || (t.date || "") >= f.from) && (!f.to || (t.date || "") <= f.to))
      .map(t => ({ ref: t.ref, date: t.date, from: locName(req, t.fromId), to: locName(req, t.toId), status: ({ en_cours: "En cours", termine: "Terminé", annule: "Annulé" })[t.status] || t.status, total: R2(t.total) }))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    out.totals = { total: sum(out.rows, "total") };
  }
  else if (type === "expenses") {
    const cats = _nameMap(mine(db.stockExpenseCats, req));
    out.title = "Rapport de dépenses";
    out.columns = [C("ref", "Réf"), C("date", "Date"), C("categoryName", "Catégorie"), C("supplierName", "Bénéficiaire"), C("note", "Note"), C("amount", "Montant", "money")];
    out.rows = mine(db.stockExpenses, req).filter(e => (!f.from || (e.date || "") >= f.from) && (!f.to || (e.date || "") <= f.to) && (!f.categoryId || e.categoryId === f.categoryId))
      .map(e => ({ ref: e.ref, date: e.date, categoryName: cats[e.categoryId] || "", supplierName: cName(req, e.supplierId), note: e.note || "", amount: R2(e.amount) }))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    out.totals = { amount: sum(out.rows, "amount") };
  }
  else return res.status(400).json({ error: "Type de rapport inconnu" });
  res.json(out);
});
