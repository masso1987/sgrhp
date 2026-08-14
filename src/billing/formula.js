/**
 * Facturation — safe formula evaluator for configurable annexe columns.
 * Recursive-descent parser (NO eval): numbers, UPPER/lower identifiers, + - * / ( ),
 * unary +/-. Unknown variables resolve to 0 so optional columns are tolerated.
 * Used so each annexe column can be an expression over other columns / components /
 * cascade values (cf. « GROSS = BASE + TRANSP + LOGEM », « PROV_CG = GROSS / 12 »…).
 */
function evalFormula(expr, scope) {
  if (expr == null || expr === "") return 0;
  if (typeof expr === "number") return expr;
  const s = String(expr); let i = 0;
  const sc = scope || {};
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => (skip(), s[i]);
  function parseExpr() { let v = parseTerm(); while (peek() === "+" || peek() === "-") { const op = s[i++]; const t = parseTerm(); v = op === "+" ? v + t : v - t; } return v; }
  function parseTerm() { let v = parseFactor(); while (peek() === "*" || peek() === "/") { const op = s[i++]; const f = parseFactor(); v = op === "*" ? v * f : (f === 0 ? 0 : v / f); } return v; }
  function parseFactor() { const p = peek(); if (p === "(") { i++; const v = parseExpr(); if (peek() === ")") i++; return v; } if (p === "-") { i++; return -parseFactor(); } if (p === "+") { i++; return parseFactor(); } return parsePrimary(); }
  function parsePrimary() {
    skip(); const start = i;
    if (/[0-9.]/.test(s[i])) { while (i < s.length && /[0-9._]/.test(s[i])) i++; return Number(s.slice(start, i).replace(/_/g, "")) || 0; }
    if (/[A-Za-z_]/.test(s[i])) { while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++; const name = s.slice(start, i); const v = sc[name]; return typeof v === "number" ? v : (v == null ? 0 : Number(v) || 0); }
    i++; return 0;
  }
  const r = parseExpr();
  return isFinite(r) ? r : 0;
}
module.exports = { evalFormula };
