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

let db = { users: [], portfolios: [], docTypes: [], employees: [], files: [], documents: [], notifications: [], audit: [], seq: 1 };
if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, "utf8"));
for (const k of ["users","portfolios","docTypes","employees","files","documents","notifications","audit","templates","referentials","decisions","contractTypes","salaryElements","salaryGrid","fichesPoste","rawTemplates","conventions","careerPlans","careerPaths","okrs","evaluations360","checkins","interviews","successionPlans"])
  if (!db[k]) db[k] = [];

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
}
const id = (p) => `${p}_${(db.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;

module.exports = { db, save, id };
