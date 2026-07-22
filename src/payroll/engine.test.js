const { computePayslip, progressive } = require("./engine");
let pass=0, fail=0;
function eq(name, got, exp, tol=1){ const ok=Math.abs(got-exp)<=tol; console.log(`${ok?"✓":"✗"} ${name}: got ${got}, exp ${exp}`); ok?pass++:fail++; }

// --- Case 1: 150,000 base, full month, no seniority, no primes ---
let p = computePayslip({ baseSalary:150000 });
console.log("\n[Case1] base 150000");
eq("SBT", p.totals.salaireBrutTaxable, 150000);
eq("CNPS PVID salarié (4.2%)", p.totals.cnpsSalarie, 6300);          // 150000*0.042
eq("CFC salarié (1%)", p.totals.cfcSalarie, 1500);
eq("RAV bracket(150000)", p.totals.rav, 1950);
eq("TDL bracket(150000)", p.totals.tdl, 1000);
// IRPP: monthlyNetForTax=143700; annual=143700*0.7*12-500000=1,207,080-... =>1206080*? compute: 143700*0.7=100590; *12=1,207,080; -500000=707,080; *10%=70,708/12=5,892
eq("IRPP monthly", p.totals.irpp, 5892, 2);
eq("CAC (10% IRPP)", p.totals.cac, 589, 1);
// employer PVID 6300 + PF 10500 + RP 2625 + CFC 2250 + FNE 1500 = 23175
eq("charges patronales", p.totals.chargesPatronales, 23175, 2);

// --- Case 2: high salary above CNPS ceiling 750000 ---
p = computePayslip({ baseSalary:1200000 });
console.log("\n[Case2] base 1,200,000 (above ceiling)");
eq("CNPS PVID salarié capped (750000*4.2%)", p.totals.cnpsSalarie, 31500);
eq("CFC salarié on full SBT (1%)", p.totals.cfcSalarie, 12000);
eq("RAV top bracket", p.totals.rav, 13000);

// --- Case 3: proration half month ---
p = computePayslip({ baseSalary:150000, workedDays:15, standardDays:30 });
console.log("\n[Case3] proration 15/30");
eq("prorated base", p.meta.proratedBase, 75000);
eq("SBT prorated", p.totals.salaireBrutTaxable, 75000);

// --- Case 4: seniority 5 yrs => 4% + 3*1% = 7% ---
p = computePayslip({ baseSalary:200000, seniorityYears:5 });
console.log("\n[Case4] seniority 5y");
eq("seniority rate", Math.round(p.meta.seniorityRate*100), 7);
eq("seniority amount", p.lines.find(l=>l.code==="1040").gain, 14000);

// --- Case 5: net = brut - retenues consistency ---
p = computePayslip({ baseSalary:150000, gains:[{label:"Prime perf",amount:20000}], otherDeductions:[{label:"Acompte",amount:10000}] });
console.log("\n[Case5] with prime + acompte");
const t=p.totals;
eq("net = brut - retenues", t.brutTotal - t.totalRetenues, t.netAPayer);
eq("acompte in retenues", t.autresRetenues, 10000);

// progressive sanity
console.log("\n[progressive]");
eq("progressive 707080", Math.round(progressive(707080,[{upTo:2000000,rate:0.10},{upTo:3000000,rate:0.15},{upTo:5000000,rate:0.25},{upTo:Infinity,rate:0.35}])), 70708);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
