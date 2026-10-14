/* Validation BARRYCALLEBAUT (CIBLE RH MISE A DISPOSITION BARRY CALLEBAUT), Sage, août 2026.
 *
 * Config Sage reconstituée (distincte de CIBLE SARL / ÉTUDES) :
 *   - Base CNPS/PVID & AT = BRUT − transport(3513) − salissure(3010) − prime de risque(2103).
 *     PVID plafonnée à 750 000 ; AT non plafonnée.
 *   - Salaire taxable : tout imposable SAUF salissure(3010) et prime risque(2103) (exclus
 *     totalement). Transport(3513) 100% imposable. Logement(3510) = avantage plafonné à
 *     15% de l'assiette taxable hors logement. Prime de sécurité(2130) = normale.
 *   - Base CFC salarié = taxable arrondi au millier inférieur ; CFC patr 1,5% sur BRUT.
 *
 * Reproduit EXACTEMENT (au franc) : BRUT, base CNPS, salaire taxable, base CFC.
 * 18 bulletins représentatifs (mois plein, congés, prorata 29j/1j, PVID plafonnée à
 * 992 010, gros logements écrêtés, prime de sécurité, trop-perçu, agrilogic). */
const { computePayslip } = require("./engine");

const BARRY = {
  transportExemptionCap: 0,
  avantagesNatureList: [{ rubriqueCode: "3510", rate: 0.15, active: true }],
};
const g = (code, label, amount) => ({ code, label, amount, cnps: true,  impo: true  }); // cotisable + imposable
const x = (code, label, amount) => ({ code, label, amount, cnps: false, impo: false }); // exclu CNPS + exclu taxable (3010, 2103)
const T = (amount) => ({ code: "3513", label: "Transport", amount });

const EMP = [
  { n: "AMBE EDEN",   b: 81016,  g: [x("2103","Risq",5000), g("2127","Rend",35000), x("3010","Sal",5000), g("3510","Log",20254)], t: T(31200), r: { brut:177470, pvid:136270, ni:167470, cfc:167000 } },
  { n: "EKWA SAME",   b: 81016,  g: [g("1055","Anc",5740), x("2103","Risq",5000), g("2127","Rend",41000), x("3010","Sal",5000), g("3510","Log",21330)], t: T(31200), r: { brut:190286, pvid:149086, ni:180286, cfc:180000 } },
  { n: "AYISSI",      b: 32406,  g: [g("1055","Anc",5740), x("2103","Risq",2000), g("2127","Rend",35000), x("3010","Sal",2000), g("3510","Log",21330), g("3702","Cong",135269)], t: T(12480), r: { brut:246225, pvid:229745, ni:242225, cfc:242000 } },
  { n: "AMBA (29j)",  b: 210738, g: [g("1030","Surs",18852), x("3010","Sal",14500), g("3510","Log",54501)], t: T(30160), r: { brut:328751, pvid:284091, ni:298713, cfc:298000 } },
  { n: "FAI (secu)",  b: 156222, g: [g("1055","Anc",21871), g("2130","Secu",10000), x("3010","Sal",5000), g("3510","Log",43742)], t: T(36000), r: { brut:272835, pvid:231835, ni:257707, cfc:257000 } },
  { n: "ETANGO",      b: 247092, g: [g("1030","Surs",100259), g("1055","Anc",21801), x("2103","Risq",5000), x("3010","Sal",10000), g("3510","Log",171946)], t: T(36000), r: { brut:592098, pvid:541098, ni:465925, cfc:465000 } },
  { n: "EMBOLO(cap)", b: 247092, g: [g("2514","13e",214121), x("3010","Sal",15000), g("3510","Log",61773), g("3702","Cong",410824)], t: T(43200), r: { brut:992010, pvid:750000, ni:977010, cfc:977000 } },
  { n: "HERMAN(prr)", b: 29067,  g: [g("1030","Surs",2600), x("3010","Sal",2000), g("3510","Log",54501), g("3702","Cong",239495)], t: T(4160), r: { brut:331823, pvid:325663, ni:316620, cfc:316000 } },
  { n: "ETOMBE",      b: 60473,  g: [x("2103","Risq",10000), g("2127","Rend",38353), x("3010","Sal",5000), g("3510","Log",15118)], t: T(31200), r: { brut:160144, pvid:113944, ni:145144, cfc:145000 } },
  { n: "MBIA EFF.",   b: 232548, g: [g("1030","Surs",76620), x("2103","Risq",5000), x("3010","Sal",10000), g("3510","Log",123667)], t: T(36000), r: { brut:483835, pvid:432835, ni:396943, cfc:396000 } },
  { n: "HAMIDOU",     b: 247092, g: [g("1030","Surs",36952), x("2103","Risq",5000), x("3010","Sal",10000), g("3510","Log",148975)], t: T(36000), r: { brut:484019, pvid:433019, ni:368051, cfc:368000 } },
  { n: "FIKINOU",     b: 218005, g: [g("1030","Surs",33040), x("2103","Risq",5000), g("3510","Log",54501)], t: T(36000), r: { brut:346546, pvid:305546, ni:330102, cfc:330000 } },
  { n: "MINYEM(tp)",  b: 81016,  g: [g("2035","Rappel",25000), x("2103","Risq",5000), g("2127","Rend",35000), x("3010","Sal",5000), g("3510","Log",20254)], t: T(31200), r: { brut:202470, pvid:161270, ni:192470, cfc:192000 } },
  { n: "OKODOMBE",    b: 218005, g: [g("1030","Surs",19502), x("3010","Sal",15000), g("3510","Log",54501)], t: T(31200), r: { brut:338208, pvid:292008, ni:309013, cfc:309000 } },
  { n: "NOMO",        b: 232548, g: [x("2103","Risq",5000), x("3010","Sal",10000), g("3510","Log",151156)], t: T(36000), r: { brut:434704, pvid:383704, ni:308830, cfc:308000 } },
  { n: "NKONO(cong)", b: 32406,  g: [g("1055","Anc",5740), x("2103","Risq",2000), g("2127","Rend",41000), x("3010","Sal",2000), g("3510","Log",21330), g("3702","Cong",131436)], t: T(12480), r: { brut:248392, pvid:231912, ni:244392, cfc:244000 } },
  { n: "NKOUMOU",     b: 81016,  g: [g("1055","Anc",5740), x("2103","Risq",5000), g("2127","Rend",41000), x("3010","Sal",5000), g("3510","Log",34128)], t: T(31200), r: { brut:203084, pvid:161884, ni:182799, cfc:182000 } },
  { n: "OLOMO(cong)", b: 32406,  g: [g("1055","Anc",5740), x("2103","Risq",2000), g("2127","Rend",35000), x("3010","Sal",2000), g("3510","Log",34128), g("3702","Cong",140380)], t: T(12480), r: { brut:264134, pvid:247654, ni:259907, cfc:259000 } },
];

let pass = 0, fail = 0;
const chk = (n, got, exp, tol = 0) => { const ok = Math.abs(got - exp) <= tol; console.log(`${ok ? "✓" : "✗"} ${n}: ${got} (Sage ${exp})`); ok ? pass++ : fail++; };

for (const e of EMP) {
  const r = computePayslip({ baseSalary: e.b, workedDays: 30, standardDays: 30, seniorityYears: 0,
    gains: e.g, nonTaxable: [], transport: e.t, ravBase: e.r.brut, tdlBase: e.b }, BARRY);
  const t = r.totals;
  chk(`${e.n} BRUT`, t.brutTotal, e.r.brut);
  chk(`${e.n} base CNPS`, r.meta.cnpsBase, e.r.pvid);
  chk(`${e.n} salaire taxable`, t.netImposable, e.r.ni);
  chk(`${e.n} base CFC`, t.baseCF, e.r.cfc);
}
console.log(`\n=== BARRYCALLEBAUT : ${pass} passed, ${fail} failed (BRUT / base CNPS / salaire taxable / base CFC, au franc) ===`);
process.exit(fail ? 1 : 0);
