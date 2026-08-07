const { computeMAD, computeSheet } = require("./engine");
let fail = 0;
const chk = (n, got, exp) => { const ok = got === exp; if (!ok) fail++; console.log(`${ok?"✓":"✗"} ${n}: ${got} (attendu ${exp})`); };

// MAD reference cascade (hand-computed, franc CFA)
const contract = { billingType: "MAD",
  rates: { congesDivisor: 16, finContrat: 1, finDivisor: 3, chargesPatronales: 0.162, fraisGestion: 0.10, tva: 0.1925, ancienneteRate: 0.02, ancienneteMinYears: 2 } };
const line = { name: "ZANG", poste: "QHSE", salaireBase: 200000, jours: 30, primes: 40000, horsCharges: 10000, years: 3 };
const m = computeMAD(line, contract);
chk("base proratée", m.basePorata, 200000);
chk("ancienneté (2%×base×3)", m.anciennete, 12000);
chk("brut", m.brut, 252000);
chk("provision congés (÷16)", m.conges, 15750);
chk("provision fin (÷3)", m.fin, 5250);
chk("sous-total", m.sousTotal, 273000);
chk("charges patronales (16,2%)", m.charges, 44226);
chk("total 2", m.total2, 327226);
chk("frais de gestion (10%)", m.fraisGestion, 32723);
chk("HT", m.HT, 359949);
chk("TVA (19,25%)", m.TVA, 69290);
chk("TTC", m.TTC, 429239);

// proration: 15 days halves the base, primes/ancienneté unchanged (prorate=base)
const m15 = computeMAD(Object.assign({}, line, { jours: 15 }), contract);
chk("proration 15j base", m15.basePorata, 100000);
chk("proration 15j ancienneté inchangée", m15.anciennete, 12000);

// sheet totals + alphabetical grouping
const sheet = { lines: [ line, Object.assign({}, line, { name: "ABENA" }) ] };
const S = computeSheet(sheet, contract);
chk("fiche: nb lignes", S.totals.count, 2);
chk("fiche: ΣTTC", S.totals.TTC, 429239 * 2);
chk("fiche: tri alphabétique", S.lines[0].name, "ABENA");

console.log(`\n${fail===0?"PASS":"FAIL"} — ${16-fail}/16`);
process.exit(fail ? 1 : 0);
