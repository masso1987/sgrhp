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
const { hash, passwordPolicy } = require("../auth");

/* Catalogue of platform modules. HR & Careers ship first; others are placeholders. */
const MODULES = [
  { key: "hr", label: "Administration RH", core: true },
  { key: "careers", label: "Carrière & Performance", core: true },
  { key: "payroll", label: "Paie", core: false },
  { key: "accounting", label: "Comptabilité", core: false },
  { key: "invoicing", label: "Facturation", core: false },
  { key: "stock", label: "Gestion de stock", core: false },
  { key: "quality", label: "Qualité (SMQ)", core: false },
];

/* Subscription / licensing (platform monetisation). Prices are in XAF (FCFA) and
 * fully editable in-app by the SADM; these are only initial placeholders. */
const PAYMENT_METHODS = ["MTN Mobile Money", "Orange Money", "Virement bancaire", "Espèces / chèque"];
const DEFAULT_PRICING = {
  hr:         { monthly: 20000, yearly: 200000 },
  careers:    { monthly: 15000, yearly: 150000 },
  payroll:    { monthly: 25000, yearly: 250000 },
  accounting: { monthly: 25000, yearly: 250000 },
  invoicing:  { monthly: 15000, yearly: 150000 },
  stock:      { monthly: 20000, yearly: 200000 },
  quality:    { monthly: 20000, yearly: 200000 },
};
function pricingCfg() {
  const s = db.settings = db.settings || {};
  if (!s.pricing) s.pricing = { currency: "XAF", methods: PAYMENT_METHODS.slice(), modules: {} };
  if (!s.pricing.currency) s.pricing.currency = "XAF";
  if (!Array.isArray(s.pricing.methods) || !s.pricing.methods.length) s.pricing.methods = PAYMENT_METHODS.slice();
  if (!s.pricing.modules) s.pricing.modules = {};
  for (const m of MODULES) if (!s.pricing.modules[m.key]) s.pricing.modules[m.key] = { ...(DEFAULT_PRICING[m.key] || { monthly: 0, yearly: 0 }) };
  return s.pricing;
}
function defaultPrice(key, term) { const p = pricingCfg().modules[key] || {}; return Number(p[term]) || 0; }
function addMonths(d, n) { const x = new Date(d); const day = x.getDate(); x.setMonth(x.getMonth() + n); if (x.getDate() < day) x.setDate(0); return x; }
function licStatus(lic) {
  if (!lic || !lic.endAt) return { state: "none", daysLeft: null };
  const daysLeft = Math.ceil((new Date(lic.endAt).getTime() - Date.now()) / 86400000);
  const state = daysLeft < 0 ? "expired" : (daysLeft <= 30 ? "expiring" : "active");
  return { state, daysLeft, endAt: lic.endAt };
}

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
  tenants().push(t);
  require("../seed").seedTenantData(t.id);   // baseline referentials/conventions/config for the new tenant
  let adminInfo = null;
  if (b.adminEmail && b.adminName) {
    if (!db.users.find(u => u.email === b.adminEmail)) {
      const pw = b.adminPassword || ("Bienvenue" + new Date().getFullYear());
      if (!passwordPolicy(pw)) {
        const u = { id: id("usr"), tenantId: t.id, email: b.adminEmail, fullName: b.adminName,
          role: "ADM", portfolioIds: [], password: hash(pw), active: true };
        db.users.push(u);
        adminInfo = { email: u.email, tempPassword: b.adminPassword ? undefined : pw };
      }
    }
  }
  save();
  audit(req.user, "CREATED", "Tenant", t.id, { name: t.name, niu: t.niu, modules: t.modules, admin: !!adminInfo });
  res.status(201).json({ ...t, admin: adminInfo });
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

/* -------- Platform overview (dashboard) -------- */
router.get("/stats/overview", allow("SADM"), (req, res) => {
  const list = tenants();
  res.json({
    tenants: list.length,
    active: list.filter(t => t.status === "ACTIVE").length,
    suspended: list.filter(t => t.status === "SUSPENDED").length,
    totalUsers: db.users.filter(u => u.role !== "SADM").length,
    totalEmployees: db.employees.length,
    moduleAdoption: MODULES.map(m => ({ key: m.key, label: m.label,
      count: list.filter(t => (t.modules || []).includes(m.key)).length })),
    perTenant: list.map(t => ({ id: t.id, name: t.name, status: t.status,
      users: db.users.filter(u => (u.tenantId || "t1") === t.id && u.role !== "SADM").length,
      employees: db.employees.filter(e => (e.tenantId || "t1") === t.id).length,
      modules: (t.modules || []).length })),
  });
});

/* -------- Provision & manage a tenant's users -------- */
router.get("/:id/users", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  res.json(db.users.filter(u => (u.tenantId || "t1") === t.id)
    .map(({ password, totpSecret, pendingTotp, ...u }) => u));
});

/** Create a user (typically the first administrator) for a tenant. */
router.post("/:id/users", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  const { email, fullName, role = "ADM", password } = req.body || {};
  if (!email || !fullName) return res.status(400).json({ error: "Email et nom complet obligatoires" });
  if (!["GPF", "CD", "RJ", "UI", "ADM"].includes(role)) return res.status(400).json({ error: "Rôle invalide" });
  if (db.users.find(u => u.email === email)) return res.status(409).json({ error: "Cet email existe déjà" });
  const pw = password || ("Bienvenue" + new Date().getFullYear());   // temp password, admin changes it
  const pwErr = passwordPolicy(pw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const u = { id: id("usr"), tenantId: t.id, email, fullName, role, portfolioIds: [],
    password: hash(pw), active: true };
  db.users.push(u); save();
  audit(req.user, "CREATED", "User", u.id, { tenant: t.id, role, provisioned: true });
  res.status(201).json({ id: u.id, email: u.email, fullName: u.fullName, role: u.role,
    tempPassword: password ? undefined : pw });   // returned once so the SADM can hand it over
});

/** Reset a tenant user's password (returns the new temp password once). */
router.post("/:id/users/:uid/reset", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  const u = db.users.find(x => x.id === req.params.uid && (x.tenantId || "t1") === (t && t.id));
  if (!t || !u) return res.status(404).json({ error: "Utilisateur introuvable" });
  const pw = "Reinit" + Math.floor(1000 + Math.random() * 9000) + "Rh";
  u.password = hash(pw); u.failedLogins = 0; u.lockedUntil = null; save();
  audit(req.user, "CONFIG_CHANGED", "User", u.id, { passwordReset: true, tenant: t.id });
  res.json({ tempPassword: pw });
});

/** Enable/disable a tenant user. */
router.put("/:id/users/:uid/status", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  const u = db.users.find(x => x.id === req.params.uid && (x.tenantId || "t1") === (t && t.id));
  if (!t || !u) return res.status(404).json({ error: "Utilisateur introuvable" });
  u.active = !!req.body.active; save();
  audit(req.user, "CONFIG_CHANGED", "User", u.id, { active: u.active, tenant: t.id });
  res.json({ id: u.id, active: u.active });
});

/* -------- Pricing catalogue (editable by SADM) -------- */
router.get("/config/pricing", allow("SADM"), (req, res) => res.json(pricingCfg()));
router.put("/config/pricing", allow("SADM"), (req, res) => {
  const p = pricingCfg(); const b = req.body || {};
  if (b.currency) p.currency = String(b.currency);
  if (Array.isArray(b.methods)) p.methods = b.methods.map(String).filter(Boolean);
  if (b.modules && typeof b.modules === "object") {
    for (const k of Object.keys(b.modules)) if (MODULES.some(m => m.key === k)) {
      const mm = b.modules[k] || {};
      p.modules[k] = {
        monthly: Number(String(mm.monthly != null ? mm.monthly : 0).replace(/\s/g, "")) || 0,
        yearly: Number(String(mm.yearly != null ? mm.yearly : 0).replace(/\s/g, "")) || 0,
      };
    }
  }
  save(); audit(req.user, "CONFIG_CHANGED", "Pricing", "pricing", {});
  res.json(p);
});

/* -------- Per-tenant, per-module licence (activate / renew) -------- */
router.put("/:id/license/:key", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  const key = req.params.key;
  if (!MODULES.some(m => m.key === key)) return res.status(400).json({ error: "Module inconnu" });
  const b = req.body || {};
  const term = b.term === "monthly" ? "monthly" : "yearly";
  const startAt = b.startAt ? new Date(b.startAt).toISOString() : new Date().toISOString();
  const months = Number(b.months) > 0 ? Math.round(Number(b.months)) : (term === "yearly" ? 12 : 1);
  const endAt = addMonths(new Date(startAt), months).toISOString();
  const price = (b.priceXAF !== undefined && b.priceXAF !== "")
    ? (Number(String(b.priceXAF).replace(/\s/g, "")) || 0) : defaultPrice(key, term);
  t.licenses = t.licenses || {};
  const prev = t.licenses[key];
  const history = (prev && Array.isArray(prev.history)) ? prev.history : [];
  if (prev && prev.endAt) history.push({ term: prev.term, startAt: prev.startAt, endAt: prev.endAt,
    priceXAF: prev.priceXAF, method: prev.method, paid: prev.paid, archivedAt: new Date().toISOString(), by: req.user.fullName });
  t.licenses[key] = { term, startAt, endAt, months, priceXAF: price, method: b.method || "",
    paid: !!b.paid, note: b.note || "", updatedAt: new Date().toISOString(), updatedBy: req.user.id, history };
  t.modules = [...new Set([...(t.modules || []), key])];   // licensing implies activation
  save();
  audit(req.user, "CONFIG_CHANGED", "Tenant", t.id, { license: key, term, endAt, priceXAF: price, paid: !!b.paid });
  res.json({ module: key, license: t.licenses[key], modules: t.modules, status: licStatus(t.licenses[key]) });
});

/* Deactivate a module licence (keeps history; core modules can't be removed). */
router.delete("/:id/license/:key", allow("SADM"), (req, res) => {
  const t = tenants().find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant introuvable" });
  const key = req.params.key;
  if (MODULES.find(m => m.key === key && m.core)) return res.status(400).json({ error: "Module de base — non désactivable" });
  t.modules = (t.modules || []).filter(k => k !== key);
  if (t.licenses && t.licenses[key]) { t.licenses[key].cancelledAt = new Date().toISOString(); }
  save();
  audit(req.user, "CONFIG_CHANGED", "Tenant", t.id, { licenseCancelled: key });
  res.json({ id: t.id, modules: t.modules });
});

/* -------- Subscription follow-up (all tenants) -------- */
router.get("/subscriptions/overview", allow("SADM"), (req, res) => {
  const cfg = pricingCfg();
  const rows = []; let mrr = 0, ayr = 0, unpaid = 0;
  const counts = { active: 0, expiring: 0, expired: 0, none: 0 };
  for (const t of tenants()) {
    for (const m of MODULES) {
      if (!(t.modules || []).includes(m.key)) continue;
      const lic = (t.licenses || {})[m.key];
      const st = licStatus(lic);
      counts[st.state] = (counts[st.state] || 0) + 1;
      if (lic) {
        if (lic.term === "monthly") mrr += Number(lic.priceXAF) || 0;
        if (lic.term === "yearly") ayr += Number(lic.priceXAF) || 0;
        if (!lic.paid) unpaid += Number(lic.priceXAF) || 0;
      }
      rows.push({ tenantId: t.id, tenantName: t.name, tenantStatus: t.status,
        module: m.key, moduleLabel: m.label, core: !!m.core,
        term: lic ? lic.term : null, startAt: lic ? lic.startAt : null, endAt: lic ? lic.endAt : null,
        priceXAF: lic ? lic.priceXAF : null, method: lic ? lic.method : null, paid: lic ? !!lic.paid : null,
        state: st.state, daysLeft: st.daysLeft });
    }
  }
  rows.sort((a, b) => (a.daysLeft == null) - (b.daysLeft == null) || (a.daysLeft || 0) - (b.daysLeft || 0));
  res.json({ currency: cfg.currency, methods: cfg.methods, pricing: cfg.modules, counts,
    revenue: { monthlyRecurringXAF: mrr, yearlyContractsXAF: ayr, annualizedXAF: mrr * 12 + ayr, unpaidXAF: unpaid },
    rows });
});

module.exports = { router, MODULES, LEGAL_FORMS };
