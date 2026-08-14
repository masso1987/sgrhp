/**
 * Facturation — configurable annexe engine.
 * An annexe TEMPLATE = ordered columns (each a formula), grouping, taxes, header.
 * Per employee/unit line we build a scope { BASE, JOURS, PRES, <component codes>,
 * cascade values } and evaluate each column in order (a column may reference earlier
 * columns by key). Produces rows, per-group subtotals, and a grand total.
 */
const { computeLine } = require("./engine");
const { evalFormula } = require("./formula");
const r2 = (n) => Math.round(Number(n) || 0);

function lineScope(line, contract) {
  const c = computeLine(line, contract);
  const scope = {
    JOURS: Number(line.jours) || 0,
    PRES: Number(line.pres != null ? line.pres : line.jours) || 0,
    BASE: c.raw.basePorata != null ? c.raw.basePorata : Number(line.salaireBase) || 0,
    SALAIREBASE: Number(line.salaireBase) || 0,
    // cascade values (convenience — templates may ignore them and use pure formulas)
    BRUT: c.raw.brut || 0, CONGES: c.raw.conges || 0, CHARGES: c.raw.charges || 0,
    FRAIS: c.raw.fraisGestion || 0, HT: c.raw.HT || 0, TVA_CASC: c.raw.TVA || 0, TTC_CASC: c.raw.TTC || 0,
  };
  for (const [code, v] of Object.entries(line.components || {}))
    scope[code] = Number(v && v.montant != null ? v.montant : v) || 0;
  // aggregate helpers
  scope.PRIMES = Number(line.primes) || 0;
  scope.HORSCHARGES = Number(line.horsCharges) || 0;
  return scope;
}

function computeRow(line, template, contract) {
  const scope = lineScope(line, contract);
  const row = { _name: line.name || "", _poste: line.poste || "", _cat: line.cat || "", cells: {} };
  for (const col of template.columns || []) {
    if (col.source === "field") { const fv = line[col.field]; row.cells[col.key] = fv != null ? fv : (col.field === "jours" ? scope.JOURS : ""); continue; }
    const raw = evalFormula(col.expr != null && col.expr !== "" ? col.expr : col.key, scope);
    const shown = r2(raw);
    scope[col.key] = template.roundMode === "rounded" ? shown : raw; // per-template rounding mode
    row.cells[col.key] = shown;
  }
  return row;
}

function computeAnnexe(template, lines, contract) {
  const numCols = (template.columns || []).filter(c => c.source !== "field");
  const rows = (lines || []).map(l => computeRow(l, template, contract));
  // grouping
  let groups = null;
  if (template.groupBy === "poste") {
    groups = {};
    for (const r of rows) (groups[r._poste || "—"] = groups[r._poste || "—"] || []).push(r);
  }
  const sumCols = (rws) => { const t = {}; for (const c of numCols) t[c.key] = rws.reduce((s, r) => s + (Number(r.cells[c.key]) || 0), 0); return t; };
  const groupTotals = {};
  if (groups) for (const [g, rws] of Object.entries(groups)) groupTotals[g] = sumCols(rws);
  const total = sumCols(rows);
  return { template, columns: template.columns || [], rows, groups, groupTotals, total, count: rows.length };
}

module.exports = { computeAnnexe, computeRow, lineScope };
