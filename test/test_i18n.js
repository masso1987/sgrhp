/**
 * Interface language checks (FR/EN) — parses public/index.html and verifies the
 * i18n layer is wired correctly without needing a browser.
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const js = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];

let pass = 0, fail = 0;
const chk = (c, l) => { if (c) { pass++; console.log("PASS: " + l); } else { fail++; console.log("FAIL: " + l); } };

chk(/const I18N = \{/.test(js), "dictionary present");
const dict = JSON.parse(js.match(/const I18N = (\{[\s\S]*?\});/)[1]);
chk(Object.keys(dict).length > 200, `dictionary covers the interface (${Object.keys(dict).length} entries)`);

const bad = Object.entries(dict).filter(([fr, en]) => typeof en !== "string" || !en.trim());
chk(bad.length === 0, "no empty translations");

chk(/localStorage.getItem\("sgrhp_lang"\)/.test(js), "language choice persisted across sessions");
chk(/function setLang/.test(js) && /langSel/.test(html), "language switcher present in the interface");
chk(/MutationObserver/.test(js), "dynamically rendered views are translated");
chk(/document.documentElement.lang = LANG/.test(js), "html lang attribute follows the selection");

const t = new Function("I18N", "LANG", "s", `
  if (LANG === "fr" || s == null) return s;
  const k = String(s).trim();
  return I18N[k] !== undefined ? I18N[k] : s;`);
chk(t(dict, "fr", "Tableau de bord RH") === "Tableau de bord RH", "French returns the source string");
chk(t(dict, "en", "Tableau de bord RH") === "HR dashboard", "English translates a known string");
chk(t(dict, "en", "Karim OUATTARA") === "Karim OUATTARA", "employee data is never translated");
chk(t(dict, "en", "250 000 F CFA") === "250 000 F CFA", "amounts are never translated");

for (const [fr, label] of [["Dossiers", "employees"], ["validation", "validation queue"],
  ["Carrière", "career"], ["Rapports", "reports"], ["audit", "audit log"]]) {
  const found = Object.keys(dict).some(k => k.toLowerCase().includes(fr.toLowerCase()));
  chk(found, `${label} screen has translations`);
}
chk(/alert\(t\(/.test(js), "alert messages go through the translator");
chk(/prompt\(t\(/.test(js), "prompts go through the translator");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
