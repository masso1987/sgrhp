/* Engine v2 invariants + Cameroon (Sage-calibrated) checks. */
const { computePayslip, progressive } = require("./engine");
let pass=0, fail=0;
const eq=(n,g,e,tol=1)=>{const ok=Math.abs(g-e)<=tol;console.log(`${ok?"✓":"✗"} ${n}: ${g} (exp ${e})`);ok?pass++:fail++;};

// Base case 150000, full month, no primes
let p=computePayslip({ baseSalary:150000 });
eq("BRUT", p.totals.brutTotal, 150000);
eq("NETCOTI = brut (all cotisable)", p.totals.netCotisable, 150000);
eq("PVID 4.2%", p.totals.cnpsSalarie, 6300);
eq("PF 7% (patronal)", p.lines.find(l=>l.code==="5010").employer, 10500);
eq("AT 2.5% (patronal)", p.lines.find(l=>l.code==="5020").employer, 3750);
eq("CFC sal 1% on BASECF", p.totals.cfcSalarie, 1500);
eq("FNE 1% (patronal)", p.totals.fnePatronal, 1500);

// CNPS ceiling caps PVID/PF/AT at 750000
p=computePayslip({ baseSalary:1200000 });
eq("PVID capped (750000*4.2%)", p.totals.cnpsSalarie, 31500);
eq("PF capped (750000*7%)", p.lines.find(l=>l.code==="5010").employer, 52500);

// Seniority 5y => 4% + 3*2% = 10%
p=computePayslip({ baseSalary:200000, seniorityYears:5 });
eq("seniority rate 10%", Math.round(p.meta.seniorityRate*100), 10);
eq("seniority amount", p.lines.find(l=>l.code==="1040").gain, 20000);

// Proration half month
p=computePayslip({ baseSalary:150000, workedDays:15 });
eq("prorated base", p.meta.proratedBase, 75000);

// Net = brut - total retenues (identity)
p=computePayslip({ baseSalary:150000, gains:[{label:"Prime",amount:20000}], otherDeductions:[{label:"Acompte",amount:10000}] });
eq("net = brut - retenues", p.totals.brutTotal - p.totals.totalRetenues, p.totals.netAPayer);
eq("acompte in retenues", p.totals.autresRetenues, 10000);

// IRPP progressive monthly brackets 10/15/25/35
eq("progressive(200000)", Math.round(progressive(200000,[{upTo:166667,rate:0.10},{upTo:250000,rate:0.15},{upTo:Infinity,rate:0.25}])), Math.round(166667*0.10+(200000-166667)*0.15));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
