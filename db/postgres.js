/**
 * PostgreSQL persistence adapter (M7).
 *
 * Design note — the application keeps its working set in memory and persists on
 * every mutation. This adapter swaps the JSON file for PostgreSQL: at boot it
 * loads the tenant's data, and each save() writes the changed collections back
 * inside a transaction. That keeps every route unchanged while giving durable,
 * backed-up, ACID storage and a proper relational schema for BI/reporting.
 *
 * Suitable for the scale in the cahier des charges (a few thousand employees).
 * Per-entity SQL queries can be introduced route by route later without
 * touching the storage contract.
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TENANT = process.env.TENANT_ID || "t1";

// collection -> { table, columns } ; JSONB "doc" column keeps shape parity with the JSON store
const COLLECTIONS = {
  tenants: "tenants",
  users: "users", portfolios: "portfolios", conventions: "conventions",
  employees: "employees", files: "doc_files", documents: "documents",
  decisions: "decisions", referentials: "referentials", contractTypes: "contract_types",
  salaryElements: "salary_elements", templates: "templates", rawTemplates: "raw_templates",
  fichesPoste: "fiches_poste", careerPaths: "career_paths", careerPlans: "career_plans",
  okrs: "okrs", evaluations360: "evaluations_360", checkins: "checkins",
  interviews: "interviews", successionPlans: "succession_plans",
  notifications: "notifications", audit: "audit_log", docTypes: "doc_types",
  salaryGrid: "salary_grid",
  payrollConfig: "payroll_config", payRubriques: "pay_rubriques",
  bulletinModels: "bulletin_models", payRuns: "pay_runs", payslips: "payslips",
  payElements: "pay_elements", payCumuls: "pay_cumuls",
};

let pool;

async function init() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PGPOOL_MAX || 10),
  });

  // The database may still be accepting connections when the app boots.
  const attempts = Number(process.env.DB_CONNECT_RETRIES || 10);
  for (let i = 1; i <= attempts; i++) {
    try { await pool.query("SELECT 1"); break; }
    catch (e) {
      if (i === attempts) throw new Error(`Cannot reach PostgreSQL after ${attempts} attempts: ${e.message}`);
      console.log(`[store] PostgreSQL not ready (${e.code || e.message}), retry ${i}/${attempts}…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Schema is idempotent; run statement by statement so a single failure is identifiable.
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  try { await pool.query(sql); }
  catch (e) { throw new Error(`schema.sql failed: ${e.message}`); }
  // Mirror table: one row per document of each collection, keyed by id.
  // NB: multi-statement SQL cannot carry bind parameters — keep DDL and the
  // parameterised INSERT in separate queries.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      tenant_id  TEXT NOT NULL,
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      doc        JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, collection, id)
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS store_lookup ON store (tenant_id, collection)");
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [TENANT, "Cible RH Emploi S.A."]);
  return true;
}

/** Load every collection into the in-memory db object. */
async function load(db) {
  const { rows } = await pool.query(
    "SELECT collection, doc FROM store WHERE tenant_id = $1 ORDER BY updated_at", [TENANT]);
  for (const key of Object.keys(COLLECTIONS)) db[key] = [];
  let seq = 1;
  for (const r of rows) {
    if (r.collection === "_meta") { seq = r.doc.seq || 1; continue; }
    if (r.collection === "settings") { db.settings = r.doc; continue; }
    (db[r.collection] = db[r.collection] || []).push(r.doc);
  }
  db.seq = seq;
  return rows.length;
}

/** Persist the full working set transactionally (upsert + prune deletions). */
async function save(db) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const key of Object.keys(COLLECTIONS)) {
      const items = Array.isArray(db[key]) ? db[key] : [];
      const ids = [];
      for (const item of items) {
        const id = item.id || item.key || item.code || item.category || JSON.stringify(item).slice(0, 60);
        ids.push(id);
        await client.query(
          `INSERT INTO store (tenant_id, collection, id, doc, updated_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (tenant_id, collection, id)
           DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
          [TENANT, key, String(id), item]);
      }
      // remove rows deleted in memory (audit_log is never pruned)
      if (key !== "audit")
        await client.query(
          `DELETE FROM store WHERE tenant_id=$1 AND collection=$2 AND NOT (id = ANY($3::text[]))`,
          [TENANT, key, ids.map(String)]);
    }
    await client.query(
      `INSERT INTO store (tenant_id, collection, id, doc, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (tenant_id, collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [TENANT, "_meta", "seq", { seq: db.seq }]);
    if (db.settings && typeof db.settings === "object") {
      await client.query(
        `INSERT INTO store (tenant_id, collection, id, doc, updated_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (tenant_id, collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
        [TENANT, "settings", "_singleton", db.settings]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function close() { if (pool) await pool.end(); }

module.exports = { init, load, save, close, TENANT, get pool() { return pool; } };
