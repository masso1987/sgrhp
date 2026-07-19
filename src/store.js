/**
 * Dev data store (JSON file, atomic writes). Repository-style API so it can be
 * swapped for Prisma/PostgreSQL in M7 without touching routes/services.
 */
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DIR, "db.json");
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, "..", "uploads"), { recursive: true });

let db = { tenants: [], users: [], portfolios: [], docTypes: [], employees: [], files: [], documents: [], notifications: [], audit: [], seq: 1 };
if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, "utf8"));
for (const k of ["tenants","users","portfolios","docTypes","employees","files","documents","notifications","audit","templates","referentials","decisions","contractTypes","salaryElements","salaryGrid","fichesPoste","rawTemplates","conventions","careerPlans","careerPaths","okrs","evaluations360","checkins","interviews","successionPlans"])
  if (!db[k]) db[k] = [];

/* Storage backend: PostgreSQL when DATABASE_URL is set, JSON file otherwise (dev). */
const USE_PG = !!process.env.DATABASE_URL;
let pg = null, saveQueue = Promise.resolve();

function save() {
  if (USE_PG) {
    // serialise writes; failures are logged and surfaced by the health endpoint
    saveQueue = saveQueue.then(() => pg.save(db)).catch(e => {
      console.error("[store] PostgreSQL write failed:", e.message);
      module.exports.lastError = e.message;
    });
    return saveQueue;
  }
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
}

/** Called once at boot when using PostgreSQL. */
async function initStorage() {
  if (!USE_PG) return { backend: "json", file: FILE };
  pg = require("../db/postgres");
  await pg.init();
  const n = await pg.load(db);
  for (const k of ["tenants","users","portfolios","docTypes","employees","files","documents","notifications",
    "audit","templates","referentials","decisions","contractTypes","salaryElements","salaryGrid",
    "fichesPoste","rawTemplates","conventions","careerPlans","careerPaths","okrs","evaluations360",
    "checkins","interviews","successionPlans"]) if (!db[k]) db[k] = [];
  if (!db.seq) db.seq = 1;
  return { backend: "postgres", rows: n };
}
const id = (p) => `${p}_${(db.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;

/* Multi-tenant helpers. Legacy rows without a tenantId belong to the founding tenant "t1". */
function tenantId(req) { return (req && req.user && req.user.tenantId) || "t1"; }
function mine(list, req) { const tid = tenantId(req); return (list || []).filter(x => (x.tenantId || "t1") === tid); }
function stamp(obj, req) { obj.tenantId = tenantId(req); return obj; }

module.exports = { db, save, id, initStorage, USE_PG, lastError: null, tenantId, mine, stamp };
