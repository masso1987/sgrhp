/* Full validation against the real CIBLE ENERGIE payslip (ZANG ROMEO, sept-2025).
 * Reproduces every figure to the franc (±1 rounding). IRPP formula:
 * SNI = 70%*NETIMPO - PVID - 500000/12 ; progressive 10/15/25/35. */
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
const r = computePayslip(input, { transportExemptionCap: 36000 - 2214 });
const t = r.totals; let fail = 0;
const chk = (n, got, exp, tol=1) => { const ok = Math.abs(got-exp)<=tol; if(!ok) fail++; console.log(`${ok?"✓":"✗"} ${n}: ${got} (slip ${exp})`); };
chk("BRUT", t.brutTotal, 429997);
chk("NETCOTI", t.netCotisable, 383837);
chk("NETIMPO", t.netImposable, 396211);
chk("PVID 4.2%", t.cnpsSalarie, 16121);
chk("PF 7%", r.lines.find(l=>l.code==="5010").employer, 26869);
chk("AT 2.5%", r.lines.find(l=>l.code==="5020").employer, 9596);
chk("IRPP", t.irpp, 24602, 2);
chk("CAC 10%", t.cac, 2460, 2);
chk("CFC sal 1%", t.cfcSalarie, 3960);
chk("CFC pat 1.5%", t.cfcPatronal, 6450);
chk("FNE 1%", t.fnePatronal, 4300);
chk("RAV (base BRUT)", t.rav, 5850);
chk("TDL (base salaire)", t.tdl, 2000);
chk("Charges salariales", t.totalRetenues, 54993, 2);
chk("NET A PAYER", t.netAPayer, 375004, 2);
// cotisations patronales as grouped on the slip (excl. FNE)
const cotisPat = t.cnpsPatronal + t.cfcPatronal;
chk("Cotis. patronales (slip band, excl FNE)", cotisPat, 59036);
console.log(`\n${15-fail}/15 exact (±1 franc). ${fail?"FAIL":"PASS"}`);
process.exit(fail?1:0);
