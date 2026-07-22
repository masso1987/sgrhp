/* Validate the engine against the real CIBLE ENERGIE payslip (ZANG ROMEO, sept-2025).
 * Contribution lines must match to the franc; IRPP pending base-definition tables. */
const { computePayslip } = require("./engine");
const input = {
  baseSalary: 290270, workedDays: 30, standardDays: 30, seniorityYears: 0,
  gains: [
    { code:"2101", label:"Prime d'astreinte", amount:21000, cnps:true,  impo:true },
    { code:"2129", label:"Prime de salissure", amount:10160, cnps:false, impo:true },
    { code:"3510", label:"Indemnité de logement", amount:72567, cnps:true, impo:true },
  ],
  transport: { code:"3513", label:"Indemnité de transport", amount:36000 }, tdlBase: 290270,
};
const r = computePayslip(input, {}); const t = r.totals; let fail = 0;
const chk = (n, got, exp) => { const ok = got===exp; if(!ok) fail++; console.log(`${ok?"✓":"✗"} ${n}: ${got} (slip ${exp})`); };
chk("BRUT", t.brutTotal, 429997);
chk("NETCOTI (CNPS base)", t.netCotisable, 383837);
chk("PVID 4.2%", t.cnpsSalarie, 16121);
chk("PF 7%", r.lines.find(l=>l.code==="5010").employer, 26869);
chk("AT 2.5%", r.lines.find(l=>l.code==="5020").employer, 9596);
chk("CFC patronal 1.5%", t.cfcPatronal, 6450);
chk("FNE 1%", t.fnePatronal, 4300);
chk("RAV (base BRUT)", t.rav, 5850);
chk("TDL (base salaire)", t.tdl, 2000);
console.log(`\n${9-fail}/9 contribution lines exact. IRPP pending base-def tables.`);
process.exit(fail?1:0);
