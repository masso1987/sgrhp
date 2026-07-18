const express = require("express");
const path = require("path");
const { login, authenticate } = require("./auth");
const { seed } = require("./seed");

seed();
require("./seed").ensureReferentials();
require("./templateEngine").syncSeedTemplates();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/login", login);
app.use("/api", authenticate);
app.get("/api/me", require("./auth").me);
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

// SLA timer scan every minute (§5.4)
setInterval(() => { try { require("./workflow").slaScan(); } catch (e) { console.error(e); } }, 60e3);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SGRHP M1 running on http://localhost:${PORT}`));
