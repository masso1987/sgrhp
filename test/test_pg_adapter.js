/**
 * PostgreSQL adapter checks without a live database.
 * A stub `pg` client records every query so we can assert protocol-level rules
 * that only surface at runtime — notably: a parameterised query may contain
 * only ONE statement ("cannot insert multiple commands into a prepared statement").
 */
const Module = require("module");
const path = require("path");

const queries = [];
let storeRows = [];

const fakePool = {
  query: async (text, params) => {
    queries.push({ text: String(text), params });
    const t = String(text).trim().toUpperCase();
    // emulate PostgreSQL's extended-protocol restriction
    const statements = String(text).replace(/\$\$[\s\S]*?\$\$/g, "").split(";").filter(s => s.trim()).length;
    if (params && params.length && statements > 1)
      throw new Error("cannot insert multiple commands into a prepared statement");
    if (t.startsWith("SELECT COLLECTION")) return { rows: storeRows };
    if (t.startsWith("INSERT INTO STORE")) {
      const [tenant, collection, id, doc] = params;
      storeRows = storeRows.filter(r => !(r.collection === collection && r.id === id));
      storeRows.push({ collection, id, doc });
      return { rows: [] };
    }
    if (t.startsWith("DELETE FROM STORE")) {
      const [, collection, ids] = params;
      storeRows = storeRows.filter(r => r.collection !== collection || ids.includes(r.id));
      return { rows: [] };
    }
    return { rows: [] };
  },
  connect: async () => ({ query: fakePool.query, release: () => {} }),
  end: async () => {},
};

// inject the stub in place of the real pg driver
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "pg") return "pg-stub";
  return origResolve.call(this, request, ...rest);
};
require.cache["pg-stub"] = { id: "pg-stub", filename: "pg-stub", loaded: true,
  exports: { Pool: function () { return fakePool; } } };

process.env.DATABASE_URL = "postgres://stub";
const pg = require("../db/postgres");

let pass = 0, fail = 0;
const chk = (cond, label) => { if (cond) { pass++; console.log("PASS: " + label); }
  else { fail++; console.log("FAIL: " + label); } };

(async () => {
  await pg.init();
  chk(true, "init() completes without protocol errors");

  const paramMulti = queries.filter(q => q.params && q.params.length &&
    q.text.replace(/\$\$[\s\S]*?\$\$/g, "").split(";").filter(s => s.trim()).length > 1);
  chk(paramMulti.length === 0, "no parameterised query contains multiple statements");

  const ddl = queries.find(q => q.text.includes("CREATE TABLE IF NOT EXISTS store"));
  chk(ddl && (!ddl.params || !ddl.params.length), "store DDL runs without bind parameters");
  chk(queries.some(q => q.text.includes("INSERT INTO tenants") && q.params?.length === 2),
    "tenant insert is parameterised on its own");
  chk(queries.some(q => q.text.includes("CREATE TABLE IF NOT EXISTS users")),
    "schema.sql applied at startup");

  // round-trip a working set
  const db = { users: [{ id: "u1", email: "a@b.ci" }], employees: [{ id: "e1", firstName: "Karim" }],
    audit: [{ id: "l1", action: "LOGIN" }], referentials: [{ key: "categories", values: ["B2"] }],
    salaryGrid: [{ category: "B2", baseSalary: 95000 }], seq: 42 };
  await pg.save(db);
  const loaded = {};
  await pg.load(loaded);
  chk(loaded.users.length === 1 && loaded.users[0].email === "a@b.ci", "users round-trip through the store");
  chk(loaded.employees[0].firstName === "Karim", "employees round-trip");
  chk(loaded.referentials[0].key === "categories", "referentials keyed by 'key' round-trip");
  chk(loaded.salaryGrid[0].category === "B2", "salary grid keyed by 'category' round-trip");
  chk(loaded.seq === 42, "sequence counter persisted");

  // deletions are pruned, audit is never pruned
  db.users = [];
  db.audit.push({ id: "l2", action: "LOGOUT" });
  await pg.save(db);
  const after = {};
  await pg.load(after);
  chk(after.users.length === 0, "deleted rows are pruned");
  chk(after.audit.length === 2, "audit log is append-only (never pruned)");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL: unexpected error — " + e.message); process.exit(1); });
