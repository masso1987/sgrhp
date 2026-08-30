#!/usr/bin/env node
/**
 * Add (or update) a platform super-administrator (SADM) account.
 *
 * Usage:
 *   node scripts/add-superadmin.js "<email>" "<Nom complet>" "<MotDePasse>"
 * or with environment variables:
 *   SA_EMAIL=... SA_NAME="..." SA_PASSWORD=... node scripts/add-superadmin.js
 *
 * In Docker (production):
 *   docker compose exec app node scripts/add-superadmin.js "email@ex.com" "Nom" "MotDePasse"
 *
 * The password is hashed with the app's own scrypt routine and never stored in clear.
 * If the email already exists, the account is promoted to SADM and its password reset.
 */
const { db, save, id, initStorage } = require("../src/store");
const { hash, passwordPolicy } = require("../src/auth");

(async () => {
  const email = (process.argv[2] || process.env.SA_EMAIL || "").trim().toLowerCase();
  const fullName = (process.argv[3] || process.env.SA_NAME || "Super Administrateur").trim();
  const password = process.argv[4] || process.env.SA_PASSWORD || "";

  if (!email || !password) {
    console.error('Usage: node scripts/add-superadmin.js "<email>" "<Nom complet>" "<MotDePasse>"');
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Email invalide :", email);
    process.exit(1);
  }
  const pwErr = passwordPolicy(password);
  if (pwErr) {
    console.error("Mot de passe refuse :", pwErr);
    process.exit(1);
  }

  await initStorage();

  const existing = db.users.find(u => (u.email || "").toLowerCase() === email);
  if (existing) {
    existing.role = "SADM";
    existing.tenantId = "platform";
    existing.active = true;
    existing.password = hash(password);
    existing.failedLogins = 0;
    existing.lockedUntil = null;
    if (fullName) existing.fullName = fullName;
    await save();
    console.log(`Compte existant promu SADM : ${email} (${existing.fullName})`);
    process.exit(0);
  }

  const user = {
    id: id("usr"),
    email,
    fullName,
    role: "SADM",
    tenantId: "platform",
    portfolioIds: [],
    password: hash(password),
    active: true,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  await save();
  console.log(`Super-administrateur cree : ${email} (${fullName})`);
  console.log("Connectez-vous puis activez la 2FA dans Mon compte.");
  process.exit(0);
})().catch(e => {
  console.error("Echec :", e.message);
  process.exit(1);
});
