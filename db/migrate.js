#!/usr/bin/env node
/**
 * Migrate the JSON development store into PostgreSQL.
 * Usage: DATABASE_URL=postgres://... node db/migrate.js [path/to/db.json]
 */
const fs = require("fs");
const path = require("path");
const pg = require("./postgres");

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const file = process.argv[2] || path.join(__dirname, "..", "data", "db.json");
  if (!fs.existsSync(file)) {
    console.error(`No JSON store found at ${file}. Nothing to migrate.`);
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log("Connecting to PostgreSQL…");
  await pg.init();
  const counts = Object.entries(db)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}: ${v.length}`);
  console.log("Migrating —", counts.join(", "));
  await pg.save(db);
  const check = {};
  await pg.load(check);
  console.log(`Done. Employees: ${check.employees.length}, documents: ${check.documents.length}, audit: ${check.audit.length}`);
  await pg.close();
})().catch(e => { console.error("Migration failed:", e.message); process.exit(1); });
