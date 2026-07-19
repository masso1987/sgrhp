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
app.use(helmet({ contentSecurityPolicy: false }));   // CSP tuned per deployment
app.use(express.json({ limit: "1mb" }));

// Brute-force protection on authentication (§8.2)
const LOGIN_MAX = process.env.LOGIN_LIMIT === undefined ? 20 : Number(process.env.LOGIN_LIMIT);
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
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/login", loginLimiter, login);
app.post("/api/2fa/setup", loginLimiter, require("./auth").totpSetup);
app.post("/api/2fa/confirm", loginLimiter, require("./auth").totpConfirm);

// Health endpoint for load balancers / uptime monitoring
// Public branding — no auth, so the login screen reflects the tenant's identity
app.get("/api/branding", (req, res) => {
  const s = require("./routes/settings").settings();
  res.json(s.branding);
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
app.use("/api/config", require("./routes/contractConfig"));
app.use("/api/fiches", require("./routes/fiches"));
app.use("/api/career", require("./routes/career"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/settings", require("./routes/settings").router);
app.use("/api/tenants", require("./routes/tenants").router);
app.use("/api/data", require("./routes/dataio"));

// SLA timer scan every minute (§5.4)
setInterval(() => { try { require("./workflow").slaScan(); } catch (e) { console.error(e); } }, 60e3);

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
  app.listen(PORT, () =>
    console.log(`SGRHP running on http://localhost:${PORT} — storage: ${info.backend}`));
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
