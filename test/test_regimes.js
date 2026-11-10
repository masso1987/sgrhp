// Régimes de paie — test de bout en bout contre un serveur LOCAL (données de démo + module paie activé, >= 2 salariés avec ancienneté).
// Usage : B=http://localhost:4000/api node test/test_regimes.js
const B = process.env.B || "http://localhost:4100/api";
let pass = 0, fail = 0;
const chk = (ok, msg, extra) => { if (ok) { pass++; console.log("PASS:", msg); } else { fail++; console.log("FAIL:", msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); } };
let TOK;
async function api(method, url, body) {
  const r = await fetch(B + url, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOK }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
(async () => {
  const lg = await fetch(B + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@cible-rh.ci", password: "demo123" }) }).then(r => r.json());
  TOK = lg.token; chk(!!TOK, "login admin");

  // Employees with a computable salary
  const emps = (await api("GET", "/employees")).body;
  const calc = [];
  for (const e of emps) { const s = await api("POST", "/payroll/simulate/" + e.id, {}); if (s.status === 200) calc.push({ e, net: s.body.result.totals.netAPayer, meta: s.body.result.meta }); }
  chk(calc.length >= 3, "at least 3 computable employees (" + calc.length + ")");
  // Prefer employees with >= 2 years of seniority (so the seniority rule changes their pay)
  const senior = calc.filter(c => (c.meta.seniorityRate || 0) > 0);
  chk(senior.length >= 2, "at least 2 employees with seniority bonus (" + senior.length + ")");
  const A = senior[0], Bm = senior[1];
  chk(A.meta.regimeId === "principal", "payslip meta records principal régime by default", A.meta);

  const ids = calc.map(c => c.e.id);
  const base = (await api("POST", "/payroll/regimes/principal/impact", { employeeIds: ids })).body;
  const baseNet = Object.fromEntries(base.rows.map(r => [r.employeeId, r.netBefore]));
  chk(base.rows.every(r => r.netDiff === 0), "principal → principal impact is zero for everyone");

  // 1) New régime « Convention 2026 » with a more generous seniority rule
  let r = await api("POST", "/payroll/regimes", { name: "Convention 2026", description: "Nouveaux salariés", copyFrom: "principal" });
  chk(r.status === 201, "create régime", r.body); const R1 = r.body.id;
  r = await api("POST", "/payroll/regimes", { name: "convention 2026" });
  chk(r.status === 409, "duplicate name refused");
  const cfg = (await api("GET", "/payroll/config?regimeId=" + R1)).body;
  chk(cfg._regimeId === R1 && cfg._regimeOverrides.length === 0, "new régime starts identical to principal");
  r = await api("PUT", "/payroll/config?regimeId=" + R1, Object.assign({}, cfg, { seniority: Object.assign({}, cfg.seniority, { startRate: 0.06, perYearRate: 0.03 }) }));
  chk(r.status === 200 && JSON.stringify(r.body._regimeOverrides) === JSON.stringify(["seniority"]), "régime stores only its differences", r.body._regimeOverrides);
  const pcfg = (await api("GET", "/payroll/config")).body;
  chk(pcfg.seniority.startRate === 0.04 && pcfg.seniority.perYearRate === 0.02, "principal config untouched");

  // 2) Impact & assignment of A to the generous régime (raise → no confirmation)
  r = await api("POST", "/payroll/regimes/" + R1 + "/impact", { employeeIds: [A.e.id] });
  const impA = r.body.rows[0];
  chk(impA.netAfter > impA.netBefore, "A earns more under Convention 2026", impA);
  r = await api("POST", "/payroll/regimes/" + R1 + "/assign", { employeeIds: [A.e.id] });
  chk(r.status === 200 && r.body.assigned === 1, "assign A (no decrease) succeeds", r.body);
  let s = await api("POST", "/payroll/simulate/" + A.e.id, {});
  chk(s.body.result.meta.regimeId === R1 && s.body.result.meta.regimeName === "Convention 2026", "A's payslip records the régime");
  chk(Math.round(s.body.result.totals.netAPayer) !== Math.round(A.net), "A's payslip differs from before", [A.net, s.body.result.totals.netAPayer]);

  // 3) Others unchanged
  const after = (await api("POST", "/payroll/regimes/principal/impact", { employeeIds: ids.filter(x => x !== A.e.id) })).body;
  chk(after.rows.every(x => x.netBefore === baseNet[x.employeeId]), "every other employee's net is unchanged");

  // 4) A stingy régime → decrease blocked unless forced
  r = await api("POST", "/payroll/regimes", { name: "Sans ancienneté", copyFrom: R1 });
  const R2 = r.body.id; chk(r.body.overrides.config === 1, "duplicate copies the source régime's differences");
  const c2 = (await api("GET", "/payroll/config?regimeId=" + R2)).body;
  await api("PUT", "/payroll/config?regimeId=" + R2, Object.assign({}, c2, { seniority: Object.assign({}, c2.seniority, { startRate: 0, perYearRate: 0 }) }));
  r = await api("POST", "/payroll/regimes/" + R2 + "/assign", { employeeIds: [Bm.e.id] });
  chk(r.status === 409 && r.body.requiresConfirmation && r.body.decreases.length === 1, "decrease of net is blocked", r.body);
  const empB = (await api("GET", "/employees/" + Bm.e.id)).body;
  chk(!empB.payRegimeId, "B not moved after the refusal");
  r = await api("POST", "/payroll/regimes/" + R2 + "/assign", { employeeIds: [Bm.e.id], force: true });
  chk(r.status === 200, "forced assignment goes through");
  r = await api("POST", "/payroll/regimes/principal/assign", { employeeIds: [Bm.e.id] });
  chk(r.status === 200 && r.body.rows[0].netAfter === baseNet[Bm.e.id], "moving B back to principal restores the original net", r.body.rows && r.body.rows[0]);

  // 5) Rubrique override inside a régime
  const rubs = (await api("GET", "/payroll/rubriques?regimeId=" + R1)).body;
  const rub = rubs.find(x => x.sens === "GAIN" && x.cnps === true && x.code !== "1000");
  r = await api("PUT", "/payroll/rubriques/" + rub.id + "?regimeId=" + R1, { cnps: false });
  chk(r.status === 200 && r.body.cnps === false && r.body.regimeOverride.includes("cnps"), "rubrique flag overridden in régime", r.body);
  const prub = (await api("GET", "/payroll/rubriques")).body.find(x => x.id === rub.id);
  chk(prub.cnps === true, "principal rubrique unchanged");
  r = await api("PUT", "/payroll/rubriques/" + rub.id + "?regimeId=" + R1, { reset: true });
  chk(r.status === 200 && !r.body.regimeOverride, "rubrique override reset");

  // 6) Constants
  const csts = (await api("GET", "/payroll/constantes")).body;
  if (csts.length) {
    const c = csts[0];
    r = await api("PUT", "/payroll/constantes/" + c.id + "?regimeId=" + R1, { valeur: 12345 });
    chk(r.status === 200 && r.body.valeur === 12345 && r.body.regimeOverride, "constant value overridden in régime");
    const pc = (await api("GET", "/payroll/constantes")).body.find(x => x.id === c.id);
    chk(pc.valeur === c.valeur, "principal constant unchanged");
  }

  // 7) Generic employee update cannot bypass the check
  await api("PUT", "/employees/" + Bm.e.id, { payRegimeId: R2 });
  chk(!(await api("GET", "/employees/" + Bm.e.id)).body.payRegimeId, "employee PUT ignores payRegimeId");

  // 8) Default régime for new hires (portfolio level)
  r = await api("PUT", "/payroll/regimes-default", { portfolioId: A.e.portfolioId, regimeId: R1 });
  chk(r.status === 200 && r.body.defaultPayRegimeId === R1, "portfolio default régime set");
  const list = (await api("GET", "/payroll/regimes")).body;
  chk(list.regimes[0].id === "principal" && list.regimes.length === 3, "list has principal + 2 régimes");
  chk(list.portfolios.find(p => p.id === A.e.portfolioId).defaultPayRegimeId === R1, "list shows portfolio default");

  // 9) Payroll run: payslips carry régime; deletion blocked while used
  const st = (await api("GET", "/payroll/runs/open-state")).body;
  const period = st.nextPeriod || new Date().toISOString().slice(0, 7);
  r = await api("POST", "/payroll/runs", { period });
  if (r.status === 201) {
    const run = r.body;
    await api("POST", "/payroll/runs/" + run.id + "/compute", {});
    const det = (await api("GET", "/payroll/runs/" + run.id)).body;
    const slips = det.payslips || det.slips || [];
    const _full = async (x) => x ? (await api("GET", "/payroll/payslips/" + x.id)).body : null;
    const sa = await _full(slips.find(x => x.employeeId === A.e.id));
    chk(sa && sa.result.meta.regimeId === R1, "run payslip for A computed under Convention 2026", sa && sa.result && sa.result.meta);
    const sb = await _full(slips.find(x => x.employeeId === Bm.e.id));
    chk(sb && sb.result.meta.regimeId === "principal", "run payslip for B under principal");
  } else console.log("note: could not open run", r.status, r.body);
  r = await api("DELETE", "/payroll/regimes/" + R1);
  chk(r.status === 409, "cannot delete a régime that has employees");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
