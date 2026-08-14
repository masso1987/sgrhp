const { computeRow, computeAnnexe } = require("./annexe");
// CIMPOR MAD — reproduce AZAMBO (row 1) to the franc from the real annexe PDF.
const contract = { billingType: "MAD", rates: { congesDivisor: 12, chargesPatronales: 0.162, fraisGestion: 0.10, tva: 0.1925, anciennete: false } };
const template = { groupBy: null, columns: [
  { key: "NOMS", source: "field", field: "name", label: "Noms et prénoms" },
  { key: "POSITION", source: "field", field: "poste", label: "Position" },
  { key: "BASICS", expr: "BASE" },
  { key: "TRANSP", expr: "TRANSP" }, { key: "LOGEM", expr: "LOGEM" }, { key: "SALIS", expr: "SALIS" },
  { key: "RISQUE", expr: "RISQUE" }, { key: "RESP", expr: "RESP" },
  { key: "GROSS", expr: "BASICS + TRANSP + LOGEM + SALIS + RISQUE + RESP" },
  { key: "PROV_CG", expr: "GROSS / 12" },
  { key: "CH_PAT", expr: "(GROSS + PROV_CG) * 0.162" },
  { key: "FG", expr: "(GROSS + PROV_CG + CH_PAT) * 0.10" },
  { key: "TOTAL_HT", expr: "GROSS + PROV_CG + CH_PAT + FG" },
  { key: "TVA", expr: "TOTAL_HT * 0.1925" },
  { key: "TOTAL_TTC", expr: "TOTAL_HT + TVA" },
] };
const line = { name: "AZAMBO NGANDO MICHAEL ARSELE", poste: "Rock drill operator", cat: "7D", jours: 30, salaireBase: 193293,
  components: { TRANSP: { montant: 39000 }, LOGEM: { montant: 92037 }, SALIS: { montant: 20000 }, RISQUE: { montant: 25000 }, RESP: { montant: 50000 } } };
const r = computeRow(line, template, contract).cells;
let f = 0; const chk = (n, g, e) => { const ok = g === e; if (!ok) f++; console.log(`${ok?"✓":"✗"} ${n}: ${g} (annexe ${e})`); };
chk("GROSS", r.GROSS, 419330);
chk("PROV.CG (÷12)", r.PROV_CG, 34944);
chk("CH.PAT (16,2%)", r.CH_PAT, 73592);
chk("FG 10%", r.FG, 52787);
chk("TOTAL HT", r.TOTAL_HT, 580653);
chk("TVA 19,25%", r.TVA, 111776);
chk("TOTAL TTC", r.TOTAL_TTC, 692429);
// grand total across the 3 real rows (add BIEM + LEKUNZE)
const l2 = { name: "BIEM", poste: "Crane operator", jours: 30, salaireBase: 193293, components: { TRANSP:{montant:39000}, LOGEM:{montant:74719}, SALIS:{montant:20000}, RISQUE:{montant:25000}, RESP:{montant:50000}, HS120:{montant:42823}, HS130:{montant:42042}, HS140:{montant:74940} } };
template.columns.splice(8,0,{key:"HS120",expr:"HS120"},{key:"HS130",expr:"HS130"},{key:"HS140",expr:"HS140"});
template.columns.find(c=>c.key==="GROSS").expr = "BASICS + TRANSP + LOGEM + SALIS + RISQUE + RESP + HS120 + HS130 + HS140";
const g2 = computeRow(l2, template, contract).cells;
const chkT = (n, g, e) => { const ok = Math.abs(g - e) <= 1; if (!ok) f++; console.log(`${ok?"✓":"✗"} ${n}: ${g} (annexe ${e}, ±1 arrondi HS)`); };
chkT("BIEM GROSS", g2.GROSS, 561816);
chkT("BIEM TOTAL HT", g2.TOTAL_HT, 777956);
console.log(`\n${f===0?"PASS":"FAIL"} — ${9-f}/9`);
process.exit(f?1:0);
