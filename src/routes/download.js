/**
 * Page de téléchargement publique de l'application Android (APK).
 *   GET /download         → page d'installation (instructions + bouton)
 *   GET /download/app.apk → fichier APK (depuis le volume persistant uploads/)
 *
 * L'APK n'est PAS dans l'image Docker : on le dépose dans le volume `uploads`
 * (uploads/apk/app-release.apk), il survit donc aux redéploiements. Remplacer
 * le fichier suffit à publier une nouvelle version — le lien ne change pas.
 */
const router = require("express").Router();
const fs = require("fs");
const path = require("path");

const APK_PATH = process.env.APK_PATH || path.join(__dirname, "..", "..", "uploads", "apk", "app-release.apk");
const APK_NAME = "MBOKA-Mon-RH.apk";
const BRAND = "#1e3a5f", ACCENT = "#e8833a";

function apkInfo() {
  try { const st = fs.statSync(APK_PATH); return { exists: true, size: st.size, mtime: st.mtime }; }
  catch (_) { return { exists: false }; }
}
const fmtSize = (b) => b >= 1e6 ? (b / 1048576).toFixed(1) + " Mo" : Math.round(b / 1024) + " Ko";

// Fichier APK — téléchargement direct.
router.get("/download/app.apk", (req, res) => {
  const info = apkInfo();
  if (!info.exists) return res.status(404).send("APK non disponible pour le moment.");
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${APK_NAME}"`);
  res.setHeader("Content-Length", info.size);
  fs.createReadStream(APK_PATH).pipe(res);
});

// Page d'installation.
router.get("/download", (req, res) => {
  const info = apkInfo();
  const meta = info.exists
    ? `<p class="meta">Version du ${new Date(info.mtime).toLocaleDateString("fr-FR")} · ${fmtSize(info.size)}</p>`
    : `<p class="meta warn">L'application n'est pas encore disponible au téléchargement.</p>`;
  const btn = info.exists
    ? `<a class="btn" href="/download/app.apk">Télécharger l'application</a>`
    : `<span class="btn disabled">Indisponible</span>`;
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(`<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MBOKA Mon RH — Application Android</title>
<style>
 :root{--brand:${BRAND};--accent:${ACCENT}}
 *{box-sizing:border-box} body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f6f9;color:#1f2937}
 .wrap{max-width:460px;margin:0 auto;padding:28px 20px 48px}
 .card{background:#fff;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,.08);padding:28px;text-align:center}
 .logo{width:76px;height:76px;border-radius:20px;background:linear-gradient(135deg,var(--brand),#2a5a8f);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:#fff;font-size:34px;font-weight:800}
 h1{font-size:22px;margin:4px 0 2px;color:var(--brand)} .sub{color:#6b7280;font-size:14px;margin:0 0 6px}
 .meta{font-size:13px;color:#6b7280;margin:10px 0 20px} .meta.warn{color:#b45309;font-weight:600}
 .btn{display:block;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;padding:15px;border-radius:14px;font-size:16px}
 .btn.disabled{background:#cbd5e1;color:#fff} .btn:active{opacity:.9}
 .steps{text-align:left;margin:26px 0 0;padding:18px;background:#f8fafc;border-radius:14px}
 .steps h2{font-size:13px;letter-spacing:.3px;text-transform:uppercase;color:#6b7280;margin:0 0 10px}
 ol{margin:0;padding-left:20px} li{margin:7px 0;font-size:14px;line-height:1.45}
 .note{font-size:12px;color:#9ca3af;margin-top:22px;text-align:center}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="logo">M</div>
    <h1>MBOKA Mon RH</h1>
    <p class="sub">Application mobile — présence &amp; self-service employé</p>
    ${meta}
    ${btn}
    <div class="steps">
      <h2>Installation</h2>
      <ol>
        <li>Touchez <b>Télécharger l'application</b> ci-dessus.</li>
        <li>Ouvrez le fichier téléchargé (<b>${APK_NAME}</b>).</li>
        <li>Si Android le demande, autorisez l'installation depuis cette source (<i>Paramètres → Installer applis inconnues</i>).</li>
        <li>Touchez <b>Installer</b>, puis ouvrez l'application.</li>
        <li>Connectez-vous avec votre matricule et votre mot de passe.</li>
      </ol>
    </div>
    <p class="note">Android uniquement. iPhone bientôt disponible.</p>
  </div>
</div>
</body></html>`);
});

module.exports = router;
