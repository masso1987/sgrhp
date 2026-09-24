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
for (const k of ["tenants","users","portfolios","docTypes","employees","files","documents","notifications","audit","templates","referentials","decisions","contractTypes","salaryElements","salaryGrid","fichesPoste","rawTemplates","conventions","careerPlans","careerPaths","okrs","evaluations360","checkins","interviews","successionPlans","payrollConfig","payRubriques","bulletinModels","payRuns","payslips","payElements","payCumuls","payLoans","billingContracts","billingComponents","billingSheets","billingAnnexeTemplates","billingInvoiceModels","billingInvoices","billingLineFields","acctAccounts","acctJournals","acctTaxes","acctThirdParties","acctEntries","acctExercises","acctBudgets","acctBankLines","acctBankMatches","acctRubriqueMap","stockProducts","stockCategories","stockUnits","stockSuppliers","stockContacts","stockBrands","stockWarranties","stockPriceGroups","stockVariations","stockPOs","stockPurchases","stockReturns","stockSOs","stockSales","stockQuotes","stockSalesReturns","stockLocations","stockTransfers","stockExpenseCats","stockExpenses","stockPaymentAccounts","stockMovements","smqAxes","smqProcesses","smqIndicators","smqMeasures","smqDocTypes","smqDocuments","smqDocRevisions","smqStakeholders","smqScope","smqClauses","smqPolicy","smqImprovements","smqEvents","smqConfig","smqAudits","smqAuditItems","smqRisks","smqSatisfaction","smqClaims","smqCompetences","smqSupplierEvals","smqEquipment","smqReviews","smqConformity","smqTdb","smqTdbData","stockNotifTemplates","dmMessages","fichesPrix","epiIssues","smqVeille","smqHabilitations","smqEvalForms","smqEvalResponses","gaModels","loginSessions","payElementSheets","payAcomptes","empAccounts","empSessions","sites","siteAssignments","attendance","empDevices","leaveRequests","bordereauFields"])
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
    "checkins","interviews","successionPlans","payrollConfig","payRubriques","bulletinModels","payRuns","payslips","payElements","payCumuls","payLoans","billingContracts","billingComponents","billingSheets","billingAnnexeTemplates","billingInvoiceModels","billingInvoices","billingLineFields","acctAccounts","acctJournals","acctTaxes","acctThirdParties","acctEntries","acctExercises","acctBudgets","acctBankLines","acctBankMatches","acctRubriqueMap","stockProducts","stockCategories","stockUnits","stockSuppliers","stockContacts","stockBrands","stockWarranties","stockPriceGroups","stockVariations","stockPOs","stockPurchases","stockReturns","stockSOs","stockSales","stockQuotes","stockSalesReturns","stockLocations","stockTransfers","stockExpenseCats","stockExpenses","stockPaymentAccounts","stockMovements","smqAxes","smqProcesses","smqIndicators","smqMeasures","smqDocTypes","smqDocuments","smqDocRevisions","smqStakeholders","smqScope","smqClauses","smqPolicy","smqImprovements","smqEvents","smqConfig","smqAudits","smqAuditItems","smqRisks","smqSatisfaction","smqClaims","smqCompetences","smqSupplierEvals","smqEquipment","smqReviews","smqConformity","smqTdb","smqTdbData","stockNotifTemplates","dmMessages","fichesPrix","epiIssues","smqVeille","smqHabilitations","smqEvalForms","smqEvalResponses","gaModels","payElementSheets","payAcomptes","empAccounts","empSessions","sites","siteAssignments","attendance","empDevices","leaveRequests","bordereauFields"]) if (!db[k]) db[k] = [];
  if (!db.seq) db.seq = 1;
  // Self-check de persistance : on écrit l'état courant puis on vérifie que chaque collection
  // « round-trip » bien vers PostgreSQL. Un écart est journalisé fort (tripwire anti-perte).
  try {
    await pg.save(db);
    const chk = await pg.verifyPersistence(db);
    module.exports.persistence = { ok: chk.ok, warnings: chk.warnings, checkedAt: new Date().toISOString() };
    if (chk.ok) console.log(`[store] persistance OK — ${chk.checked} collections vérifiées vers PostgreSQL`);
    else console.error(`[store] \u26A0 PERSISTANCE INCOMPLÈTE — ${chk.warnings.length} collection(s) NON persistée(s): ${chk.warnings.join("; ")}`);
  } catch (e) { console.error("[store] self-check persistance échoué:", e.message); module.exports.persistence = { ok: false, error: e.message }; }
  return { backend: "postgres", rows: n };
}
/** Vérifie à la demande que toutes les collections en mémoire sont bien persistées. */
async function checkPersistence() {
  if (!USE_PG) return { backend: "json", ok: true, note: "Stockage fichier JSON : tout l'état est sérialisé à chaque écriture." };
  try { await pg.save(db); const chk = await pg.verifyPersistence(db); return { backend: "postgres", ...chk }; }
  catch (e) { return { backend: "postgres", ok: false, error: e.message }; }
}
const id = (p) => `${p}_${(db.seq++).toString(36)}${Date.now().toString(36).slice(-4)}`;

/* Multi-tenant helpers. Legacy rows without a tenantId belong to the founding tenant "t1". */
function tenantId(req) { return (req && req.user && req.user.tenantId) || "t1"; }
function mine(list, req) { const tid = tenantId(req); return (list || []).filter(x => (x.tenantId || "t1") === tid); }
function stamp(obj, req) { obj.tenantId = tenantId(req); return obj; }

module.exports = { db, save, id, initStorage, USE_PG, lastError: null, tenantId, mine, stamp , checkPersistence };
