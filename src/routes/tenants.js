/**
 * Platform layer — tenant provisioning (multi-tenant SaaS).
 * Only the platform super-administrator (SADM) manages tenants: create a client
 * company with its full legal profile + logo, toggle licensed modules, suspend.
 * Tenant data isolation is by tenant_id (shared database).
 *
 * Company fields follow Cameroon/OHADA registration (RCCM, NIU, CNPS employer,
 * share capital, registered office, legal representative).
 */
const router = require("express").Router();
const { db, save, id } = require("../store");
const { allow } = require("../rbac");
const { audit } = require("../audit");

/* Catalogue of platform modules. HR & Careers ship first; others are placeholders. */
const MODULES = [
  { key: "hr", label: "Administration RH", core: true },
  { key: "careers", label: "Carrière & Performance", core: true },
  { key: "payroll", label: "Paie", core: false },
  { key: "accounting", label: "Comptabilité", core: false },
  { key: "invoicing", label: "Facturation", core: false },
  { key: "stock", label: "Gestion de stock", core: false },
];

const LEGAL_FORMS = ["SARL", "SA", "SAS", "SNC", "SCS", "GIE", "EI", "Établissement", "Association", "Coopérative"];
const NIU_RE = /^[A-Z]\d{12}[A-Z]$/i;               // e.g. M10300015976N (14 chars)

function tenants() { if (!db.tenants) db.tenants = []; return db.tenants; }
function publicView(t) { return t; }

router.get("/modules", allow("SADM"), (req, res) => res.json(MODULES));
router.get("/legal-forms", allow("SADM"), (req, res) => res.json(LEGAL_FORMS));

router.get("/", allow("SADM"), (req, res) => {
  res.json(tenants().map(t => ({ ...t,
    employees: db.employees.filter(e => e.tenantId === t.id).length,
    users: db.users.filter(u => u.tenantId === t.id).length })));
});

router.get("/:id", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  res.json(t);
});

function validate(b, { partial } = {}) {
  const req = ["name", "legalForm", "rccm", "niu", "hqCity", "legalRep", "email"];
  if (!partial) for (const f of req) if (!b[f] || !String(b[f]).trim()) return `Champ obligatoire manquant : ${f}`;
  if (b.legalForm && !LEGAL_FORMS.includes(b.legalForm)) return `Forme juridique inconnue : ${b.legalForm}`;
  if (b.niu && !NIU_RE.test(b.niu)) return "NIU invalide (format attendu : 1 lettre + 12 chiffres + 1 lettre, ex. M10300015976N)";
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return "Email invalide";
  if (b.shareCapital !== undefined && b.shareCapital !== "" && !(Number(String(b.shareCapital).replace(/\s/g, "")) >= 0))
    return "Capital social invalide";
  if (b.logo && !/^data:image\/(png|jpeg|svg\+xml);base64,/.test(b.logo) && b.logo.length)
    return "Logo invalide (image PNG/JPEG/SVG en data-URL)";
  if (b.logo && b.logo.length > 300000) return "Logo trop volumineux (max ~200 Ko)";
  return null;
}

function apply(t, b) {
  const fields = ["name", "acronym", "legalForm", "rccm", "niu", "cnpsEmployer", "shareCapital",
    "sector", "hqAddress", "hqCity", "bp", "phone", "email", "legalRep", "legalRepTitle", "logo", "website"];
  for (const f of fields) if (b[f] !== undefined) t[f] = b[f];
}

router.post("/", allow("SADM"), (req, res) => {
  const b = req.body || {};
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });
  if (tenants().find(x => x.niu && x.niu.toUpperCase() === String(b.niu).toUpperCase()))
    return res.status(409).json({ error: "Un tenant avec ce NIU existe déjà" });
  const t = { id: id("ten"), status: "ACTIVE", createdAt: new Date().toISOString(), createdBy: req.user.id,
    modules: MODULES.filter(m => m.core).map(m => m.key),   // HR + Careers on by default
    legalRepTitle: b.legalRepTitle || "Directeur Général" };
  apply(t, b);
  // enabled modules from the form (core stay on)
  if (Array.isArray(b.modules)) t.modules = [...new Set([...MODULES.filter(m => m.core).map(m => m.key),
    ...b.modules.filter(k => MODULES.some(m => m.key === k))])];
  tenants().push(t); save();
  audit(req.user, "CREATED", "Tenant", t.id, { name: t.name, niu: t.niu, modules: t.modules });
  res.status(201).json(t);
});

router.put("/:id", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  const err = validate(req.body || {}, { partial: true });
  if (err) return res.status(400).json({ error: err });
  const before = { ...t };
  apply(t, req.body || {});
  save();
  audit(req.user, "UPDATED", "Tenant", t.id, { name: t.name });
  res.json(t);
});

router.put("/:id/modules", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  const keys = (req.body?.modules || []).filter(k => MODULES.some(m => m.key === k));
  // core modules cannot be switched off
  t.modules = [...new Set([...MODULES.filter(m => m.core).map(m => m.key), ...keys])];
  save();
  audit(req.user, "CONFIG_CHANGED", "Tenant", t.id, { modules: t.modules });
  res.json({ id: t.id, modules: t.modules });
});

router.put("/:id/status", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  const st = req.body?.status;
  if (!["ACTIVE", "SUSPENDED"].includes(st)) return res.status(400).json({ error: "Statut invalide" });
  t.status = st; save();
  audit(req.user, "CONFIG_CHANGED", "Tenant", t.id, { status: st });
  res.json({ id: t.id, status: st });
});

module.exports = { router, MODULES, LEGAL_FORMS };
