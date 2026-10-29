/**
 * Console système (SADM uniquement) - santé de l'application, base de données,
 * services, processus, disque, pare-feu, et outils de réparation.
 *
 * Tout est lu depuis le processus Node lui-même ; les fonctions qui touchent
 * l'hôte sont optionnelles et s'activent seulement si l'accès est donné :
 *  - Docker      : socket monté (/var/run/docker.sock, voir docker-compose.sysops.yml)
 *  - Pare-feu    : /etc/ufw monté en lecture seule sous /host/etc/ufw
 * Sans ces accès, la console l'indique au lieu d'échouer.
 *
 * La console SQL est en LECTURE SEULE par défaut. Le mode écriture exige une
 * confirmation explicite, est journalisé (audit) et peut être coupé par
 * SYSOPS_SQL_WRITE=0.
 */
const router = require("express").Router();
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { execFile } = require("child_process");
const store = require("../store");
const { db, save } = store;
const { allow } = require("../rbac");
const { audit } = require("../audit");

const ROOT = path.join(__dirname, "..", "..");
const DOCKER_SOCK = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const FW_ROOTS = ["/host/etc/ufw", "/etc/ufw"];

/* ------------------------------------------------------------------ */
/* Metrics collected continuously (cheap): requests, event-loop lag,   */
/* CPU, and a heartbeat for each background job.                       */
/* ------------------------------------------------------------------ */
const reqLog = [];          // { t, ms, status } over the last 15 minutes
let loopLag = 0, loopLagMax = 0;
let lastCpu = process.cpuUsage(), lastCpuAt = process.hrtime.bigint(), cpuPct = 0;
const jobs = {};            // name -> { label, every, runs, lastRun, lastMs, lastError, fn }

(function sampler() {
  let expected = Date.now() + 1000;
  const t = setInterval(() => {
    const now = Date.now();
    loopLag = Math.max(0, now - expected);
    loopLagMax = Math.max(loopLagMax * 0.98, loopLag);
    expected = now + 1000;
    const cpu = process.cpuUsage(lastCpu), at = process.hrtime.bigint();
    const wallUs = Number(at - lastCpuAt) / 1000;
    cpuPct = wallUs > 0 ? Math.round(((cpu.user + cpu.system) / wallUs) * 1000) / 10 : 0;
    lastCpu = process.cpuUsage(); lastCpuAt = at;
    const cutoff = now - 15 * 60e3;
    while (reqLog.length && reqLog[0].t < cutoff) reqLog.shift();
  }, 1000);
  t.unref();
})();

/** Express middleware: request count / latency / status for the health panel. */
function metrics(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    if (reqLog.length > 50000) reqLog.shift();
    reqLog.push({ t: Date.now(), ms: Number(process.hrtime.bigint() - start) / 1e6, status: res.statusCode });
  });
  next();
}

/** Register a background job so the console can show its last run and run it on demand. */
function job(name, label, every, fn) {
  jobs[name] = { label, every, runs: 0, lastRun: null, lastMs: null, lastError: null, fn };
  return async () => {
    const j = jobs[name]; const t0 = Date.now();
    try { await fn(); j.lastError = null; }
    catch (e) { j.lastError = e.message; console.error(`[${name}]`, e.message); }
    j.runs++; j.lastRun = new Date().toISOString(); j.lastMs = Date.now() - t0;
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") }));
    } catch (e) { resolve({ ok: false, out: "", err: e.message }); }
  });
}
const pgPool = () => (store.USE_PG ? require("../../db/postgres").pool : null);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
function act(req, action, details) { try { audit(req.user, "CONFIG_CHANGED", "System", action, details || {}); } catch (e) {} try { require("../analytics").capture(req.user.id, "sysops_action", { action }); } catch (e) {} }

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}
function reqStats(windowMin) {
  const from = Date.now() - windowMin * 60e3;
  const r = reqLog.filter(x => x.t >= from);
  const ms = r.map(x => x.ms);
  return { window: windowMin, count: r.length, perMin: Math.round((r.length / windowMin) * 10) / 10,
    errors5xx: r.filter(x => x.status >= 500).length, errors4xx: r.filter(x => x.status >= 400 && x.status < 500).length,
    avgMs: ms.length ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 10) / 10 : 0,
    p95Ms: percentile(ms, 95), maxMs: ms.length ? Math.round(Math.max(...ms)) : 0 };
}

/* ------------------------------------------------------------------ */
/* Disk                                                                */
/* ------------------------------------------------------------------ */
function statfs(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { path: p, total, free, used: total - free, usedPct: pct(total - free, total) };
  } catch (e) { return { path: p, error: e.message }; }
}
function dirSize(dir, budget = { files: 200000 }) {
  let bytes = 0, files = 0, truncated = false;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (files >= budget.files) { truncated = true; return; }
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { bytes += fs.statSync(f).size; files++; } catch (x) {} }
    }
  };
  walk(dir);
  return { bytes, files, truncated };
}
function disks() {
  const cands = [["Système (/)", process.platform === "win32" ? path.parse(ROOT).root : "/"],
    ["Application", ROOT], ["Fichiers (uploads)", path.join(ROOT, "uploads")], ["Données", path.join(ROOT, "data")]];
  if (fs.existsSync("/backups")) cands.push(["Sauvegardes", "/backups"]);
  const seen = new Map(); const out = [];
  for (const [label, p] of cands) {
    if (!fs.existsSync(p)) continue;
    const s = statfs(p);
    const key = s.error ? p : `${s.total}:${s.free}`;
    if (seen.has(key)) { seen.get(key).labels.push(label); continue; }
    const row = Object.assign({ labels: [label] }, s);
    seen.set(key, row); out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Processes                                                           */
/* ------------------------------------------------------------------ */
function readProcLinux() {
  const pageSize = 4096, hz = 100;
  const sysUptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  const rows = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const rp = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, rp);
      const f = stat.slice(rp + 2).split(" ");      // f[0] = state (field 3)
      const ticks = Number(f[11]) + Number(f[12]);   // utime + stime
      const startSec = Number(f[19]) / hz;
      let cmd = ""; try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch (e) {}
      let user = ""; try { const m = /Uid:\s+(\d+)/.exec(fs.readFileSync(`/proc/${d}/status`, "utf8")); user = m ? m[1] : ""; } catch (e) {}
      rows.push({ pid: Number(d), name, state: f[0], ppid: Number(f[1]), threads: Number(f[17]),
        rss: Number(f[21]) * pageSize, ticks, uptimeSec: Math.max(0, Math.round(sysUptime - startSec)),
        user, cmd: cmd.slice(0, 300) });
    } catch (e) { /* process exited */ }
  }
  return { rows, hz };
}
async function processes() {
  if (process.platform === "linux" && fs.existsSync("/proc/self/stat")) {
    const a = readProcLinux();
    await new Promise(r => setTimeout(r, 400));
    const b = readProcLinux();
    const prev = new Map(a.rows.map(r => [r.pid, r.ticks]));
    const rows = b.rows.map(r => Object.assign(r, { cpuPct: Math.round(((r.ticks - (prev.get(r.pid) ?? r.ticks)) / b.hz / 0.4) * 1000) / 10 }));
    rows.forEach(r => delete r.ticks);
    return { source: "procfs", scope: fs.existsSync("/.dockerenv") ? "container" : "host", rows };
  }
  if (process.platform === "win32") {
    const r = await run("tasklist", ["/fo", "csv", "/nh"]);
    const rows = r.out.split(/\r?\n/).filter(Boolean).map(l => {
      const c = l.match(/"([^"]*)"/g) || []; const v = c.map(s => s.slice(1, -1));
      return { pid: Number(v[1]), name: v[0], rss: Number(String(v[4] || "").replace(/[^\d]/g, "")) * 1024, cpuPct: null, cmd: v[0] };
    }).filter(x => x.pid);
    return { source: "tasklist", scope: "host", rows };
  }
  const r = await run("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,comm="]);
  const rows = r.out.split("\n").filter(Boolean).map(l => {
    const m = l.trim().split(/\s+/);
    return { pid: Number(m[0]), ppid: Number(m[1]), cpuPct: Number(m[2]), rss: Number(m[3]) * 1024, elapsed: m[4], name: m.slice(5).join(" "), cmd: m.slice(5).join(" ") };
  });
  return { source: "ps", scope: "host", rows };
}

/* ------------------------------------------------------------------ */
/* Docker Engine API over the unix socket (optional)                   */
/* ------------------------------------------------------------------ */
const dockerAvailable = () => process.platform !== "win32" && fs.existsSync(DOCKER_SOCK);
function dockerRaw(method, p, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path: p, method, timeout,
      headers: { "Content-Type": "application/json", Host: "docker" } }, r => {
      const chunks = []; r.on("data", c => chunks.push(c));
      r.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (r.statusCode >= 400) {
          let msg = buf.toString(); try { msg = JSON.parse(msg).message || msg; } catch (e) {}
          return reject(new Error(`Docker ${r.statusCode}: ${msg}`));
        }
        resolve(buf);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Docker: délai dépassé")));
    req.on("error", e => reject(new Error(e.code === "EACCES" ? "Docker : accès refusé au socket (voir group_add dans docker-compose.sysops.yml)" : "Docker : " + e.message)));
    req.end();
  });
}
async function docker(method, p) { const b = await dockerRaw(method, p); const s = b.toString(); try { return s ? JSON.parse(s) : {}; } catch (e) { return s; } }
/** Docker multiplexes stdout/stderr with 8-byte frame headers when no TTY is attached. */
function demux(buf) {
  if (buf.length < 8 || buf[0] > 2 || buf[1] || buf[2] || buf[3]) return buf.toString("utf8");
  let out = "", i = 0;
  while (i + 8 <= buf.length) { const n = buf.readUInt32BE(i + 4); out += buf.slice(i + 8, i + 8 + n).toString("utf8"); i += 8 + n; }
  return out;
}
let selfProject;
async function composeProject() {
  if (selfProject !== undefined) return selfProject;
  selfProject = null;
  try { const me = await docker("GET", `/containers/${encodeURIComponent(os.hostname())}/json`); selfProject = (me.Config.Labels || {})["com.docker.compose.project"] || null; } catch (e) {}
  return selfProject;
}
async function containers() {
  const list = await docker("GET", "/containers/json?all=1");
  const proj = await composeProject();
  const all = process.env.SYSOPS_DOCKER_ALL === "1";
  return list.filter(c => all || !proj || (c.Labels || {})["com.docker.compose.project"] === proj).map(c => ({
    id: c.Id.slice(0, 12), name: (c.Names[0] || "").replace(/^\//, ""), image: c.Image,
    service: (c.Labels || {})["com.docker.compose.service"] || "", state: c.State, status: c.Status,
    self: c.Id.startsWith(os.hostname()) || (c.Names[0] || "").includes(os.hostname()),
  }));
}
async function containerAllowed(id) {
  const list = await containers();
  return list.find(c => c.id === String(id).slice(0, 12) || c.name === id) || null;
}

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
async function pgPing() {
  const pool = pgPool(); if (!pool) return null;
  const t0 = Date.now(); await pool.query("SELECT 1"); return Date.now() - t0;
}
async function dbHealth() {
  if (!store.USE_PG) {
    const f = path.join(ROOT, "data", "db.json");
    let st = null; try { st = fs.statSync(f); } catch (e) {}
    return { backend: "json", ok: !store.lastError, file: f, size: st ? st.size : 0, modifiedAt: st ? st.mtime : null,
      lastError: store.lastError || null, collections: collectionsInMemory() };
  }
  const pool = pgPool();
  const q = async (sql, params) => { try { return (await pool.query(sql, params)).rows; } catch (e) { return { error: e.message }; } };
  const t0 = Date.now(); let pingMs = null, pingErr = null;
  try { await pool.query("SELECT 1"); pingMs = Date.now() - t0; } catch (e) { pingErr = e.message; }
  if (pingErr) return { backend: "postgres", ok: false, error: pingErr, lastError: store.lastError || null };
  const [info] = await q(`SELECT version() AS version, current_database() AS db, pg_database_size(current_database()) AS size,
    pg_postmaster_start_time() AS started, now() - pg_postmaster_start_time() AS uptime,
    current_setting('max_connections')::int AS max_conn`);
  const conns = await q(`SELECT coalesce(state,'(autre)') AS state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 2 DESC`);
  const [dbs] = await q(`SELECT xact_commit, xact_rollback, deadlocks, temp_files, temp_bytes, conflicts,
    round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit FROM pg_stat_database WHERE datname = current_database()`);
  const longQ = await q(`SELECT pid, usename, state, extract(epoch FROM now() - coalesce(query_start, xact_start))::int AS secs,
    wait_event_type, left(query, 300) AS query FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
    ORDER BY secs DESC NULLS LAST LIMIT 20`);
  const locks = await q(`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`);
  const tables = await q(`SELECT relname AS name, n_live_tup::bigint AS live, n_dead_tup::bigint AS dead,
    pg_total_relation_size(relid) AS size, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 40`);
  const storeColl = await q(`SELECT collection, count(*)::int AS n, sum(pg_column_size(doc))::bigint AS bytes, max(updated_at) AS updated
    FROM store GROUP BY collection ORDER BY bytes DESC`);
  const warnings = [];
  const max = info && info.max_conn, total = Array.isArray(conns) ? conns.reduce((a, c) => a + c.n, 0) : 0;
  if (max && total / max > 0.8) warnings.push(`Connexions élevées : ${total}/${max}`);
  if (dbs && dbs.cache_hit != null && Number(dbs.cache_hit) < 90) warnings.push(`Taux de cache faible : ${dbs.cache_hit} %`);
  if (Array.isArray(longQ) && longQ.some(x => x.secs > 300)) warnings.push("Requête(s) actives depuis plus de 5 minutes");
  if (Array.isArray(conns) && conns.some(c => /idle in transaction/.test(c.state) && c.n > 0)) warnings.push("Session(s) « idle in transaction » - verrous possibles");
  if (Array.isArray(tables)) for (const t of tables) if (t.dead > 10000 && t.dead > t.live * 0.2) warnings.push(`Table ${t.name} : ${t.dead} lignes mortes - VACUUM conseillé`);
  if (locks && locks[0] && locks[0].waiting > 0) warnings.push(`${locks[0].waiting} verrou(s) en attente`);
  if (store.lastError) warnings.push("Dernière écriture en échec : " + store.lastError);
  return { backend: "postgres", ok: !store.lastError && warnings.length === 0, pingMs, info, connections: conns, totalConnections: total,
    stats: dbs, longQueries: longQ, waitingLocks: locks && locks[0] ? locks[0].waiting : 0, tables, store: storeColl,
    persistence: store.persistence || null, lastError: store.lastError || null, warnings };
}
function collectionsInMemory() {
  return Object.keys(db).filter(k => Array.isArray(db[k])).map(k => ({ collection: k, n: db[k].length }))
    .sort((a, b) => b.n - a.n);
}
/** Cheap consistency checks on the in-memory working set (report only). */
function integrity() {
  const issues = [];
  for (const k of Object.keys(db)) {
    if (!Array.isArray(db[k])) continue;
    const seen = new Set(), dup = new Set();
    for (const x of db[k]) { if (!x || typeof x !== "object" || !x.id) continue; if (seen.has(x.id)) dup.add(x.id); seen.add(x.id); }
    if (dup.size) issues.push({ level: "error", where: k, msg: `${dup.size} identifiant(s) en double`, sample: [...dup].slice(0, 5) });
  }
  const tenantIds = new Set((db.tenants || []).map(t => t.id).concat(["t1", "platform"]));
  const orphanUsers = (db.users || []).filter(u => u.role !== "SADM" && !tenantIds.has(u.tenantId || "t1"));
  if (orphanUsers.length) issues.push({ level: "warn", where: "users", msg: `${orphanUsers.length} utilisateur(s) rattaché(s) à une entreprise inexistante`, sample: orphanUsers.slice(0, 5).map(u => u.email) });
  const emails = new Map();
  for (const u of db.users || []) { const e = String(u.email || "").toLowerCase(); if (!e) continue; emails.set(e, (emails.get(e) || 0) + 1); }
  const dupEmails = [...emails].filter(([, n]) => n > 1).map(([e]) => e);
  if (dupEmails.length) issues.push({ level: "warn", where: "users", msg: `${dupEmails.length} email(s) utilisé(s) par plusieurs comptes (casse différente)`, sample: dupEmails.slice(0, 5) });
  const noPw = (db.users || []).filter(u => !u.password);
  if (noPw.length) issues.push({ level: "error", where: "users", msg: `${noPw.length} compte(s) sans mot de passe`, sample: noPw.slice(0, 5).map(u => u.email) });
  const orphanEmp = (db.employees || []).filter(e => !tenantIds.has(e.tenantId || "t1"));
  if (orphanEmp.length) issues.push({ level: "warn", where: "employees", msg: `${orphanEmp.length} employé(s) rattaché(s) à une entreprise inexistante`, sample: orphanEmp.slice(0, 5).map(e => e.id) });
  return { ok: !issues.some(i => i.level === "error"), issues, checkedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Firewall                                                            */
/* ------------------------------------------------------------------ */
function parseUfw(root) {
  const conf = fs.readFileSync(path.join(root, "ufw.conf"), "utf8");
  const enabled = /^\s*ENABLED\s*=\s*yes/mi.test(conf);
  const rules = [];
  for (const f of ["user.rules", "user6.rules"]) {
    let txt = ""; try { txt = fs.readFileSync(path.join(root, f), "utf8"); } catch (e) { continue; }
    for (const l of txt.split("\n")) {
      const m = /^### tuple ### (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)(?: (\S+))?(?: (.*))?/.exec(l.trim());
      if (!m) continue;
      // tuple: action proto dport dst sport src [direction] [comment]
      rules.push({ action: m[1], proto: m[2], port: m[3], to: m[4], from: m[6], direction: m[7] && /^(in|out)/.test(m[7]) ? m[7] : "in", v6: f === "user6.rules" });
    }
  }
  let defaults = {};
  try { const d = fs.readFileSync(path.join(root, "..", "default", "ufw"), "utf8");
    defaults = { input: (/DEFAULT_INPUT_POLICY="(\w+)"/.exec(d) || [])[1], output: (/DEFAULT_OUTPUT_POLICY="(\w+)"/.exec(d) || [])[1] }; } catch (e) {}
  return { tool: "ufw", enabled, rules, defaults };
}
function probePort(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const s = net.connect({ host, port }); let done = false;
    const end = (state) => { if (done) return; done = true; s.destroy(); resolve({ port, state }); };
    s.setTimeout(timeout, () => end("filtré"));
    s.on("connect", () => end("ouvert"));
    s.on("error", e => end(e.code === "ECONNREFUSED" ? "fermé" : "filtré"));
  });
}
async function firewall(req) {
  const out = { platform: process.platform, sources: [], warnings: [] };
  for (const r of FW_ROOTS) {
    if (fs.existsSync(path.join(r, "ufw.conf"))) { try { out.ufw = parseUfw(r); out.sources.push("ufw:" + r); } catch (e) { out.warnings.push("ufw : " + e.message); } break; }
  }
  if (process.platform === "linux") {
    const u = await run("ufw", ["status", "verbose"]); if (u.ok && u.out.trim()) { out.ufwStatus = u.out; out.sources.push("ufw status"); }
    const n = await run("nft", ["list", "ruleset"]); if (n.ok && n.out.trim()) { out.nft = n.out.slice(0, 20000); out.sources.push("nft"); }
    const i = await run("iptables", ["-S"]); if (i.ok && i.out.trim()) { out.iptables = i.out.slice(0, 20000); out.sources.push("iptables"); }
  } else if (process.platform === "win32") {
    const w = await run("netsh", ["advfirewall", "show", "allprofiles", "state"]);
    if (w.ok) {
      out.windows = w.out; out.sources.push("netsh");
      const states = [...w.out.matchAll(/(?:State|État)\s+(ON|OFF|ACTIVÉ|DÉSACTIVÉ)/gi)].map(m => /ON|ACTIV/i.test(m[1]) && !/DÉSACTIV/i.test(m[1]));
      out.windowsEnabled = states.length ? states.every(Boolean) : null;
    }
  }
  const host = String(req.query.host || process.env.SYSOPS_PROBE_HOST || process.env.DOMAIN || req.hostname || "127.0.0.1").replace(/[^a-z0-9.:-]/gi, "");
  const ports = String(req.query.ports || process.env.SYSOPS_PROBE_PORTS || "22,80,443,3000,4000,5432,6379,8080,2375,3306,27017")
    .split(",").map(Number).filter(p => p > 0 && p < 65536).slice(0, 30);
  out.probe = { host, results: await Promise.all(ports.map(p => probePort(host, p))) };
  const exposed = out.probe.results.filter(r => r.state === "ouvert" && [5432, 6379, 2375, 3306, 27017].includes(r.port));
  if (exposed.length) out.warnings.push(`Port(s) sensible(s) joignable(s) sur ${host} : ${exposed.map(r => r.port).join(", ")}`);
  if (out.ufw && !out.ufw.enabled) out.warnings.push("ufw est installé mais désactivé");
  if (!out.sources.length) out.warnings.push("Aucune source pare-feu lisible depuis l'application (montez /etc/ufw en lecture seule : voir docker-compose.sysops.yml). Le test de ports ci-dessous reste disponible.");
  out.enabled = out.ufw ? out.ufw.enabled : (out.windowsEnabled != null ? out.windowsEnabled : (out.nft || out.iptables ? true : null));
  return out;
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */
async function services() {
  const list = [];
  const mem = process.memoryUsage();
  list.push({ key: "app", label: "Application (Node.js)", state: "up", detail: `PID ${process.pid} · ${Math.round(process.uptime() / 60)} min · ${Math.round(mem.rss / 1048576)} Mo`, actions: ["restart"] });
  if (store.USE_PG) {
    try { const ms = await pgPing(); list.push({ key: "database", label: "PostgreSQL", state: store.lastError ? "degraded" : "up", detail: `ping ${ms} ms${store.lastError ? " · dernière écriture en échec" : ""}`, actions: ["reconnect", "resave"] }); }
    catch (e) { list.push({ key: "database", label: "PostgreSQL", state: "down", detail: e.message, actions: ["reconnect"] }); }
  } else list.push({ key: "database", label: "Stockage fichier JSON", state: store.lastError ? "degraded" : "up", detail: "data/db.json", actions: ["resave"] });
  const p = store.persistence;
  if (p) list.push({ key: "persistence", label: "Persistance (auto-contrôle)", state: p.ok ? "up" : "degraded", detail: p.ok ? "toutes les collections persistées" : ((p.warnings || []).length + " collection(s) non persistée(s)"), actions: ["verify"] });
  try { const c = require("../mailer").cfg(); list.push({ key: "mailer", label: "Email (SMTP)", state: c.enabled ? "configured" : "off", detail: c.enabled ? (c.provider + (c.smtp && c.smtp.host ? " · " + c.smtp.host : "")) : "désactivé", actions: c.enabled ? ["test"] : [] }); } catch (e) {}
  try { const s = require("../chat").stats(); list.push({ key: "chat", label: "Messagerie temps réel (WebSocket)", state: s.attached ? "up" : "down", detail: `${s.users} utilisateur(s) · ${s.sockets} connexion(s)`, actions: [] }); } catch (e) {}
  const fcm = !!(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  list.push({ key: "push", label: "Notifications push (Firebase)", state: fcm ? "configured" : "off", detail: fcm ? "compte de service présent" : "non configuré", actions: [] });
  try { const a = require("../analytics"); const c = a.cfg(); list.push({ key: "posthog", label: "Analytics (PostHog)", state: a.active() ? (a.status.lastError ? "degraded" : "up") : "off", detail: a.active() ? `${c.host} · ${a.status.sent} évén. envoyés${a.status.lastError ? " · " + a.status.lastError : ""}` : "désactivé", actions: a.active() ? ["test"] : [] }); } catch (e) {}
  for (const [k, j] of Object.entries(jobs)) {
    const late = j.lastRun && j.every && (Date.now() - new Date(j.lastRun)) > j.every * 2.5;
    list.push({ key: "job:" + k, label: "Tâche : " + j.label, state: j.lastError ? "degraded" : (late ? "late" : (j.lastRun ? "up" : "waiting")),
      detail: j.lastRun ? `dernière exécution ${new Date(j.lastRun).toLocaleString("fr-FR")} (${j.lastMs} ms, ${j.runs}×)${j.lastError ? " · " + j.lastError : ""}` : "pas encore exécutée", actions: ["run"] });
  }
  let docker = { available: dockerAvailable(), containers: [] };
  if (docker.available) { try { docker.containers = await containers(); docker.project = selfProject; } catch (e) { docker.error = e.message; } }
  return { services: list, docker };
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
router.use(allow("SADM"));

router.get("/overview", async (req, res) => {
  const mem = process.memoryUsage();
  const d = disks();
  let dbs = { backend: store.USE_PG ? "postgres" : "json", ok: !store.lastError };
  try { if (store.USE_PG) dbs.pingMs = await pgPing(); } catch (e) { dbs.ok = false; dbs.error = e.message; }
  const worstDisk = d.filter(x => !x.error).sort((a, b) => b.usedPct - a.usedPct)[0];
  res.json({
    at: new Date().toISOString(), build: req.app.locals.build || null,
    app: { uptime: Math.round(process.uptime()), rss: mem.rss, heapUsed: mem.heapUsed, cpuPct, loopLagMs: loopLag, node: process.version },
    host: { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, load: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem(), uptime: Math.round(os.uptime()) },
    db: dbs, disk: worstDisk || null, requests: reqStats(5),
    docker: dockerAvailable(), lastError: store.lastError || null,
  });
});

router.get("/app", (req, res) => {
  const mem = process.memoryUsage();
  let sessions = 0; try { sessions = (db.loginSessions || []).filter(s => !s.endedAt && !s.closedAt).length; } catch (e) {}
  let chat = null; try { chat = require("../chat").stats(); } catch (e) {}
  res.json({
    build: req.app.locals.build || null, node: process.version, pid: process.pid, uptime: Math.round(process.uptime()),
    env: process.env.NODE_ENV || "development", storage: store.USE_PG ? "postgres" : "json",
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers },
    cpuPct, loopLagMs: loopLag, loopLagMaxMs: Math.round(loopLagMax),
    host: { hostname: os.hostname(), platform: `${os.type()} ${os.release()} (${os.arch()})`, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, load: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem(), uptime: Math.round(os.uptime()), container: fs.existsSync("/.dockerenv") },
    requests: { last1: reqStats(1), last5: reqStats(5), last15: reqStats(15) },
    sessions, chat, lastError: store.lastError || null, persistence: store.persistence || null,
    collections: collectionsInMemory().slice(0, 25),
  });
});

router.get("/disk", (req, res) => {
  const out = { volumes: disks(), dirs: [] };
  if (req.query.sizes === "1") {
    for (const [label, p] of [["uploads", path.join(ROOT, "uploads")], ["data", path.join(ROOT, "data")], ["templates", path.join(ROOT, "templates")], ["backups", "/backups"]])
      if (fs.existsSync(p)) out.dirs.push(Object.assign({ label, path: p }, dirSize(p)));
  }
  res.json(out);
});

router.get("/processes", async (req, res) => {
  try {
    const p = await processes();
    p.rows.sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0) || b.rss - a.rss);
    p.self = process.pid;
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/services", async (req, res) => {
  try { res.json(await services()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/services/:key/:action", async (req, res) => {
  const { key, action } = req.params;
  try {
    if (key === "app" && action === "restart") {
      act(req, "app.restart");
      res.json({ ok: true, message: "Redémarrage en cours - la page se reconnectera dans quelques secondes." });
      setTimeout(async () => { try { await save(); } catch (e) {} process.exit(0); }, 800);
      return;
    }
    if (key === "database" && action === "reconnect") {
      if (!store.USE_PG) return res.status(400).json({ error: "Stockage JSON : pas de connexion à réinitialiser" });
      await require("../../db/postgres").reconnect(); store.lastError = null;
      act(req, "db.reconnect"); return res.json({ ok: true, message: "Pool de connexions PostgreSQL recréé" });
    }
    if ((key === "database" && action === "resave") || (key === "persistence" && action === "verify")) {
      store.lastError = null; await save();
      const r = await store.checkPersistence(); store.persistence = Object.assign({ checkedAt: new Date().toISOString() }, r);
      act(req, "db.resave", { ok: r.ok });
      return res.json({ ok: r.ok, message: r.ok ? "Données réécrites et vérifiées" : "Écart de persistance : " + (r.warnings || [r.error]).join("; "), result: r });
    }
    if (key === "mailer" && action === "test") { await require("../mailer").verify(); return res.json({ ok: true, message: "Connexion SMTP réussie" }); }
    if (key === "posthog" && action === "test") { await require("../analytics").test(req.user.id); return res.json({ ok: true, message: "Événement de test accepté par PostHog" }); }
    if (key.startsWith("job:") && action === "run") {
      const j = jobs[key.slice(4)]; if (!j) return res.status(404).json({ error: "Tâche inconnue" });
      const t0 = Date.now();
      try { await j.fn(); j.lastError = null; } catch (e) { j.lastError = e.message; }
      j.runs++; j.lastRun = new Date().toISOString(); j.lastMs = Date.now() - t0;
      act(req, "job.run", { job: key });
      return res.json({ ok: !j.lastError, message: j.lastError ? "Échec : " + j.lastError : `Exécutée en ${j.lastMs} ms` });
    }
    res.status(400).json({ error: "Action inconnue" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Docker containers ---- */
router.post("/docker/:id/:action", async (req, res) => {
  if (!dockerAvailable()) return res.status(400).json({ error: "Socket Docker non monté" });
  const { action } = req.params;
  if (!["restart", "start", "stop"].includes(action)) return res.status(400).json({ error: "Action invalide" });
  try {
    const c = await containerAllowed(req.params.id);
    if (!c) return res.status(404).json({ error: "Conteneur introuvable ou hors du projet" });
    if (c.self && action === "stop") return res.status(400).json({ error: "Impossible d'arrêter le conteneur de l'application depuis elle-même" });
    act(req, "docker." + action, { container: c.name });
    if (c.self) {
      res.json({ ok: true, message: "Redémarrage du conteneur de l'application…" });
      setTimeout(() => { dockerRaw("POST", `/containers/${c.id}/restart?t=10`).catch(() => {}); }, 500);
      return;
    }
    await dockerRaw("POST", `/containers/${c.id}/${action}${action === "stop" || action === "restart" ? "?t=15" : ""}`, 60000);
    res.json({ ok: true, message: `${c.name} : ${action} effectué` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/docker/:id/logs", async (req, res) => {
  if (!dockerAvailable()) return res.status(400).json({ error: "Socket Docker non monté" });
  try {
    const c = await containerAllowed(req.params.id);
    if (!c) return res.status(404).json({ error: "Conteneur introuvable" });
    const tail = Math.min(2000, Number(req.query.tail) || 300);
    const buf = await dockerRaw("GET", `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
    res.json({ name: c.name, logs: demux(buf) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/docker/:id/stats", async (req, res) => {
  if (!dockerAvailable()) return res.status(400).json({ error: "Socket Docker non monté" });
  try {
    const c = await containerAllowed(req.params.id);
    if (!c) return res.status(404).json({ error: "Conteneur introuvable" });
    const s = await docker("GET", `/containers/${c.id}/stats?stream=false`);
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sysDelta = (s.cpu_stats.system_cpu_usage || 0) - (s.precpu_stats.system_cpu_usage || 0);
    const ncpu = s.cpu_stats.online_cpus || 1;
    let top = null; try { top = await docker("GET", `/containers/${c.id}/top?ps_args=aux`); } catch (e) {}
    res.json({ name: c.name, cpuPct: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * ncpu * 1000) / 10 : 0,
      mem: s.memory_stats.usage, memLimit: s.memory_stats.limit, pids: (s.pids_stats || {}).current, top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Database ---- */
router.get("/db/health", async (req, res) => {
  try { res.json(await dbHealth()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/db/integrity", (req, res) => res.json(integrity()));

router.get("/db/tables", async (req, res) => {
  if (!store.USE_PG) return res.json({ backend: "json", tables: collectionsInMemory().map(c => ({ name: c.collection, rows: c.n })) });
  try {
    const { rows } = await pgPool().query(`SELECT c.relname AS name, n.nspname AS schema, c.reltuples::bigint AS rows,
      pg_total_relation_size(c.oid) AS size FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname, c.relname`);
    res.json({ backend: "postgres", tables: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/db/table/:name", async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50)), offset = Math.max(0, Number(req.query.offset) || 0);
  if (!store.USE_PG) {
    const arr = db[req.params.name]; if (!Array.isArray(arr)) return res.status(404).json({ error: "Collection inconnue" });
    return res.json({ total: arr.length, rows: arr.slice(offset, offset + limit).map(maskDoc) });
  }
  try {
    const pool = pgPool();
    const schema = req.query.schema || "public";
    const { rows: ok } = await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=$1 AND n.nspname=$2`, [req.params.name, schema]);
    if (!ok.length) return res.status(404).json({ error: "Table inconnue" });
    const fq = ident(schema) + "." + ident(req.params.name);
    const cols = (await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, req.params.name])).rows;
    let where = "", params = [];
    if (req.params.name === "store" && req.query.collection) { where = " WHERE collection = $1"; params = [req.query.collection]; }
    const total = (await pool.query(`SELECT count(*)::bigint AS n FROM ${fq}${where}`, params)).rows[0].n;
    const order = cols.some(c => c.column_name === "updated_at") ? " ORDER BY updated_at DESC" : "";
    const { rows } = await pool.query(`SELECT * FROM ${fq}${where}${order} LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ total: Number(total), columns: cols, rows: rows.map(r => (r.doc ? Object.assign({}, r, { doc: maskDoc(r.doc) }) : r)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const SECRET_KEYS = /^(password|totpSecret|pendingTotp|confirmToken|refresh|token|secretAccessKey|accountKey|connectionString|privateKey|smtpPass|smtpPassword|apiKey)$/i;
function maskDoc(d) {
  if (!d || typeof d !== "object") return d;
  if (Array.isArray(d)) return d.map(maskDoc);
  const o = {};
  for (const [k, v] of Object.entries(d)) o[k] = SECRET_KEYS.test(k) && v ? "••••••" : (v && typeof v === "object" ? maskDoc(v) : v);
  return o;
}

/** SQL console. Read-only unless write=true + confirm="EXECUTER". One statement per run. */
router.post("/db/query", async (req, res) => {
  if (!store.USE_PG) return res.status(400).json({ error: "Console SQL disponible uniquement avec PostgreSQL" });
  const b = req.body || {};
  let sql = String(b.sql || "").trim().replace(/;\s*$/, "");
  if (!sql) return res.status(400).json({ error: "Requête vide" });
  if (sql.length > 20000) return res.status(400).json({ error: "Requête trop longue" });
  if (sql.includes(";")) return res.status(400).json({ error: "Une seule instruction à la fois (retirez les « ; » intermédiaires)" });
  const write = !!b.write;
  if (write) {
    if (process.env.SYSOPS_SQL_WRITE === "0") return res.status(403).json({ error: "Mode écriture désactivé sur ce serveur (SYSOPS_SQL_WRITE=0)" });
    if (b.confirm !== "EXECUTER") return res.status(400).json({ error: "Confirmation requise : saisissez EXECUTER" });
  } else if (/^\s*(begin|commit|rollback|end|abort|start|set|reset|vacuum|reindex|cluster|checkpoint|copy|lock|listen|notify|prepare|deallocate|discard|load|do|call)\b/i.test(sql)) {
    return res.status(400).json({ error: "Instruction non autorisée en lecture seule - activez le mode écriture si nécessaire" });
  }
  const client = await pgPool().connect();
  const t0 = Date.now();
  try {
    await client.query(write ? "BEGIN" : "BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${write ? 60000 : 15000}'`);
    const r = await client.query({ text: sql, rowMode: "array" });
    await client.query(write ? "COMMIT" : "ROLLBACK");
    const max = 1000;
    const fields = (r.fields || []).map(f => f.name);
    const rows = (r.rows || []).slice(0, max).map(row => row.map((v, i) => (SECRET_KEYS.test(fields[i]) && v ? "••••••" : (v && typeof v === "object" && !(v instanceof Date) ? maskDoc(v) : v))));
    if (write) act(req, "db.sql_write", { sql: sql.slice(0, 2000), rowCount: r.rowCount });
    res.json({ command: r.command, rowCount: r.rowCount, fields, rows, truncated: (r.rows || []).length > max, ms: Date.now() - t0,
      note: write && /\bstore\b/i.test(sql) ? "Attention : la table « store » est réécrite depuis la mémoire à chaque enregistrement. Utilisez « Recharger depuis la base » pour que l'application prenne en compte cette modification." : undefined });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (x) {}
    res.status(400).json({ error: e.message, position: e.position, ms: Date.now() - t0 });
  } finally { client.release(); }
});

/** Maintenance / repair actions. */
router.post("/db/repair/:action", async (req, res) => {
  const a = req.params.action;
  try {
    if (a === "integrity") return res.json(Object.assign({ message: "Contrôle terminé" }, integrity()));
    if (a === "resave") {
      store.lastError = null; await save();
      const r = await store.checkPersistence(); store.persistence = Object.assign({ checkedAt: new Date().toISOString() }, r);
      act(req, "db.resave"); return res.json({ ok: r.ok, message: r.ok ? "Données réécrites et vérifiées" : "Écart : " + (r.warnings || [r.error]).join("; ") });
    }
    if (!store.USE_PG) return res.status(400).json({ error: "Action disponible uniquement avec PostgreSQL" });
    const pool = pgPool();
    const t0 = Date.now();
    if (a === "vacuum") { await pool.query("VACUUM (ANALYZE)"); act(req, "db.vacuum"); return res.json({ ok: true, message: `VACUUM ANALYZE terminé (${Date.now() - t0} ms)` }); }
    if (a === "analyze") { await pool.query("ANALYZE"); act(req, "db.analyze"); return res.json({ ok: true, message: `ANALYZE terminé (${Date.now() - t0} ms)` }); }
    if (a === "reindex") { await pool.query("REINDEX TABLE store"); act(req, "db.reindex"); return res.json({ ok: true, message: `Index de la table store reconstruits (${Date.now() - t0} ms)` }); }
    if (a === "kill-idle") {
      const mins = Math.max(1, Number((req.body || {}).minutes) || 5);
      const { rows } = await pool.query(`SELECT pid, pg_terminate_backend(pid) AS ok FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'
        AND now() - state_change > make_interval(mins => $1)`, [mins]);
      act(req, "db.kill_idle", { count: rows.length }); return res.json({ ok: true, message: `${rows.length} session(s) bloquée(s) terminée(s)` });
    }
    if (a === "cancel" || a === "terminate") {
      const pid = Number((req.body || {}).pid); if (!pid) return res.status(400).json({ error: "PID requis" });
      const fn = a === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend";
      const { rows } = await pool.query(`SELECT ${fn}($1) AS ok FROM pg_stat_activity WHERE pid = $1 AND datname = current_database() AND pid <> pg_backend_pid()`, [pid]);
      act(req, "db." + a, { pid }); return res.json({ ok: !!(rows[0] && rows[0].ok), message: rows[0] && rows[0].ok ? `Processus ${pid} : ${a === "cancel" ? "requête annulée" : "session terminée"}` : "Processus introuvable" });
    }
    if (a === "reconnect") { await require("../../db/postgres").reconnect(); store.lastError = null; act(req, "db.reconnect"); return res.json({ ok: true, message: "Pool de connexions recréé" }); }
    if (a === "reload") {
      if ((req.body || {}).confirm !== "RECHARGER") return res.status(400).json({ error: "Confirmation requise : saisissez RECHARGER" });
      await save();                                   // flush pending writes first
      const n = await require("../../db/postgres").load(db);
      act(req, "db.reload", { rows: n });
      return res.json({ ok: true, message: `${n} enregistrements rechargés depuis PostgreSQL` });
    }
    res.status(400).json({ error: "Action inconnue" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- Firewall ---- */
router.get("/firewall", async (req, res) => {
  try { res.json(await firewall(req)); } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- PostHog settings ---- */
router.get("/posthog", (req, res) => {
  const a = require("../analytics");
  const c = a.cfg();
  res.json(Object.assign({}, c, { status: a.status, active: a.active() }));
});
router.put("/posthog", (req, res) => {
  try {
    const c = require("../analytics").save(req.body || {});
    save(); act(req, "posthog.config", { enabled: c.enabled, host: c.host });
    res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { router, metrics, job };
