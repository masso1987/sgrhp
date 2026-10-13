/* Validation CIBLE SARL / ÉTUDES (bulletins Sage réels, juillet 2026).
 * Config CIBLE : transport 100% imposable IRPP, logement plafonné 15% (avantage),
 * documentation & prime exceptionnelle 100% imposables mais HORS base logement,
 * représentation non imposable/non cotisable, AT 2,5%, base CFC = millier inférieur.
 *
 * Reproduit EXACTEMENT (au franc) : BRUT, base CNPS/PVID, salaire taxable, base CFC.
 * NET reproduit à ±3 F près (convention d'arrondi IRPP interne à Sage). */
const { computePayslip } = require("./engine");

const CIBLE = {
  transportExemptionCap: 0,
  avantagesNatureList: [
    { rubriqueCode: "3510", rate: 0.15, active: true },
    { rubriqueCode: "3514", rate: 1.00, active: true },
    { rubriqueCode: "2142", rate: 1.00, active: true },
  ],
};
const g = (code, label, amount) => ({ code, label, amount, cnps: true, impo: true });
const nt = (code, label, amount) => ({ code, label, amount });
const T = (amount = 32500) => ({ code: "3513", label: "Transport", amount });

const EMP = [
  { n: "ABEGA NEMI", b: 146368, g: [g("1055","Anc",47368), g("3510","Log",48434)], t: T(), r: { brut:274670, pvid:242170, ni:260171, cfc:260000 } },
  { n: "ABOGO", b: 218005, g: [g("3510","Log",54502), g("3514","Doc",15000)], t: T(), r: { brut:320007, pvid:287507, ni:303081, cfc:303000 } },
  { n: "BABASSOU", b: 60473, g: [g("3510","Log",15120)], t: T(), r: { brut:108093, pvid:75593, ni:106919, cfc:106000 } },
  { n: "DEMANOU", b: 261598, g: [g("1055","Anc",13080), g("2128","Resp",30000), g("3510","Log",68670)], t: T(), r: { brut:405848, pvid:373348, ni:387755, cfc:387000 } },
  { n: "EBENYE", b: 218005, g: [g("1055","Anc",94514), g("2128","Resp",40000), g("3510","Log",78130)], t: T(), r: { brut:463149, pvid:430649, ni:442772, cfc:442000 } },
  { n: "ILENG", b: 267234, g: [g("1055","Anc",58977), g("3510","Log",81553)], nt: [nt("3512","Repr",105000)], t: T(), r: { brut:545264, pvid:407764, ni:412518, cfc:412000 } },
  { n: "JOKO", b: 247092, g: [g("1055","Anc",26161), g("2128","Resp",35000), g("2142","Except",50000), g("3510","Log",67225), g("3514","Doc",15000)], t: T(), r: { brut:472978, pvid:440478, ni:456866, cfc:456000 } },
  { n: "NDINGA", b: 117732, g: [g("1055","Anc",31707), g("3510","Log",37360)], t: T(), r: { brut:219299, pvid:186799, ni:209230, cfc:209000 } },
  { n: "NGO MONSO", b: 165846, g: [g("1055","Anc",7479), g("3510","Log",43350)], t: T(), r: { brut:249175, pvid:216675, ni:236699, cfc:236000 } },
  { n: "NGOUMENIE", b: 218005, g: [g("3510","Log",54502)], t: T(), r: { brut:305007, pvid:272507, ni:288081, cfc:288000 } },
  { n: "NYEMECK", b: 165846, g: [g("1055","Anc",66156), g("3510","Log",58000)], t: T(), r: { brut:322502, pvid:290002, ni:304177, cfc:304000 } },
  { n: "NYOBA", b: 180936, g: [g("3510","Log",45235), g("3514","Doc",25000)], t: T(), r: { brut:283671, pvid:251171, ni:270451, cfc:270000 } },
  { n: "TAMEGHE", b: 267234, g: [g("1055","Anc",29488), g("2127","Rend",50000), g("3510","Log",74181)], t: T(), r: { brut:453403, pvid:420903, ni:436105, cfc:436000 } },
  { n: "TIWA", b: 156222, g: [g("3510","Log",39055)], t: T(), r: { brut:227777, pvid:195277, ni:217030, cfc:217000 } },
  { n: "YONE", b: 218005, g: [g("3510","Log",54550)], t: T(), r: { brut:305055, pvid:272555, ni:288081, cfc:288000 } },
];

let pass = 0, fail = 0;
const chk = (n, got, exp, tol = 0) => { const ok = Math.abs(got - exp) <= tol; console.log(`${ok ? "✓" : "✗"} ${n}: ${got} (Sage ${exp})`); ok ? pass++ : fail++; };

for (const e of EMP) {
  const r = computePayslip({ baseSalary: e.b, workedDays: 30, standardDays: 30, seniorityYears: 0,
    gains: e.g, nonTaxable: e.nt || [], transport: e.t, ravBase: e.r.brut, tdlBase: e.b }, CIBLE);
  const t = r.totals;
  chk(`${e.n} BRUT`, t.brutTotal, e.r.brut);
  chk(`${e.n} base CNPS`, r.meta.cnpsBase, e.r.pvid);
  chk(`${e.n} salaire taxable`, t.netImposable, e.r.ni);
  chk(`${e.n} base CFC`, t.baseCF, e.r.cfc);
}
console.log(`\n=== ${pass} passed, ${fail} failed (BRUT / base CNPS / salaire taxable / base CFC, au franc) ===`);
process.exit(fail ? 1 : 0);
