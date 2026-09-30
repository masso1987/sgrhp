/*
 * Comptes de démonstration.
 *  - createDemo(opts, actor) : crée un tenant fictif « DÉMO » avec TOUS les modules,
 *    les référentiels de base (comme un nouveau tenant), un portefeuille, et plusieurs
 *    salariés fictifs construits à partir de la structure des dossiers déjà présents
 *    (mêmes champs, détails anonymisés : noms, matricules, salaires, contacts). Toutes
 *    les données de démo portent _demoSeed:true. Le compte a une date d'expiration.
 *  - sweepExpiredDemos() : purge intégralement les tenants démo expirés (données de
 *    départ ET données de test créées par l'utilisateur), leurs utilisateurs et fichiers.
 *  - purgeDemo(tid) : purge immédiate d'un tenant démo.
 *  - isExpiredDemo(user) : utilisé par le login pour bloquer un compte démo expiré.
 */
const fs = require("fs");
const path = require("path");
const { db, save, id } = require("./store");
const { hash } = require("./auth");

const UPLOADS = path.join(__dirname, "..", "uploads");
const ALL_MODULES = ["hr", "careers", "payroll", "accounting", "invoicing", "stock", "quality"];

const FIRST_M = ["Jean", "Paul", "Samuel", "Emmanuel", "Serge", "Blaise", "Aristide", "Cedric", "Landry", "Boris", "Thierry", "Franck"];
const FIRST_F = ["Marie", "Chantal", "Solange", "Nadege", "Estelle", "Bertille", "Larissa", "Carine", "Josiane", "Prisca", "Rachel", "Yolande"];
const LAST = ["Mballa", "Nkeng", "Fotso", "Tchoumi", "Ngono", "Abena", "Etoundi", "Kamdem", "Mbarga", "Ndjock", "Owona", "Bella", "Essomba", "Ngassa", "Djoumessi", "Manga"];
const CITIES = ["Douala", "Yaounde", "Bafoussam", "Garoua", "Bamenda", "Kribi"];
const CLIENTS = ["Cameroon Distribution SARL", "AfriLog Services SA", "Sawa Industries SARL", "Mont Cameroun BTP", "Wouri Negoce SARL", "Adamaoua Agro SA"];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pick(n, i) { return n[i % n.length]; }
function jitter(v, pct) { const n = Number(v); if (!isFinite(n) || !n) return v; const f = 1 + (Math.random() * 2 - 1) * pct; return Math.round(n * f / 100) * 100; }
function phoneCM() { const p = rand(["65", "67", "68", "69", "62"]); let s = p; while (s.length < 9) s += Math.floor(Math.random() * 10); return "6" + s.slice(1); }
function niuDemo() { let d = ""; for (let i = 0; i < 12; i++) d += Math.floor(Math.random() * 10); return "M" + d + "P"; }
function cniDemo() { let d = ""; for (let i = 0; i < 9; i++) d += Math.floor(Math.random() * 10); return d; }

function coll(name) { if (!Array.isArray(db[name])) db[name] = []; return db[name]; }
function tenantList() { return coll("tenants"); }

function templateEmployee(srcTid) {
  const src = (db.employees || []).filter(e => (e.tenantId || "t1") === srcTid);
  if (src.length) return JSON.parse(JSON.stringify(src[0]));
  return {
    firstName: "", lastName: "", gender: "M", matricule: "",
    contract: { type: "CDI", category: "Employe", classification: "", baseSalary: 250000, hireDate: "2022-01-05" },
    email: "", phone: "", cniNumber: "", birthDate: "1990-05-15", birthPlace: "Douala",
    address: "", maritalStatus: "Celibataire", childrenCount: 0, cnps: "",
  };
}

function createDemo(opts, actor) {
  opts = opts || {};
  const srcTid = opts.srcTid || "t1";
  const days = Math.max(1, Math.min(365, Number(opts.days) || 30));
  const nEmp = Math.max(1, Math.min(50, Number(opts.employeeCount) || 8));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const demoId = id("ten");
  const companyName = (opts.companyName && String(opts.companyName).trim()) || "DEMO - " + rand(["Sawa", "Wouri", "Mont Cameroun", "AfriLog", "Adamaoua"]) + " Services SARL";
  const city = rand(CITIES);

  const t = {
    id: demoId, status: "ACTIVE", isDemo: true, demoExpiresAt: expiresAt,
    createdAt: now.toISOString(), createdBy: actor && actor.id,
    name: companyName, acronym: "DEMO", legalForm: "SARL",
    rccm: "RC/" + city.slice(0, 3).toUpperCase() + "/2023/B/" + Math.floor(1000 + Math.random() * 9000),
    niu: niuDemo(), hqCity: city, hqAddress: "BP " + Math.floor(100 + Math.random() * 9000) + ", " + city,
    phone: phoneCM(), email: (opts.adminEmail || "demo") + "@exemple.cm",
    legalRep: rand(FIRST_M) + " " + rand(LAST), legalRepTitle: "Directeur General",
    sector: "Services", shareCapital: "1000000",
    modules: ALL_MODULES.slice(),
  };
  tenantList().push(t);

  try { require("./seed").seedTenantData(demoId); } catch (e) { /* best effort */ }

  let adminEmail = (opts.adminEmail && String(opts.adminEmail).trim()) || "demo@sgrhp.cm";
  if (db.users.find(u => u.email === adminEmail)) adminEmail = "demo+" + demoId.slice(-6) + "@sgrhp.cm";
  const tempPassword = opts.adminPassword || ("Demo" + now.getFullYear() + "!" + Math.floor(100 + Math.random() * 900));
  const admin = {
    id: id("usr"), tenantId: demoId, email: adminEmail, fullName: "Compte Demo",
    role: "ADM", portfolioIds: [], password: hash(tempPassword), active: true, _demoSeed: true, isDemo: true,
  };
  coll("users").push(admin);

  const pf = { id: id("pf"), tenantId: demoId, name: "Portefeuille Demo - " + city, code: "PF-DEMO",
    clientName: rand(CLIENTS), city, manager: t.legalRep,
    required: ["III", "IV", "V", "IX", "X"], requiredCreation: ["V"], _demoSeed: true };
  coll("portfolios").push(pf);

  const tpl = templateEmployee(srcTid);
  const cats = ["Employe", "Agent de maitrise", "Cadre", "Ouvrier"];
  for (let i = 0; i < nEmp; i++) {
    const female = i % 3 === 0;
    const fn = female ? pick(FIRST_F, i) : pick(FIRST_M, i);
    const ln = pick(LAST, i * 3 + 1);
    const e = JSON.parse(JSON.stringify(tpl));
    e.id = id("emp"); e.tenantId = demoId; e._demoSeed = true;
    e.portfolioId = pf.id;
    e.firstName = fn; e.lastName = ln; e.gender = female ? "F" : "M";
    e.matricule = "DEMO-" + String(i + 1).padStart(4, "0");
    e.email = (fn + "." + ln).toLowerCase().replace(/[^a-z.]/g, "") + "@exemple.cm";
    e.phone = phoneCM(); e.cniNumber = cniDemo(); e.cnps = String(Math.floor(1e10 + Math.random() * 8e10));
    e.birthPlace = rand(CITIES); e.address = "Quartier " + rand(["Akwa", "Bonapriso", "Bastos", "Mvog-Ada", "Deido"]) + ", " + city;
    e.contract = e.contract || {};
    e.contract.category = pick(cats, i);
    if (e.contract.baseSalary != null) e.contract.baseSalary = jitter(e.contract.baseSalary || 250000, 25);
    else if (e.salary != null) e.salary = jitter(e.salary, 25);
    e.photo = undefined; e.files = []; e.documents = [];
    coll("employees").push(e);
  }

  save();
  return {
    tenant: { id: t.id, name: t.name, isDemo: true, demoExpiresAt: expiresAt, modules: t.modules },
    admin: { email: adminEmail, tempPassword },
    expiresAt, employees: nEmp,
  };
}

function demoFiles(tid) {
  const names = new Set();
  const scan = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(scan);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string" && /^[\w.\-]+\.(pdf|png|jpe?g|docx?|xlsx?|zip|csv)$/i.test(v) && (k === "storedAs" || k === "generatedFile" || k === "file" || k === "fileName")) names.add(v);
      else if (v && typeof v === "object") scan(v);
    }
  };
  for (const key of Object.keys(db)) {
    if (!Array.isArray(db[key])) continue;
    for (const row of db[key]) if (row && (row.tenantId || "t1") === tid) scan(row);
  }
  return names;
}

function purgeDemo(tid) {
  const t = (db.tenants || []).find(x => x.id === tid);
  if (!t || !t.isDemo) return { ok: false, reason: "not-a-demo" };
  let filesRemoved = 0;
  for (const nm of demoFiles(tid)) {
    try {
      const safe = path.basename(String(nm));
      for (const sub of ["", "generated", "fiches", "decisions", "avi", "smq", "msg", "templates"]) {
        const fp = path.join(UPLOADS, sub, safe);
        if (fp.startsWith(UPLOADS) && fs.existsSync(fp) && fs.statSync(fp).isFile()) { fs.unlinkSync(fp); filesRemoved++; }
      }
    } catch (e) { /* ignore */ }
  }
  let rowsRemoved = 0;
  for (const key of Object.keys(db)) {
    if (key === "tenants" || !Array.isArray(db[key])) continue;
    const before = db[key].length;
    db[key] = db[key].filter(r => (r && (r.tenantId || "t1")) !== tid);
    rowsRemoved += before - db[key].length;
  }
  db.tenants = (db.tenants || []).filter(x => x.id !== tid);
  save();
  return { ok: true, rowsRemoved, filesRemoved };
}

function sweepExpiredDemos() {
  const now = Date.now();
  const expired = (db.tenants || []).filter(t => t.isDemo && t.demoExpiresAt && new Date(t.demoExpiresAt).getTime() < now);
  const results = [];
  for (const t of expired) { try { results.push({ id: t.id, name: t.name, ...purgeDemo(t.id) }); } catch (e) { results.push({ id: t.id, error: e.message }); } }
  if (results.length) try { console.log("[demo] purge expire:", JSON.stringify(results)); } catch (e) {}
  return results;
}

function isExpiredDemo(user) {
  if (!user) return false;
  const t = (db.tenants || []).find(x => x.id === (user.tenantId || "t1"));
  return !!(t && t.isDemo && t.demoExpiresAt && new Date(t.demoExpiresAt).getTime() < Date.now());
}

function extendDemo(tid, days) {
  const t = (db.tenants || []).find(x => x.id === tid);
  if (!t || !t.isDemo) return null;
  const base = t.demoExpiresAt && new Date(t.demoExpiresAt) > new Date() ? new Date(t.demoExpiresAt) : new Date();
  t.demoExpiresAt = new Date(base.getTime() + Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000).toISOString();
  save();
  return t.demoExpiresAt;
}

module.exports = { createDemo, purgeDemo, sweepExpiredDemos, isExpiredDemo, extendDemo, ALL_MODULES };
