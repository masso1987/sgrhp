const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { login, authenticate } = require("./auth");
const { seed } = require("./seed");

const { initStorage } = require("./store");
const app = express();
app.disable("x-powered-by");
// Behind Apache/Caddy/App Service: use X-Forwarded-For so rate limits and audit
// logs key on the real client, not on the proxy's address.
app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));
// Content-Security-Policy tuned to the SPA (inline handlers/styles + cdnjs libs).
// 'unsafe-inline' is required by the ~670 inline onclick handlers; it can be dropped
// later by moving inline JS to files. object-src/base-uri/frame-ancestors are locked down.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
// Disable powerful browser features the app does not use.
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  next();
});
app.use(express.json({ limit: "30mb" }));

// Brute-force protection on authentication (§8.2)
const LOGIN_MAX = process.env.LOGIN_LIMIT === undefined ? 10 : Number(process.env.LOGIN_LIMIT);
const loginLimiter = LOGIN_MAX > 0
  ? rateLimit({ windowMs: 15 * 60 * 1000, max: LOGIN_MAX, standardHeaders: true, legacyHeaders: false,
      message: { error: "Trop de tentatives de connexion — réessayez dans quelques minutes" } })
  : (req, res, next) => next();
// RATE_LIMIT_PER_MIN=0 disables throttling (used by the automated test suite)
const RPM = process.env.RATE_LIMIT_PER_MIN === undefined ? 300 : Number(process.env.RATE_LIMIT_PER_MIN);
const apiLimiter = RPM > 0
  ? rateLimit({ windowMs: 60 * 1000, max: RPM, standardHeaders: true, legacyHeaders: false,
      message: { error: "Trop de requêtes — patientez un instant" } })
  : (req, res, next) => next();
// Serve the SPA HTML with no-cache so nav/feature updates always load.
app.use((req, res, next) => { if (req.path === "/" || req.path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); next(); });
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/login", loginLimiter, login);
app.post("/api/forgot-password", loginLimiter, require("./auth").forgotPassword);
app.post("/api/2fa/setup", loginLimiter, require("./auth").totpSetup);
app.post("/api/2fa/confirm", loginLimiter, require("./auth").totpConfirm);

// Health endpoint for load balancers / uptime monitoring
// Public branding — no auth, so the login screen reflects the tenant's identity
app.get("/api/confirm", (req, res) => {
  const r = require("./auth").confirmAccount(req.query.token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const page = (title, msg, ok) => `<!doctype html><html lang=fr><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:Inter,system-ui,sans-serif;background:#f5f8f7;margin:0;padding:48px 16px"><div style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;text-align:center"><h1 style="color:${ok ? "#065f46" : "#b91c1c"};font-size:20px;margin:0 0 8px">${title}</h1><p style="color:#374151">${msg}</p><a href="/" style="display:inline-block;margin-top:14px;background:#065f46;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px">Aller à la connexion</a></div></body></html>`;
  if (r && r.user) return res.send(page("Compte confirmé", "Votre compte est activé. Vous pouvez maintenant vous connecter.", true));
  if (r && r.expired) return res.status(400).send(page("Lien expiré", "Ce lien de confirmation a expiré. Contactez votre administrateur pour recréer le compte.", false));
  return res.status(400).send(page("Lien invalide", "Ce lien de confirmation est invalide ou déjà utilisé.", false));
});
app.get("/api/legal", (req, res) => {
  const s = require("./routes/settings").settings();
  res.json((s && s.legal) || {});
});
app.get("/api/branding", (req, res) => {
  const s = require("./routes/settings").settings();
  res.json(s.branding);
});

// Public payslip authenticity check (scanned from the QR on the bulletin) — no auth.
app.get("/verify/:id", (req, res) => {
  const { db } = require("./store");
  const payroll = require("./routes/payroll");
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const s = (db.payslips || []).find(x => x.id === req.params.id);
  const tenant = s && (db.tenants || []).find(t => t.id === (s.tenantId || "t1"));
  const valid = s && payroll.payslipSig && payroll.payslipSig(s) === req.query.h;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const wrap = (inner) => `<!doctype html><html lang=fr><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Verification du bulletin</title></head><body style="font-family:system-ui,-apple-system,sans-serif;background:#f5f8f7;margin:0;padding:40px 16px"><div style="max-width:520px;margin:0 auto">${inner}<p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:18px">Verification SGRHP</p></div></body></html>`;
  if (!valid) return res.send(wrap(`<div style="border:2px solid #dc2626;border-radius:12px;padding:24px;background:#fff"><h1 style="color:#b91c1c;margin:0 0 8px">Bulletin non authentifie</h1><p style="color:#374151">Ce document n'a pas pu etre verifie. Il a peut-etre ete modifie ou ne provient pas de ce systeme.</p></div>`));
  const tot = s.result.totals;
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#6b7280">${k}</td><td style="padding:6px 0;text-align:right"><b>${v}</b></td></tr>`;
  res.send(wrap(`<div style="border:2px solid #10b981;border-radius:12px;padding:24px;background:#fff"><h1 style="color:#065f46;margin:0 0 8px">Bulletin authentique</h1><p style="color:#374151;margin:0 0 12px">Emis par <b>${esc(tenant ? tenant.name : "")}</b> via le systeme RH &amp; Paie (SGRHP).</p><table style="width:100%;border-top:1px solid #e5e7eb;font-size:15px">${row("Salarie", esc(s.employeeName))}${row("Matricule", esc(s.matricule || "-"))}${row("Periode", esc(s.period))}${row("Net a payer", Math.round(tot.netAPayer).toLocaleString("fr-FR") + " XAF")}${row("Reference", esc(String(s.id).toUpperCase()))}</table></div>`));
});

// ---- Formulaires d'evaluation publics (client / salarie) — sans authentification ----
const evalLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de requetes." } });
function evalEsc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
app.get("/eval/:token", (req, res) => {
  const smq = require("./routes/smq");
  const { db } = require("./store");
  const settings = require("./routes/settings").settings();
  const f = smq.publicEvalByToken && smq.publicEvalByToken(req.params.token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const tenant = f && (db.tenants || []).find(t => t.id === (f.tenantId || "t1"));
  const brandName = (tenant && tenant.name) || (settings.branding && settings.branding.appName) || "SGRHP";
  const shell = (inner) => `<!doctype html><html lang=fr><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content="noindex"><title>${evalEsc(f ? f.title : "Evaluation")}</title><style>body{font-family:Inter,system-ui,sans-serif;background:#f5f8f7;margin:0;padding:32px 14px;color:#111827}.card{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:26px}h1{font-size:20px;margin:0 0 6px}.sub{color:#6b7280;font-size:14px;margin:0 0 16px}label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}input,textarea{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d1d5db;border-radius:9px;font-size:14px;font-family:inherit}.rate{display:flex;gap:6px;flex-wrap:wrap}.rate button{flex:0 0 auto;width:42px;height:42px;border:1px solid #d1d5db;border-radius:9px;background:#fff;font-size:15px;cursor:pointer}.rate button.on{background:#065f46;color:#fff;border-color:#065f46}.q{border-top:1px solid #f0f0f0;padding-top:6px;margin-top:6px}.send{margin-top:18px;background:#065f46;color:#fff;border:0;padding:11px 20px;border-radius:9px;font-size:15px;cursor:pointer;width:100%}.foot{text-align:center;color:#9ca3af;font-size:12px;margin-top:16px}</style></head><body><div class=card>${inner}</div><p class=foot>${evalEsc(brandName)} — Systeme de management de la qualite</p></body></html>`;
  if (!f) return res.status(404).send(shell(`<h1>Formulaire indisponible</h1><p class=sub>Ce lien d'evaluation est invalide ou a ete cloture.</p>`));
  const max = Number(f.scaleMax) || 5;
  const qs = (f.questions || []).map(q => {
    if (q.kind === "rating") {
      const btns = Array.from({ length: max }, (_, i) => `<button type=button data-q="${q.id}" data-v="${i + 1}" onclick="pick(this)">${i + 1}</button>`).join("");
      return `<div class=q><label>${evalEsc(q.label)}</label><div class=rate data-for="${q.id}">${btns}</div><input type=hidden name="a_${q.id}" id="a_${q.id}"></div>`;
    }
    return `<div class=q><label>${evalEsc(q.label)}</label><textarea rows=3 id="a_${q.id}" name="a_${q.id}"></textarea></div>`;
  }).join("");
  const inner = `<h1>${evalEsc(f.title)}</h1><p class=sub>${evalEsc(f.intro || (f.type === "client" ? "Votre avis nous aide a ameliorer nos services. Merci de prendre quelques minutes." : "Votre retour est important. Ce questionnaire est anonyme si vous le souhaitez."))}</p>
    <div id=err style="display:none;color:#b91c1c;font-size:14px;margin-bottom:8px"></div>
    <div id=ok style="display:none;text-align:center;padding:20px 0"><h1 style="color:#065f46">Merci !</h1><p class=sub>Votre reponse a bien ete enregistree.</p></div>
    <form id=frm>
      <label>Votre nom ${f.type === "client" ? "/ entreprise" : "(optionnel)"}</label><input id=rname>
      <label>Email (optionnel)</label><input id=remail type=email>
      ${f.type === "client" ? '<label>Prestation / contrat concerne (optionnel)</label><input id=rtarget>' : '<label>Site / poste (optionnel)</label><input id=rtarget>'}
      ${qs}
      <button type=button class=send onclick="send(this)">Envoyer mon evaluation</button>
    </form>
    <script>
      var A={};
      function pick(b){var q=b.getAttribute("data-q"),v=b.getAttribute("data-v");A[q]=Number(v);document.getElementById("a_"+q).value=v;var box=document.querySelector('.rate[data-for="'+q+'"]');Array.prototype.forEach.call(box.children,function(x){x.classList.toggle("on",Number(x.getAttribute("data-v"))<=Number(v));});}
      function send(btn){btn.disabled=true;var ans={};${JSON.stringify((f.questions || []).map(q => ({ id: q.id, kind: q.kind })))}.forEach(function(q){var el=document.getElementById("a_"+q.id);if(el&&el.value!=="")ans[q.id]=q.kind==="rating"?Number(el.value):el.value;});
        var body={respondentName:(document.getElementById("rname")||{}).value,respondentEmail:(document.getElementById("remail")||{}).value,targetName:(document.getElementById("rtarget")||{}).value,answers:ans};
        fetch("/api/eval/${evalEsc(f.token)}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){if(x.ok){document.getElementById("frm").style.display="none";document.getElementById("ok").style.display="block";}else{btn.disabled=false;var e=document.getElementById("err");e.textContent=x.j.error||"Erreur";e.style.display="block";}}).catch(function(){btn.disabled=false;var e=document.getElementById("err");e.textContent="Erreur reseau";e.style.display="block";});}
    </script>`;
  res.send(shell(inner));
});
app.post("/api/eval/:token", evalLimiter, express.json({ limit: "1mb" }), (req, res) => {
  const smq = require("./routes/smq");
  const r = smq.publicEvalSubmit ? smq.publicEvalSubmit(req.params.token, req.body) : { error: "Indisponible", code: 500 };
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  const store = require("./store");
  res.json({ status: store.lastError ? "degraded" : "ok",
    storage: store.USE_PG ? "postgres" : "json",
    error: store.lastError || undefined, uptime: Math.round(process.uptime()) });
});

app.use("/api", apiLimiter);
app.use("/api", authenticate);
app.get("/api/me", require("./auth").me);
app.post("/api/me/password", require("./auth").changePassword);
app.post("/api/me/2fa/disable", require("./auth").totpDisable);
app.use("/api/employees", require("./routes/employees"));
app.use("/api/portfolios", require("./routes/portfolios"));
app.use("/api/audit", require("./routes/audit"));
app.use("/api/users", require("./routes/users"));
app.use("/api/documents", require("./routes/documents"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/templates", require("./routes/templates"));
app.use("/api/referentials", require("./routes/referentials"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/hr", require("./routes/hr").router);
app.use("/api/employees", require("./routes/export"));
app.use("/api/ficheprix", require("./routes/ficheprix"));
app.use("/api/config", require("./routes/contractConfig"));
app.use("/api/fiches", require("./routes/fiches"));
app.use("/api/career", require("./routes/career"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/settings", require("./routes/settings").router);
app.use("/api/ga", require("./routes/ga"));
app.use("/api/tenants", require("./routes/tenants").router);
app.use("/api/data", require("./routes/dataio"));
// Module activation guard: a licensed module must be enabled by the platform
// super-administrator (SADM) on the tenant before its admins can use it.
const requireModule = (key) => (req, res, next) => {
  const { db } = require("./store");
  const u = req.user || {};
  const t = (db.tenants || []).find(x => x.id === (u.tenantId || "t1"));
  const mods = (t && t.modules) || [];
  if (!mods.includes(key))
    return res.status(403).json({ error: `Module « ${key} » non activé pour votre organisation — contactez le super-administrateur.` });
  if (u.role !== "ADM" && u.role !== "SADM") {
    const dbu = (db.users || []).find(x => x.id === u.id);
    if (!(((dbu && dbu.modules) || []).includes(key)))
      return res.status(403).json({ error: `Accès au module « ${key} » non accordé — contactez votre administrateur.` });
  }
  next();
};
app.use("/api/payroll", requireModule("payroll"), require("./routes/payroll"));
app.use("/api/billing", requireModule("invoicing"), require("./routes/billing"));
app.use("/api/accounting", requireModule("accounting"), require("./routes/accounting"));
app.use("/api/stock", requireModule("stock"), require("./routes/stock"));
app.use("/api/smq", requireModule("quality"), require("./routes/smq"));
app.use("/api/messages", require("./routes/messages"));

// SLA timer scan every minute (§5.4)
setInterval(() => { try { require("./workflow").slaScan(); } catch (e) { console.error(e); } }, 60e3);
// Rappels d'échéance (documents/CNI/contrats) : une fois par jour + peu après le démarrage.
setInterval(() => { try { require("./expiry").scanAndRemind(); } catch (e) { console.error(e); } }, 24 * 60 * 60 * 1000);
setTimeout(() => { try { require("./expiry").scanAndRemind(); } catch (e) {} }, 30000);

// 404 — JSON for the API, custom page for everything else.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Ressource introuvable" });
  if (req.method === "GET" && req.accepts("html"))
    return res.status(404).sendFile(path.join(__dirname, "..", "public", "404.html"));
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 4000;

(async () => {
  const info = await initStorage();
  seed();
  require("./routes/settings").settings();   // materialise defaults
  require("./seed").ensureReferentials();
  require("./templateEngine").syncSeedTemplates();
  const http = require("http");
  const server = http.createServer(app);
  try { require("./chat").attach(server); } catch (e) { console.warn("[chat] non attaché:", e.message); }
  server.listen(PORT, () =>
    console.log(`SGRHP running on http://localhost:${PORT} — storage: ${info.backend} — chat WS /ws`));
})().catch(e => {
  console.error("\n=== SGRHP startup failed ===");
  console.error("Reason :", e.message);
  console.error("Storage:", process.env.DATABASE_URL ? "postgres" : "json file");
  if (e.code) console.error("Code   :", e.code);
  console.error(e.stack);
  console.error("Check DATABASE_URL / JWT_SECRET in .env, then: docker compose up -d --build");
  console.error("============================\n");
  process.exit(1);
});
