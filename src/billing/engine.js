/**
 * SGRHP — Billing engine (Module Facturation)
 * ONE parameterizable calculation engine replacing the 30+ per-client Odoo models.
 *
 * A `contract` (billing.contract) carries every rate and rule for a client; a `line`
 * carries the per-employee / per-unit inputs. The engine unrolls the correct cascade
 * for the contract's billingType. Intermediate values are kept UNROUNDED; only the
 * displayed/returned figures are rounded HALF_UP, to match the reference Excel to the
 * franc CFA (cf. cahier de charges §3.3, §6.2 F7).
 *
 * Billing types:
 *   MAD        — mise à disposition (salary-cost cascade, the dominant pattern)
 *   PRESTATION — quantité × prix unitaire / tonnage / forfait / heures
 *   RECAP      — HT saisi par ligne (HEVECAM), TVA/TTC auto
 *   PORTAGE    — portage salarial (montants unitaires saisis)
 *   CONSULTANT — consultant (montants saisis, multi-pays)
 */

const r2 = (n) => Math.round((Number(n) || 0)); // franc CFA, HALF_UP via Math.round
const num = (n) => Number(n) || 0;

const DEFAULT_RATES = {
  chargesPatronales: 0.162, // 16,2 %
  tva: 0.1925,              // 19,25 %
  ir: 0,                    // 2,2 % when enabled (retenue)
  fraisGestion: 0.10,       // 10 % (parfois 15 %)
  congesDivisor: 16,        // brut ÷ 16 (6,25 %) ou ÷ 12
  finContrat: 0,            // 0 = off ; sinon congés ÷ finDivisor OU congés × finPct
  finDivisor: 3,
  finPct: 0,                // ex. 0.35 (congés × 35 %)
  hsDivisor: 173.33,        // diviseur heures supplémentaires
  ancienneteRate: 0.02,     // 2 % × base × années
  ancienneteMinYears: 2,    // éligible ≥ 24 mois
  margeCRH: 0,              // ADDAX 8,5 %
  standardDays: 30,
};

function mergeRates(contract) {
  return Object.assign({}, DEFAULT_RATES, (contract && contract.rates) || {});
}

/**
 * Evaluate one component's value from its formula + the line inputs.
 * formula: FIXE | PCT_BASE | BASE_DIV_TAUX (HS) | FORFAIT | QTE_PU
 */
function componentValue(comp, input, rates) {
  const v = (input.components && input.components[comp.code]) || {};
  switch (comp.formula) {
    case "PCT_BASE":     return (comp.taux != null ? comp.taux : num(v.taux)) * num(input.salaireBase);
    case "BASE_DIV_TAUX": // heures supp : base/diviseur × heures × taux
      return (num(input.salaireBase) / (comp.diviseur || rates.hsDivisor)) * num(v.heures) * (comp.taux != null ? comp.taux : num(v.taux));
    case "FORFAIT":      return num(v.quantite) * (comp.forfait != null ? comp.forfait : num(v.forfait));
    case "QTE_PU":       return num(v.quantite) * num(v.pu);
    case "FIXE":
    default:             return num(v.montant);
  }
}

/** Sum of active components of a given cascade stage for this line. */
function stageSum(components, input, rates, stage) {
  let s = 0;
  for (const c of components || []) {
    if (!c.active) continue;
    if (c.stage !== stage) continue;
    s += componentValue(c, input, rates);
  }
  return s;
}

/* ---------------- MAD cascade (per employee) ---------------- */
function computeMAD(input, contract) {
  const R = mergeRates(contract);
  const comps = contract.components || [];
  const days = num(input.jours) || R.standardDays;
  const prorata = R.standardDays ? days / R.standardDays : 1;

  const basePorata = num(input.salaireBase) * prorata;
  // primes: prorated too if the contract prorates base+primes (F6)
  const primeFactor = contract.prorate === "base+primes" ? prorata : 1;
  const primes = stageSum(comps, input, R, "PRIME") * primeFactor + num(input.primes) * primeFactor;

  const years = num(input.anciennete_annees != null ? input.anciennete_annees : input.years);
  const anciennete = (contract.anciennete !== false && years >= R.ancienneteMinYears)
    ? R.ancienneteRate * num(input.salaireBase) * years : 0;

  const brut = basePorata + primes + anciennete;
  const conges = R.congesDivisor ? brut / R.congesDivisor : 0;
  let fin = 0;
  if (R.finContrat) fin = R.finPct ? conges * R.finPct : conges / (R.finDivisor || 3);

  const sousTotal = brut + conges + fin;
  const charges = sousTotal * R.chargesPatronales;
  const horsCharges = stageSum(comps, input, R, "HORS_CHARGE") + num(input.horsCharges);

  const total2 = sousTotal + charges + horsCharges;
  const fraisGestion = total2 * R.fraisGestion;
  const HT = total2 + fraisGestion;
  const TVA = contract.tvaExonere ? 0 : HT * R.tva;
  const TTC = HT + TVA;
  const IR = R.ir ? HT * R.ir : 0;                 // retenue (SOCAPALM/ADDAX)
  const retenues = stageSum(comps, input, R, "RETENUE");
  const netAPayer = TTC - IR - retenues;

  return {
    poste: input.poste || "", name: input.name || "",
    raw: { basePorata, primes, anciennete, brut, conges, fin, sousTotal, charges, horsCharges, total2, fraisGestion, HT, TVA, TTC, IR, retenues, netAPayer },
    basePorata: r2(basePorata), primes: r2(primes), anciennete: r2(anciennete), brut: r2(brut),
    conges: r2(conges), fin: r2(fin), sousTotal: r2(sousTotal), charges: r2(charges),
    horsCharges: r2(horsCharges), total2: r2(total2), fraisGestion: r2(fraisGestion),
    HT: r2(HT), TVA: r2(TVA), TTC: r2(TTC), IR: r2(IR), retenues: r2(retenues), netAPayer: r2(netAPayer),
  };
}

/* ---------------- PRESTATION (qté × PU / tonnage / forfait / HS) ---------------- */
function computePrestation(input, contract) {
  const R = mergeRates(contract);
  const comps = contract.components || [];
  // HT = Σ des composants "PRESTATION" + éventuel montant direct
  let HT = num(input.montantHT) + stageSum(comps, input, R, "PRESTATION");
  if (!comps.some(c => c.stage === "PRESTATION") && input.quantite != null)
    HT = num(input.quantite) * num(input.pu);          // tonnage / unité simple
  const margeCRH = R.margeCRH ? HT * R.margeCRH : 0;   // ADDAX 8,5 %
  const HTfinal = HT + margeCRH;
  const IR = R.ir ? HTfinal * R.ir : 0;
  const TVA = contract.tvaExonere ? 0 : HTfinal * R.tva;
  const TTC = HTfinal + TVA;
  return {
    poste: input.poste || "", name: input.name || "",
    raw: { HT: HTfinal, margeCRH, IR, TVA, TTC, netAPayer: TTC - IR },
    HT: r2(HTfinal), margeCRH: r2(margeCRH), IR: r2(IR), TVA: r2(TVA), TTC: r2(TTC), netAPayer: r2(TTC - IR),
  };
}

/* ---------------- RECAP (HT saisi par ligne) ---------------- */
function computeRecap(input, contract) {
  const R = mergeRates(contract);
  const HT = num(input.montantHT);
  const TVA = contract.tvaExonere ? 0 : HT * R.tva;
  return { poste: input.poste || "", name: input.name || "", raw: { HT, TVA, TTC: HT + TVA },
    HT: r2(HT), TVA: r2(TVA), TTC: r2(HT + TVA) };
}

/** Dispatch one line by the contract's billing type. */
function computeLine(input, contract) {
  switch ((contract.billingType || "MAD").toUpperCase()) {
    case "PRESTATION":
    case "TONNAGE":     return computePrestation(input, contract);
    case "RECAP":       return computeRecap(input, contract);
    case "PORTAGE":
    case "CONSULTANT":
    case "MAD":
    default:            return computeMAD(input, contract);
  }
}

/**
 * Compute a whole sheet: every line, grouped by poste (alphabetical), with
 * sub-totals per poste, a grand total, and the sheet HT/TVA/TTC (F8).
 */
function computeSheet(sheet, contract) {
  const lines = (sheet.lines || []).map(l => Object.assign({ id: l.id }, computeLine(l, contract)));
  lines.sort((a, b) => (a.poste || "").localeCompare(b.poste || "") || (a.name || "").localeCompare(b.name || ""));
  const groups = {};
  for (const l of lines) (groups[l.poste || "—"] = groups[l.poste || "—"] || []).push(l);
  const sum = (k) => lines.reduce((s, l) => s + (l[k] != null ? l[k] : (l.raw[k] || 0)), 0);
  const totals = { HT: r2(sum("HT")), TVA: r2(sum("TVA")), TTC: r2(sum("TTC")),
    brut: r2(sum("brut")), charges: r2(sum("charges")), fraisGestion: r2(sum("fraisGestion")),
    IR: r2(sum("IR")), netAPayer: r2(sum("netAPayer")), count: lines.length };
  return { lines, groups, totals };
}

module.exports = { computeLine, computeSheet, computeMAD, computePrestation, computeRecap, DEFAULT_RATES, mergeRates, r2 };
