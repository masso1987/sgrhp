/**
 * Referential settings (§3 — Éléments de base).
 * Each referential is a named list of values, optionally linked to a template
 * placeholder tag: the generation form then offers its values as a dropdown.
 * Examples: conventions collectives -> {{collective_agreement}},
 * categories -> {{contract_category}}, positions -> {{contract_position}}.
 */
const router = require("express").Router();
const { db, save, id, mine, stamp, tenantId } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

router.get("/", allow("GPF", "CD", "RJ", "ADM", "UI"), (req, res) => res.json(mine(db.referentials, req)));

// ADM creates a new referential list (optionally linked to a template tag)
router.post("/", allow("ADM"), (req, res) => {
  const { key, label, tag } = req.body || {};
  if (!key || !label) return res.status(400).json({ error: "key and label required" });
  if (mine(db.referentials, req).find(r => r.key === key)) return res.status(409).json({ error: "Key exists" });
  const r = stamp({ id: id("ref"), key, label, tag: tag || null, values: [], system: false }, req);
  db.referentials.push(r); save();
  audit(req.user, "CONFIG_CHANGED", "Referential", key, { created: label, tag });
  res.status(201).json(r);
});

// ADM replaces the value list (add/remove) — audited with before/after
router.put("/:key", allow("ADM"), (req, res) => {
  const r = mine(db.referentials, req).find(x => x.key === req.params.key);
  if (!r) return res.status(404).json({ error: "Not found" });
  const values = (req.body?.values || []).map(v => String(v).trim()).filter(Boolean);
  if (!values.length) return res.status(400).json({ error: "At least one value required" });
  const before = r.values;
  r.values = [...new Set(values)];
  if (req.body.tag !== undefined) r.tag = req.body.tag || null;
  save();
  audit(req.user, "CONFIG_CHANGED", "Referential", r.key, { before, after: r.values });
  res.json(r);
});

router.delete("/:key", allow("ADM"), (req, res) => {
  const r = mine(db.referentials, req).find(x => x.key === req.params.key);
  if (!r) return res.status(404).json({ error: "Not found" });
  if (r.system) return res.status(400).json({ error: "System referentials cannot be deleted" });
  db.referentials = db.referentials.filter(x => !(x.key === req.params.key && (x.tenantId||"t1") === tenantId(req))); save();
  audit(req.user, "CONFIG_CHANGED", "Referential", r.key, { deleted: true });
  res.json({ ok: true });
});

module.exports = router;
